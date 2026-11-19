import { describe, it, expect } from 'vitest'
import {
  planSpeakerCarryover,
  matchCorrectedSpeakers,
  planSpeakerRows,
  isCustomLabel,
  mergeByTime,
  type OldSpeakerRow
} from './speaker-carryover'
import { SPEAKER_COLORS } from './speaker-assign'

const spk = (
  id: number,
  speaker_key: string,
  sort_order: number,
  extra: Partial<OldSpeakerRow> = {}
): OldSpeakerRow => ({
  id,
  speaker_key,
  sort_order,
  label: `화자 ${sort_order + 1}`,
  display_name: null,
  color: SPEAKER_COLORS[sort_order % SPEAKER_COLORS.length],
  ...extra
})
const oseg = (start_ms: number, end_ms: number, speaker_id: number | null, speaker_corrected = 0) => ({
  start_ms,
  end_ms,
  speaker_id,
  speaker_corrected
})
const nk = (start_ms: number, end_ms: number, speaker_key: string) => ({ start_ms, end_ms, speaker_key })

describe('planSpeakerCarryover', () => {
  const oldSpeakers = [
    spk(10, 'spk_0', 0, { display_name: '김철수', color: '#111111' }),
    spk(11, 'spk_1', 1, { display_name: '이영희', color: '#222222', label: '팀장' })
  ]

  it('빈 입력이면 빈 결과', () => {
    expect(planSpeakerCarryover([], [], []).size).toBe(0)
    expect(planSpeakerCarryover([oseg(0, 1000, 10)], oldSpeakers, []).size).toBe(0)
    expect(planSpeakerCarryover([], oldSpeakers, [nk(0, 1000, 'spk_0')]).size).toBe(0)
  })

  it('과반을 차지한 옛 화자의 실명·색상·사용자 라벨을 승계한다(키가 바뀌어도)', () => {
    const oldSegs = [oseg(0, 10_000, 10), oseg(10_000, 20_000, 11)]
    const next = [nk(0, 10_000, 'spk_1'), nk(10_000, 20_000, 'spk_0')]
    const carry = planSpeakerCarryover(oldSegs, oldSpeakers, next)
    expect(carry.get('spk_1')).toEqual({ oldSpeakerId: 10, display_name: '김철수', color: '#111111' })
    expect(carry.get('spk_0')).toEqual({
      oldSpeakerId: 11,
      display_name: '이영희',
      color: '#222222',
      label: '팀장'
    })
  })

  it('과반(>50%)이 아니면 승계하지 않는다', () => {
    // 새 spk_0 발화 10초 중 옛 10번과 5초(정확히 절반)만 겹침
    const oldSegs = [oseg(0, 5000, 10), oseg(5000, 10_000, 11), oseg(20_000, 30_000, 11)]
    const next = [nk(0, 10_000, 'spk_0'), nk(20_000, 30_000, 'spk_1')]
    const carry = planSpeakerCarryover(oldSegs, oldSpeakers, next)
    expect(carry.has('spk_0')).toBe(false)
    expect(carry.get('spk_1')?.oldSpeakerId).toBe(11)
  })

  it('한 옛 화자는 겹침이 가장 큰 새 화자 한 명에게만 승계한다', () => {
    // 옛 10번이 전부 말했는데 새 결과는 두 화자로 쪼갰다
    const oldSegs = [oseg(0, 30_000, 10)]
    const next = [nk(0, 10_000, 'spk_0'), nk(10_000, 30_000, 'spk_1')]
    const carry = planSpeakerCarryover(oldSegs, oldSpeakers, next)
    expect(carry.get('spk_1')?.oldSpeakerId).toBe(10)
    expect(carry.has('spk_0')).toBe(false)
  })

  it('겹침 없는 새 화자는 승계 없음(기본값)', () => {
    const oldSegs = [oseg(0, 10_000, 10)]
    const next = [nk(0, 10_000, 'spk_0'), nk(50_000, 60_000, 'spk_1')]
    const carry = planSpeakerCarryover(oldSegs, oldSpeakers, next)
    expect(carry.has('spk_1')).toBe(false)
  })

  it('화자 없는 옛 세그먼트(speaker_id null)는 무시한다', () => {
    const carry = planSpeakerCarryover([oseg(0, 10_000, null)], oldSpeakers, [nk(0, 10_000, 'spk_0')])
    expect(carry.size).toBe(0)
  })

  it('정렬되지 않고 서로 겹치는 옛 세그먼트도 정확히 합산한다', () => {
    const oldSegs = [oseg(5000, 9000, 11), oseg(0, 8000, 10), oseg(7000, 7500, 11)]
    // 새 spk_0 [0,8000]: 10번 8000, 11번 3000+500 → 10번
    const carry = planSpeakerCarryover(oldSegs, oldSpeakers, [nk(0, 8000, 'spk_0')])
    expect(carry.get('spk_0')?.oldSpeakerId).toBe(10)
  })

  it('기본 라벨은 승계하지 않는다', () => {
    const carry = planSpeakerCarryover([oseg(0, 1000, 10)], oldSpeakers, [nk(0, 1000, 'spk_3')])
    expect(carry.get('spk_3')).not.toHaveProperty('label')
  })
})

describe('isCustomLabel', () => {
  it('키·순서로 만든 기본 라벨과 비교한다', () => {
    expect(isCustomLabel(spk(1, 'spk_0', 0))).toBe(false)
    expect(isCustomLabel(spk(1, 'mic', 0, { label: '나' }))).toBe(false)
    expect(isCustomLabel(spk(1, 'spk_0', 0, { label: '면접관' }))).toBe(true)
  })
})

