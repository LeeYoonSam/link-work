import { describe, expect, it } from 'vitest'
import {
  buildMeetingNoteMarkdown,
  computeTalkShare,
  countActionItems,
  escapeLike,
  formatClock,
  parseKeywords,
  parseTextItems,
  parseTopics,
  remapSummaryTimes,
  type NoteDetail,
  type NoteSummary
} from './meeting-notes'

const emptySummary: NoteSummary = {
  tldr: null,
  keywords: [],
  topics: [],
  key_points: [],
  decisions: [],
  action_items: [],
  open_questions: [],
  next_steps: []
}

const base: Omit<NoteDetail, 'meeting' | 'summary'> = {
  speakers: [
    { id: 1, label: 'SPEAKER_00', display_name: '김철수' },
    { id: 2, label: 'SPEAKER_01', display_name: null }
  ],
  segments: [
    { start_ms: 5000, end_ms: 8000, speaker_id: 1, text: '시작합니다' },
    { start_ms: 65000, end_ms: 68000, speaker_id: 2, text: '네 좋습니다' }
  ],
  attendees: [{ name: '김철수' }, { name: '이영희' }]
}

describe('buildMeetingNoteMarkdown — 회의', () => {
  const md = buildMeetingNoteMarkdown({
    ...base,
    meeting: { title: '주간 회의', started_at: '2026-10-01 10:00:00', duration_ms: 1800000 },
    summary: {
      ...emptySummary,
      tldr: '배포 일정 확정',
      key_points: ['QA 완료'],
      decisions: [{ text: '금요일 배포', at_ms: null }],
      action_items: [
        { text: '릴리즈 노트 작성', assignee: '김철수', due: '2026-10-03' },
        { text: '공지', todo_id: 7 }
      ]
    }
  })

  it('제목·메타·섹션을 만든다', () => {
    expect(md.startsWith('# 주간 회의\n')).toBe(true)
    expect(md).toContain('참석자: 김철수, 이영희')
    expect(md).not.toContain('프로젝트:')
    expect(md).toContain('길이: 30분')
    for (const h of ['## TL;DR', '## 핵심 포인트', '## 결정사항', '## 액션아이템', '## 전사']) {
      expect(md).toContain(h)
    }
  })

  it('액션아이템 체크박스는 todo_id 유무로 갈린다', () => {
    expect(md).toContain('- [ ] 릴리즈 노트 작성 (담당: 김철수, 기한: 2026-10-03)')
    expect(md).toContain('- [x] 공지')
  })

  it('빈 섹션은 생략하고 종류 메타는 쓰지 않는다', () => {
    expect(md).not.toContain('## 다음 단계')
    expect(md).not.toContain('종류:')
  })

  it('전사는 시간과 화자명을 붙인다', () => {
    expect(md).toContain('[00:05] **김철수**: 시작합니다')
    expect(md).toContain('[01:05] **SPEAKER_01**: 네 좋습니다')
  })
})

describe('헬퍼', () => {
  it('요약이 없으면 전사만 남는다', () => {
    const md = buildMeetingNoteMarkdown({
      ...base,
      segments: [],
      attendees: [],
      meeting: { title: 'x', started_at: 't', duration_ms: 0 },
      summary: null
    })
    expect(md).not.toContain('##')
    expect(md).not.toContain('참석자')
  })

  it('countActionItems', () => {
    expect(countActionItems(JSON.stringify([{ text: 'a' }, { text: 'b', todo_id: 3 }]))).toEqual({ total: 2, open: 1 })
    expect(countActionItems(null)).toEqual({ total: 0, open: 0 })
    expect(countActionItems('not json')).toEqual({ total: 0, open: 0 })
  })

  it('escapeLike', () => {
    expect(escapeLike('100%_a\\b')).toBe('100\\%\\_a\\\\b')
  })

  it('formatClock', () => {
    expect(formatClock(3725000)).toBe('1:02:05')
  })
})

