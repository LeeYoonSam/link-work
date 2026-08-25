import { describe, it, expect } from 'vitest'
import type { RecordingStreamEvent } from '../types'
import {
  PHASE_WEIGHTS,
  overallProgress,
  mergeProcessingEvent,
  formatClock,
  type ProcessingState
} from './processing-progress'

const ev = (e: Partial<RecordingStreamEvent> & { phase: string }): RecordingStreamEvent =>
  ({ meetingId: 1, ...e }) as RecordingStreamEvent

describe('PHASE_WEIGHTS', () => {
  it('가중치 합이 1이다 — 합이 어긋나면 전체 진행률이 100%에 못 미치거나 넘는다', () => {
    const sum = Object.values(PHASE_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 10)
  })
})

describe('overallProgress', () => {
  it('앞 단계 가중치를 누적해 전체 진행률을 낸다', () => {
    // 첫 단계는 오프셋 0에서 시작
    expect(overallProgress('compact', 0.5)).toBeCloseTo(0.02, 5)
    // 이전 단계(compact 0.04)를 다 채운 지점에서 시작
    expect(overallProgress('transcribe', 0)).toBeCloseTo(0.04, 5)
    // compact .04 + transcribe .60 + vad .01 = .65, + diarize .28 = .93
    expect(overallProgress('diarize', 1)).toBeCloseTo(0.93, 5)
    // 요약은 0.95에서 이어붙는다
    expect(overallProgress('summarize', 0)).toBeCloseTo(0.95, 5)
    expect(overallProgress('summarize', 1)).toBeCloseTo(1, 5)
  })

  it('done은 1이다', () => {
    expect(overallProgress('done', undefined)).toBe(1)
  })

  it('알 수 없는 phase는 0이다', () => {
    expect(overallProgress('cancelled', 0.5)).toBe(0)
    expect(overallProgress('error', undefined)).toBe(0)
    expect(overallProgress('', 1)).toBe(0)
  })

  it('진행률이 없거나 범위를 벗어나도 단계 구간을 넘지 않는다', () => {
    expect(overallProgress('transcribe', undefined)).toBeCloseTo(0.04, 5)
    expect(overallProgress('transcribe', 5)).toBeCloseTo(0.64, 5)
    expect(overallProgress('transcribe', -1)).toBeCloseTo(0.04, 5)
    expect(overallProgress('transcribe', NaN)).toBeCloseTo(0.04, 5)
  })
})

describe('mergeProcessingEvent', () => {
  const first = mergeProcessingEvent(
    undefined,
    ev({ phase: 'compact', progress: 0.4, message: '무음 구간 정리 중…' }),
    1_000
  )

  it('첫 이벤트는 startedAt·phaseStartedAt을 함께 세운다', () => {
    expect(first.startedAt).toBe(1_000)
    expect(first.phaseStartedAt).toBe(1_000)
    expect(first.progress).toBe(0.4)
    expect(first.overall).toBeCloseTo(0.016, 5)
  })

  it('같은 phase의 메시지 전용 이벤트가 진행률을 되돌리지 않는다', () => {
    // 이것이 "무음 정리 0%"로 멈춘 것처럼 보이던 버그다
    const next = mergeProcessingEvent(first, ev({ phase: 'compact', message: '발화 구간 검출 중…' }), 5_000)
    expect(next.progress).toBe(0.4)
    expect(next.overall).toBeCloseTo(0.016, 5)
    expect(next.message).toBe('발화 구간 검출 중…')
    // 같은 phase이므로 단계 시작 시각도 그대로다
    expect(next.phaseStartedAt).toBe(1_000)
    expect(next.startedAt).toBe(1_000)
  })

  it('같은 phase에서 메시지가 없으면 직전 메시지를 유지한다', () => {
    const next = mergeProcessingEvent(first, ev({ phase: 'compact', progress: 0.6 }), 5_000)
    expect(next.message).toBe('무음 구간 정리 중…')
    expect(next.progress).toBe(0.6)
  })

  it('phase가 바뀌면 진행률과 메시지를 새로 시작하고 phaseStartedAt만 갱신한다', () => {
    const next = mergeProcessingEvent(first, ev({ phase: 'transcribe' }), 9_000)
    expect(next.phase).toBe('transcribe')
    // 직전 단계의 0.4를 물려받지 않는다
    expect(next.progress).toBe(0)
    // 직전 단계의 메시지도 들고 가지 않는다
    expect(next.message).toBeUndefined()
    expect(next.overall).toBeCloseTo(0.04, 5)
    // 전체 시작 시각은 유지, 단계 시작 시각만 갱신
    expect(next.startedAt).toBe(1_000)
    expect(next.phaseStartedAt).toBe(9_000)
  })

  it('단계가 이어져도 startedAt은 처음 값을 지킨다', () => {
    let s: ProcessingState | undefined
    s = mergeProcessingEvent(s, ev({ phase: 'compact', progress: 1 }), 1_000)
    s = mergeProcessingEvent(s, ev({ phase: 'transcribe', progress: 0.5 }), 20_000)
    s = mergeProcessingEvent(s, ev({ phase: 'diarize', progress: 1 }), 90_000)
    expect(s.startedAt).toBe(1_000)
    expect(s.phaseStartedAt).toBe(90_000)
    expect(s.overall).toBeCloseTo(0.93, 5)
  })
})

describe('formatClock', () => {
  it('분:초로 적고 시간 단위는 넘어갈 때만 붙인다', () => {
    expect(formatClock(133_000)).toBe('2:13')
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(9_000)).toBe('0:09')
    expect(formatClock(3_723_000)).toBe('1:02:03')
  })

  it('음수는 0으로 본다', () => {
    // 시스템 시계가 뒤로 움직여도 "-1:-3 경과" 같은 문구가 나오지 않게 한다
    expect(formatClock(-5_000)).toBe('0:00')
  })
})
