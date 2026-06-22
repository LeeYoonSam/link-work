import { describe, it, expect } from 'vitest'
import { cleanSegments } from './transcript-cleaner'
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
})
