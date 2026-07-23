import { describe, it, expect } from 'vitest'
import { cleanSegments, collapseNgramLoop, hasRecentDuplicate } from './transcript-cleaner'
import type { SttSegment } from './meeting-types'

describe('cleanSegments', () => {
  it('연속 반복 환각(meeting 6 패턴)을 1개 segment로 병합한다', () => {
    // 실제 증상: "아, 저거는 아직도 안 했을 때."가 10초 간격으로 148회 반복.
    const HALLUC = '아, 저거는 아직도 안 했을 때.'
    const segments: SttSegment[] = []
    // 정상 도입부
    segments.push({ start_ms: 0, end_ms: 5000, text: '체험관 신청 페이지에서 문구 변경이 필요할 것 같아요.' })
    // 148회 연속 반복
    for (let i = 0; i < 148; i++) {
      const start = 56000 + i * 10000
      segments.push({ start_ms: start, end_ms: start + 8000, text: HALLUC })
    }

    const cleaned = cleanSegments(segments)

    // 반복은 1개로 병합되어야 한다 → 총 2개(도입부 + 병합된 환각)
    const hallucCount = cleaned.filter((s) => s.text === HALLUC).length
    expect(hallucCount).toBe(1)
    expect(cleaned.length).toBe(2)
    // 병합된 segment의 end_ms는 마지막 반복의 end로 확장된다
    const merged = cleaned.find((s) => s.text === HALLUC)!
    expect(merged.end_ms).toBe(56000 + 147 * 10000 + 8000)
  })

  it('사이에 낀 1글자 노이즈("네.")가 병합 연속성을 깨지 않는다', () => {
    const A = '아, 저거는 아직도 안 했을 때.'
    const segments: SttSegment[] = [
      { start_ms: 0, end_ms: 2000, text: A },
      { start_ms: 2000, end_ms: 3000, text: '네.' }, // 1글자 → 제거됨
      { start_ms: 3000, end_ms: 5000, text: A }
    ]
    const cleaned = cleanSegments(segments)
    // 노이즈 제거 후 두 A가 인접 → 1개로 병합
    expect(cleaned.length).toBe(1)
    expect(cleaned[0].text).toBe(A)
  })

  it('서로 다른 발언은 보존한다', () => {
    const segments: SttSegment[] = [
      { start_ms: 0, end_ms: 2000, text: '첫 번째 발언입니다.' },
      { start_ms: 2000, end_ms: 4000, text: '두 번째 발언입니다.' },
      { start_ms: 4000, end_ms: 6000, text: '세 번째 발언입니다.' }
    ]
    const cleaned = cleanSegments(segments)
    expect(cleaned.length).toBe(3)
  })

  it('filler-only segment를 제거한다', () => {
    const segments: SttSegment[] = [
      { start_ms: 0, end_ms: 1000, text: '음' },
      { start_ms: 1000, end_ms: 2000, text: '아아' },
      { start_ms: 2000, end_ms: 4000, text: '실제 내용입니다.' }
    ]
    const cleaned = cleanSegments(segments)
    expect(cleaned.length).toBe(1)
    expect(cleaned[0].text).toBe('실제 내용입니다.')
  })

  it('사이에 다른 발언이 낀 채 재등장한 반복(건너뛴 반복)을 제거한다', () => {
    const A = '체험관 신청 페이지 문구를 이렇게 바꾸면 좋겠습니다.'
    const segments: SttSegment[] = [
      { start_ms: 0, end_ms: 3000, text: A },
      { start_ms: 5000, end_ms: 8000, text: '그 부분은 디자인팀과 논의가 필요합니다.' },
      // 인접이 아니지만 30초·윈도 내에 다시 등장 → 근접 dedup으로 제거
      { start_ms: 12000, end_ms: 15000, text: A }
    ]
    const cleaned = cleanSegments(segments)
    expect(cleaned.length).toBe(2)
    expect(cleaned.filter((s) => s.text === A).length).toBe(1)
  })

  it('짧은 맞장구("그렇죠")는 윈도 내 반복돼도 보존한다', () => {
    const segments: SttSegment[] = [
      { start_ms: 0, end_ms: 1000, text: '그렇죠.' },
      { start_ms: 2000, end_ms: 4000, text: '이 기능은 다음 스프린트에 넣죠.' },
      { start_ms: 5000, end_ms: 6000, text: '그렇죠.' }
    ]
    const cleaned = cleanSegments(segments)
    // 정규화 후 4자 이하 맞장구는 dedup 대상 제외 → 둘 다 보존
    expect(cleaned.length).toBe(3)
    expect(cleaned.filter((s) => s.text === '그렇죠.').length).toBe(2)
  })

  it('30초 밖에서 재등장한 동일 문장은 보존한다', () => {
    const A = '체험관 신청 페이지 문구를 이렇게 바꾸면 좋겠습니다.'
    const segments: SttSegment[] = [
      { start_ms: 0, end_ms: 3000, text: A },
      { start_ms: 10000, end_ms: 13000, text: '별개의 발언입니다.' },
      // 첫 A로부터 50초 뒤(>30초) → 근접 dedup 대상 아님
      { start_ms: 50000, end_ms: 53000, text: A }
    ]
    const cleaned = cleanSegments(segments)
    expect(cleaned.length).toBe(3)
    expect(cleaned.filter((s) => s.text === A).length).toBe(2)
  })

  it('세그먼트 내부 4-gram 루프를 1회로 붕괴한다', () => {
    const phrase = '오늘 안건 정리 하겠습니다'
    const segments: SttSegment[] = [
      { start_ms: 0, end_ms: 5000, text: `${phrase} ${phrase} ${phrase}` }
    ]
    const cleaned = cleanSegments(segments)
    expect(cleaned.length).toBe(1)
    expect(cleaned[0].text).toBe(phrase)
  })

  it('정상 문장은 무변형으로 통과시킨다', () => {
    const S = '이번 분기 목표는 신규 고객 확보와 리텐션 개선입니다.'
    const segments: SttSegment[] = [{ start_ms: 0, end_ms: 5000, text: S }]
    const cleaned = cleanSegments(segments)
    expect(cleaned.length).toBe(1)
    expect(cleaned[0].text).toBe(S)
  })
})