describe('matchCorrectedSpeakers', () => {
  it('시간이 같은 세그먼트의 수동 지정을 찾는다', () => {
    const old = [oseg(0, 1000, 10, 1), oseg(1000, 2000, 11, 0)]
    expect(matchCorrectedSpeakers(old, [{ start_ms: 0, end_ms: 1000 }, { start_ms: 1000, end_ms: 2000 }])).toEqual([
      { oldSpeakerId: 10 },
      null
    ])
  })

  it('정제로 병합돼 대응이 과반이 아니면 버린다', () => {
    const old = [oseg(0, 1000, 10, 1), oseg(1000, 2000, 11, 0), oseg(2000, 3000, 11, 0)]
    expect(matchCorrectedSpeakers(old, [{ start_ms: 0, end_ms: 3000 }])).toEqual([null])
  })

  it('수동으로 화자 없음(null) 지정한 것도 유지한다', () => {
    expect(matchCorrectedSpeakers([oseg(0, 1000, null, 1)], [{ start_ms: 0, end_ms: 1000 }])).toEqual([
      { oldSpeakerId: null }
    ])
  })

  it('대응 없으면 null, 빈 입력도 크래시하지 않는다', () => {
    expect(matchCorrectedSpeakers([oseg(0, 1000, 10, 1)], [{ start_ms: 5000, end_ms: 6000 }])).toEqual([null])
    expect(matchCorrectedSpeakers([], [{ start_ms: 0, end_ms: 1 }])).toEqual([null])
    expect(matchCorrectedSpeakers([oseg(0, 1000, 10, 1)], [])).toEqual([])
  })

  it('길이 0 세그먼트는 그 시각을 포함하는 옛 세그먼트로 대응', () => {
    expect(matchCorrectedSpeakers([oseg(0, 1000, 10, 1)], [{ start_ms: 500, end_ms: 500 }])).toEqual([
      { oldSpeakerId: 10 }
    ])
  })
})

describe('planSpeakerRows', () => {
  const oldSpeakers = [
    spk(10, 'spk_0', 0, { display_name: '김철수', color: '#111111' }),
    spk(11, 'spk_1', 1, { display_name: '이영희', color: '#222222' })
  ]

  it('승계 없으면 기본 라벨·색상, 자동 귀속', () => {
    const plan = planSpeakerRows({
      speakerKeyOrder: ['spk_0', 'spk_1'],
      segmentKeys: ['spk_1', 'spk_0'],
      carry: new Map()
    })
    expect(plan.speakers.map((s) => [s.speaker_key, s.label, s.display_name, s.sort_order])).toEqual([
      ['spk_0', '화자 1', null, 0],
      ['spk_1', '화자 2', null, 1]
    ])
    expect(plan.segments).toEqual([
      { speakerIndex: 1, speakerCorrected: false },
      { speakerIndex: 0, speakerCorrected: false }
    ])
  })

  it('수동 지정 세그먼트는 승계된 새 화자로 연결한다', () => {
    const carry = new Map([['spk_1', { oldSpeakerId: 10, display_name: '김철수', color: '#111111' }]])
    const plan = planSpeakerRows({
      speakerKeyOrder: ['spk_0', 'spk_1'],
      segmentKeys: ['spk_0', 'spk_0'],
      carry,
      corrections: [{ oldSpeakerId: 10 }, null],
      oldSpeakers
    })
    expect(plan.speakers[1]).toMatchObject({ speaker_key: 'spk_1', display_name: '김철수', color: '#111111' })
    expect(plan.segments).toEqual([
      { speakerIndex: 1, speakerCorrected: true },
      { speakerIndex: 0, speakerCorrected: false }
    ])
  })

  it('승계로 매핑되지 않은 옛 화자는 별도 행으로 다시 만든다(한 번만)', () => {
    const plan = planSpeakerRows({
      speakerKeyOrder: ['spk_0'],
      segmentKeys: ['spk_0', 'spk_0', 'spk_0'],
      carry: new Map(),
      corrections: [{ oldSpeakerId: 11 }, null, { oldSpeakerId: 11 }],
      oldSpeakers
    })
    expect(plan.speakers).toHaveLength(2)
    expect(plan.speakers[1]).toEqual({
      speaker_key: 'spk_1',
      label: '화자 2',
      display_name: '이영희',
      color: '#222222',
      sort_order: 1
    })
    expect(plan.segments.map((s) => s.speakerIndex)).toEqual([1, 0, 1])
    expect(plan.segments.map((s) => s.speakerCorrected)).toEqual([true, false, true])
  })

  it('수동 화자 없음은 null 유지, 사라진 옛 화자는 자동 귀속', () => {
    const plan = planSpeakerRows({
      speakerKeyOrder: ['spk_0'],
      segmentKeys: ['spk_0', 'spk_0'],
      carry: new Map(),
      corrections: [{ oldSpeakerId: null }, { oldSpeakerId: 999 }],
      oldSpeakers
    })
    expect(plan.segments).toEqual([
      { speakerIndex: null, speakerCorrected: true },
      { speakerIndex: 0, speakerCorrected: false }
    ])
  })

  it('빈 입력', () => {
    expect(planSpeakerRows({ speakerKeyOrder: [], segmentKeys: [], carry: new Map() })).toEqual({
      speakers: [],
      segments: []
    })
  })
})

describe('mergeByTime', () => {
  it('시작·끝 시각 순으로 합치고 같으면 앞 목록 우선', () => {
    const a = [{ start_ms: 0, end_ms: 10, id: 'a0' }, { start_ms: 20, end_ms: 30, id: 'a1' }]
    const b = [{ start_ms: 10, end_ms: 20, id: 'b0' }, { start_ms: 20, end_ms: 30, id: 'b1' }]
    expect(mergeByTime(a, b).map((s) => s.id)).toEqual(['a0', 'b0', 'a1', 'b1'])
  })
})