describe('buildMeetingNoteMarkdown — 새 요약 포맷', () => {
  const md = buildMeetingNoteMarkdown({
    ...base,
    meeting: { title: '스프린트 회의', started_at: '2026-11-20 10:00:00', duration_ms: 1500000 },
    summary: {
      ...emptySummary,
      tldr: '결제 개편 범위를 확정했다.',
      keywords: ['결제', '환불 정책', 'QA'],
      topics: [
        { title: '결제 개편 범위', start_ms: 12000, points: ['카드 결제만 먼저 바꾼다', '간편 결제는 다음 분기'] },
        { title: '환불 정책', start_ms: 754000, points: [] }
      ],
      decisions: [
        { text: '카드 결제부터 개편', at_ms: 95000 },
        { text: '시각 없는 결정', at_ms: null }
      ],
      action_items: [{ text: '견적 요청', assignee: '이영희', due: null, at_ms: 3723000 }, { text: '일정 공유' }],
      open_questions: [{ text: '부분 환불 수수료는 누가 내나', at_ms: 800000 }]
    }
  })

  it('섹션 순서는 키워드 → TL;DR → 결정사항 → 액션아이템 → 미결 질문 → 주제별 요약 → 전사', () => {
    const order = ['## 키워드', '## TL;DR', '## 결정사항', '## 액션아이템', '## 미결 질문', '## 주제별 요약', '## 전사']
    const idx = order.map((h) => md.indexOf(h))
    expect(idx.every((i) => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)
    expect(md).not.toContain('## 핵심 포인트')
    expect(md).not.toContain('## 다음 단계')
  })

  it('키워드는 한 줄로, 시각은 [mm:ss]로 붙이고 없으면 생략한다', () => {
    expect(md).toContain('## 키워드\n\n결제 · 환불 정책 · QA\n')
    expect(md).toContain('- 카드 결제부터 개편 [01:35]')
    expect(md).toContain('- 시각 없는 결정\n')
    expect(md).toContain('- [ ] 견적 요청 (담당: 이영희) [1:02:03]')
    expect(md).toContain('- [ ] 일정 공유\n')
    expect(md).toContain('- 부분 환불 수수료는 누가 내나 [13:20]')
  })

  it('주제별 요약은 번호·제목·시각 제목 아래에 포인트 불릿을 둔다', () => {
    expect(md).toContain(
      '## 주제별 요약\n\n### 1. 결제 개편 범위 [00:12]\n\n- 카드 결제만 먼저 바꾼다\n- 간편 결제는 다음 분기\n\n### 2. 환불 정책 [12:34]\n\n## 발화 점유율\n\n- 김철수: 00:03 (50%) · 발언 1회\n- SPEAKER_01: 00:03 (50%) · 발언 1회\n\n## 전사'
    )
  })
})

describe('buildMeetingNoteMarkdown — 구버전 요약', () => {
  // 새 포맷 도입 전 코드로 만든 출력. 구버전 요약(문자열 decisions, 새 필드 없음)은 바이트 단위로 같아야 한다.
  const LEGACY_MD =
    '# 주간 회의\n\n일시: 2026-10-01 10:00:00 · 길이: 30분 · 참석자: 김철수\n\n## TL;DR\n\n배포 일정 확정\n\n## 핵심 포인트\n\n- QA 완료\n\n## 결정사항\n\n- 금요일 배포\n\n## 액션아이템\n\n- [ ] 릴리즈 노트 작성 (담당: 김철수, 기한: 2026-10-03)\n- [x] 공지\n\n## 다음 단계\n\n- 모니터링\n\n## 전사\n\n[00:05] **김철수**: 시작합니다\n\n[01:05] 네\n'

  it('저장된 구버전 JSON을 정규화해 만든 Markdown이 이전 출력과 같다', () => {
    const md = buildMeetingNoteMarkdown({
      meeting: { title: '주간 회의', started_at: '2026-10-01 10:00:00', duration_ms: 1800000 },
      speakers: [{ id: 1, label: 'SPEAKER_00', display_name: '김철수' }],
      segments: [
        { start_ms: 5000, end_ms: 8000, speaker_id: 1, text: '시작합니다' },
        { start_ms: 65000, end_ms: 68000, speaker_id: null, text: '네' }
      ],
      attendees: [{ name: '김철수' }],
      summary: {
        ...emptySummary,
        tldr: ' 배포 일정 확정 ',
        keywords: parseKeywords(null),
        topics: parseTopics(null),
        key_points: ['QA 완료', ' '],
        decisions: parseTextItems(JSON.stringify(['금요일 배포', ''])),
        action_items: [
          { text: '릴리즈 노트 작성', assignee: '김철수', due: '2026-10-03' },
          { text: '공지', todo_id: 7 }
        ],
        open_questions: parseTextItems(null),
        next_steps: ['모니터링']
      }
    })
    expect(md).toBe(LEGACY_MD)
  })
})

describe('요약 읽기 정규화', () => {
  it('parseTextItems: 문자열과 {text, at_ms} 혼재를 한 형태로 맞춘다', () => {
    const raw = JSON.stringify(['  구버전 결정 ', { text: '새 결정', at_ms: 754000 }, { text: '시각 없음' }, '', { at_ms: 1 }, 3])
    expect(parseTextItems(raw)).toEqual([
      { text: '구버전 결정', at_ms: null },
      { text: '새 결정', at_ms: 754000 },
      { text: '시각 없음', at_ms: null }
    ])
    expect(parseTextItems(null)).toEqual([])
    expect(parseTextItems('not json')).toEqual([])
    expect(parseTextItems('{"text":"배열 아님"}')).toEqual([])
  })

  it('parseTopics: 제목 없는 항목은 버리고 points 는 문자열만 남긴다', () => {
    const raw = JSON.stringify([
      { title: '주제', start_ms: 1000, points: ['a', '', 2, ' b '] },
      { title: '', start_ms: 2000, points: [] },
      { title: '시각 없음' }
    ])
    expect(parseTopics(raw)).toEqual([
      { title: '주제', start_ms: 1000, points: ['a', 'b'] },
      { title: '시각 없음', start_ms: null, points: [] }
    ])
    expect(parseTopics(null)).toEqual([])
  })

  it('parseKeywords: 문자열만 trim 해 남긴다', () => {
    expect(parseKeywords(JSON.stringify([' 결제 ', '', 1, 'QA']))).toEqual(['결제', 'QA'])
    expect(parseKeywords(undefined)).toEqual([])
  })
})

describe('remapSummaryTimes', () => {
  it('시각 필드만 옮기고 todo_id·문자열 항목·null 시각은 그대로 둔다', () => {
    const out = remapSummaryTimes(
      {
        topics: JSON.stringify([{ title: 'T', start_ms: 10000, points: ['p'] }, { title: 'U', start_ms: null, points: [] }]),
        decisions: JSON.stringify(['구버전 결정', { text: 'D', at_ms: 20000 }]),
        action_items: JSON.stringify([{ text: 'A', assignee: null, due: null, at_ms: 30000, todo_id: 5 }, { text: 'B' }]),
        open_questions: null
      },
      (ms) => ms - 1000
    )
    expect(JSON.parse(out.topics)).toEqual([
      { title: 'T', start_ms: 9000, points: ['p'] },
      { title: 'U', start_ms: null, points: [] }
    ])
    expect(JSON.parse(out.decisions)).toEqual(['구버전 결정', { text: 'D', at_ms: 19000 }])
    expect(JSON.parse(out.action_items)).toEqual([
      { text: 'A', assignee: null, due: null, at_ms: 29000, todo_id: 5 },
      { text: 'B' }
    ])
    expect(out.open_questions).toBe('[]')
  })

  it('읽을 수 없는 JSON 은 손대지 않는다', () => {
    const out = remapSummaryTimes({ topics: 'broken', decisions: '{}', action_items: '[]', open_questions: '[]' }, (ms) => ms)
    expect(out.topics).toBe('broken')
    expect(out.decisions).toBe('{}')
  })
})

describe('computeTalkShare', () => {
  const speakers = [
    { id: 1, label: 'SPEAKER_00', display_name: ' 김철수 ' },
    { id: 2, label: 'SPEAKER_01', display_name: null },
    { id: 3, label: 'SPEAKER_02', display_name: '  ' }
  ]

  it('빈 입력이면 rows [] · totalMs 0', () => {
    expect(computeTalkShare([], speakers)).toEqual({ rows: [], totalMs: 0 })
    expect(computeTalkShare([{ start_ms: 1000, end_ms: 1000, speaker_id: 1 }], speakers)).toEqual({
      rows: [],
      totalMs: 0
    })
  })

  it('1:1:1이면 최대 나머지로 34/33/33, 같은 ms는 speakers 순', () => {
    const r = computeTalkShare(
      [
        { start_ms: 0, end_ms: 1000, speaker_id: 3 },
        { start_ms: 1000, end_ms: 2000, speaker_id: 2 },
        { start_ms: 2000, end_ms: 3000, speaker_id: 1 }
      ],
      speakers
    )
    expect(r.totalMs).toBe(3000)
    expect(r.rows.map((x) => [x.speaker_id, x.pct])).toEqual([
      [1, 34],
      [2, 33],
      [3, 33]
    ])
    expect(r.rows.reduce((a, x) => a + x.pct, 0)).toBe(100)
  })

  it('이름: display_name trim → label → 목록에 없는 id는 화자{id}, null은 미지정이며 맨 뒤', () => {
    const r = computeTalkShare(
      [
        { start_ms: 0, end_ms: 5000, speaker_id: null },
        { start_ms: 5000, end_ms: 6000, speaker_id: 1 },
        { start_ms: 6000, end_ms: 8000, speaker_id: 3 },
        { start_ms: 8000, end_ms: 11000, speaker_id: 9 }
      ],
      speakers
    )
    expect(r.rows.map((x) => [x.speaker_id, x.name, x.ms])).toEqual([
      [9, '화자9', 3000],
      [3, 'SPEAKER_02', 2000],
      [1, '김철수', 1000],
      [null, '미지정', 5000]
    ])
    expect(r.rows.reduce((a, x) => a + x.pct, 0)).toBe(100)
  })

  it('turns: 연속 같은 화자는 1회, 시작 시각 순으로 센다(입력 순서와 무관), dur 0 무시', () => {
    const r = computeTalkShare(
      [
        { start_ms: 4000, end_ms: 5000, speaker_id: 1 },
        { start_ms: 0, end_ms: 1000, speaker_id: 1 },
        { start_ms: 1000, end_ms: 2000, speaker_id: 1 },
        { start_ms: 2500, end_ms: 2500, speaker_id: 2 },
        { start_ms: 3000, end_ms: 3500, speaker_id: 2 },
        { start_ms: 3500, end_ms: 3000, speaker_id: 2 }
      ],
      speakers
    )
    expect(r.rows).toEqual([
      { speaker_id: 1, name: '김철수', ms: 3000, pct: 86, turns: 2 },
      { speaker_id: 2, name: 'SPEAKER_01', ms: 500, pct: 14, turns: 1 }
    ])
  })
})

describe('buildMeetingNoteMarkdown — 내 메모·발화 점유율', () => {
  const meeting = { title: '회의', started_at: '2026-10-01 10:00:00', duration_ms: 600000 }
  const speakers = [
    { id: 1, label: 'SPEAKER_00', display_name: '김철수' },
    { id: 2, label: 'SPEAKER_01', display_name: null }
  ]
  const twoSpeakers = [
    { start_ms: 0, end_ms: 3000, speaker_id: 1, text: '하나' },
    { start_ms: 3000, end_ms: 4000, speaker_id: 2, text: '둘' }
  ]

  it('메모는 at_ms 순, 빈 text는 (북마크), 요약 섹션 뒤·발화 점유율 앞·전사 앞', () => {
    const md = buildMeetingNoteMarkdown({
      meeting,
      speakers,
      segments: twoSpeakers,
      attendees: [],
      summary: { ...emptySummary, tldr: '결론' },
      marks: [
        { at_ms: 65000, text: ' 나중 메모 ' },
        { at_ms: 5000, text: '' }
      ]
    })
    expect(md).toContain('## 내 메모\n\n- [00:05] (북마크)\n- [01:05] 나중 메모\n')
    const tldr = md.indexOf('## TL;DR')
    const memo = md.indexOf('## 내 메모')
    const share = md.indexOf('## 발화 점유율')
    const transcript = md.indexOf('## 전사')
    expect(tldr).toBeLessThan(memo)
    expect(memo).toBeLessThan(share)
    expect(share).toBeLessThan(transcript)
    expect(md).toContain('## 발화 점유율\n\n- 김철수: 00:03 (75%) · 발언 1회\n- SPEAKER_01: 00:01 (25%) · 발언 1회\n\n## 전사')
  })

  it('요약이 없어도 메모를 넣는다', () => {
    const md = buildMeetingNoteMarkdown({
      meeting,
      speakers,
      segments: [],
      attendees: [],
      summary: null,
      marks: [{ at_ms: 0, text: '메모' }]
    })
    expect(md).toContain('## 내 메모\n\n- [00:00] 메모')
  })

  it('메모가 없으면 섹션도 없다', () => {
    const md = buildMeetingNoteMarkdown({ meeting, speakers, segments: twoSpeakers, attendees: [], summary: null })
    expect(md).not.toContain('## 내 메모')
  })

  it('화자가 1명이면 발화 점유율이 없다(미지정은 세지 않는다)', () => {
    const md = buildMeetingNoteMarkdown({
      meeting,
      speakers,
      segments: [
        { start_ms: 0, end_ms: 3000, speaker_id: 1, text: '하나' },
        { start_ms: 3000, end_ms: 4000, speaker_id: null, text: '둘' }
      ],
      attendees: [],
      summary: null
    })
    expect(md).not.toContain('## 발화 점유율')
  })

  it('미지정 줄도 같은 형식으로 맨 뒤에 넣는다', () => {
    const md = buildMeetingNoteMarkdown({
      meeting,
      speakers,
      segments: [...twoSpeakers, { start_ms: 4000, end_ms: 8000, speaker_id: null, text: '셋' }],
      attendees: [],
      summary: null
    })
    expect(md).toContain('- SPEAKER_01: 00:01 (12%) · 발언 1회\n- 미지정: 00:04 (50%) · 발언 1회')
  })
})
