import { describe, it, expect } from 'vitest'
import { assignSpeaker, resolvePostprocessOptions, resolveSpeakerMeta, SPEAKER_COLORS } from './speaker-assign'

const t = (start_ms: number, end_ms: number, speaker_key: string) => ({ start_ms, end_ms, speaker_key })
const seg = (start_ms: number, end_ms: number) => ({ start_ms, end_ms })

describe('assignSpeaker', () => {
  it('turns가 비면 spk_0', () => {
    expect(assignSpeaker(seg(0, 1000), [])).toBe('spk_0')
  })

  it('겹침이 가장 큰 turn의 화자', () => {
    const turns = [t(0, 1000, 'spk_0'), t(1000, 5000, 'spk_1')]
    expect(assignSpeaker(seg(800, 3000), turns)).toBe('spk_1')
  })

  it('겹침이 같으면 먼저 나온 turn', () => {
    const turns = [t(0, 1000, 'spk_1'), t(1000, 2000, 'spk_0')]
    expect(assignSpeaker(seg(500, 1500), turns)).toBe('spk_1')
  })

  it('겹침 0이면 첫 화자가 아니라 시간상 가장 가까운 turn의 화자', () => {
    const turns = [t(0, 1000, 'spk_0'), t(10_000, 12_000, 'spk_1'), t(20_000, 21_000, 'spk_2')]
    expect(assignSpeaker(seg(12_500, 13_000), turns)).toBe('spk_1')
    expect(assignSpeaker(seg(18_000, 19_000), turns)).toBe('spk_2')
  })

  it('turns가 정렬돼 있지 않아도 정확하다', () => {
    const turns = [t(20_000, 21_000, 'spk_2'), t(0, 1000, 'spk_0'), t(10_000, 12_000, 'spk_1')]
    expect(assignSpeaker(seg(12_500, 13_000), turns)).toBe('spk_1')
    expect(assignSpeaker(seg(500, 15_000), turns)).toBe('spk_1')
  })

  it('간격이 같으면 먼저 나온 turn', () => {
    const turns = [t(3000, 4000, 'spk_1'), t(0, 1000, 'spk_0')]
    expect(assignSpeaker(seg(2000, 2000), turns)).toBe('spk_1')
  })

  it('작은 겹침이라도 겹치는 turn이 가까운 turn보다 우선', () => {
    const turns = [t(0, 1010, 'spk_0'), t(1020, 3000, 'spk_1')]
    // 1000~1015: spk_0과 10ms 겹침, spk_1과는 간격 5ms
    expect(assignSpeaker(seg(1000, 1015), turns)).toBe('spk_0')
  })
})

describe('resolvePostprocessOptions', () => {
  it('sherpa 자동 추정: sandwich 300, 흡수 유지', () => {
    const o = resolvePostprocessOptions({ adapter: 'sherpa', expectedSpeakers: null })
    expect(o.smooth).toEqual({ minTurnMs: 200, sandwichMs: 300, gapFillMs: 500 })
    expect(o.absorb).toEqual({ minRatio: 0.02, minDurationMs: 60_000 })
  })

  it('참석 인원 지정: 흡수 끔', () => {
    const o = resolvePostprocessOptions({ adapter: 'sherpa', expectedSpeakers: 5 })
    expect(o.absorb).toBe(false)
    expect(o.smooth).toEqual({ minTurnMs: 200, sandwichMs: 300, gapFillMs: 500 })
  })

  it('expectedSpeakers 0은 미지정과 같다', () => {
    expect(resolvePostprocessOptions({ adapter: 'sherpa', expectedSpeakers: 0 }).absorb).not.toBe(false)
  })

  it.each(['channel', 'two-stage'])('%s: 같은 화자 병합만, 흡수 끔', (adapter) => {
    const o = resolvePostprocessOptions({ adapter })
    expect(o.smooth).toEqual({ minTurnMs: 0, sandwichMs: 0, gapFillMs: 500 })
    expect(o.absorb).toBe(false)
  })
})

describe('resolveSpeakerMeta', () => {
  it('키별 기본 라벨/색상', () => {
    expect(resolveSpeakerMeta('mic', 3)).toEqual({ label: '나', color: SPEAKER_COLORS[0] })
    expect(resolveSpeakerMeta('system', 0)).toEqual({ label: '상대', color: SPEAKER_COLORS[1] })
    expect(resolveSpeakerMeta('sys_0', 5).label).toBe('상대 1')
    expect(resolveSpeakerMeta('spk_4', 2)).toEqual({ label: '화자 3', color: SPEAKER_COLORS[2] })
  })
})