describe('collapseNgramLoop', () => {
  it('4어절 구절이 3회 반복되면 1회로 붕괴한다', () => {
    const phrase = '오늘 안건 정리 하겠습니다'
    expect(collapseNgramLoop(`${phrase} ${phrase} ${phrase}`)).toBe(phrase)
  })

  it('주기가 4어절이 아닌(6어절) 문장 반복도 붕괴한다', () => {
    const phrase = '아 저거는 아직도 안 했을 때야'
    expect(collapseNgramLoop(`${phrase} ${phrase} ${phrase}`)).toBe(phrase)
  })

  it('앞뒤 정상 발화는 보존하고 가운데 루프만 붕괴한다', () => {
    const phrase = '동일 구절 계속 반복'
    expect(collapseNgramLoop(`서두 발언 여기서 시작 ${phrase} ${phrase} ${phrase} 마무리`)).toBe(
      `서두 발언 여기서 시작 ${phrase} 마무리`
    )
  })

  it('2회 반복은 보수적으로 보존한다', () => {
    const phrase = '오늘 안건 정리 하겠습니다'
    expect(collapseNgramLoop(`${phrase} ${phrase}`)).toBe(`${phrase} ${phrase}`)
  })

  it('정상 문장은 무변형으로 반환한다', () => {
    const S = '이번 분기 목표는 신규 고객 확보와 리텐션 개선입니다.'
    expect(collapseNgramLoop(S)).toBe(S)
  })
})

describe('hasRecentDuplicate', () => {
  const recent: SttSegment[] = [
    { start_ms: 0, end_ms: 3000, text: '체험관 신청 페이지 문구를 바꿔주세요.' },
    { start_ms: 5000, end_ms: 8000, text: '별개의 발언입니다.' }
  ]

  it('윈도·시간창 이내의 동일 텍스트를 탐지한다', () => {
    expect(hasRecentDuplicate('체험관 신청 페이지 문구를 바꿔주세요.', 12000, recent)).toBe(true)
  })

  it('시간창(30초) 밖은 탐지하지 않는다', () => {
    expect(hasRecentDuplicate('체험관 신청 페이지 문구를 바꿔주세요.', 40000, recent)).toBe(false)
  })

  it('짧은 맞장구는 탐지하지 않는다(보존)', () => {
    const r: SttSegment[] = [{ start_ms: 0, end_ms: 1000, text: '그렇죠.' }]
    expect(hasRecentDuplicate('그렇죠.', 2000, r)).toBe(false)
  })
})
