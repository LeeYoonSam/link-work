import { describe, expect, it } from 'vitest'
import { computeTalkShare, formatTalkMs } from './talkShare'

// main services/meeting-notes.test.ts computeTalkShare 와 같은 표
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

describe('formatTalkMs', () => {
  it('1시간 미만은 mm:ss, 이상은 h:mm:ss', () => {
    expect(formatTalkMs(0)).toBe('00:00')
    expect(formatTalkMs(65_999)).toBe('01:05')
    expect(formatTalkMs(3_599_000)).toBe('59:59')
    expect(formatTalkMs(3_600_000)).toBe('1:00:00')
    expect(formatTalkMs(3_725_000)).toBe('1:02:05')
    expect(formatTalkMs(-5)).toBe('00:00')
  })
})
