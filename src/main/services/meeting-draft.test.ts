import { describe, it, expect } from 'vitest'
import { buildDraftRow } from './meeting-draft'

describe('buildDraftRow', () => {
  it('빈 제목·공백 제목은 기본 제목과 title_auto=1', () => {
    for (const title of ['', '   ', undefined]) {
      const row = buildDraftRow({ title })
      expect(row.title).toBe('제목 없는 회의')
      expect(row.title_auto).toBe(1)
    }
  })

  it('입력한 제목은 trim해서 쓰고 title_auto=0', () => {
    const row = buildDraftRow({ title: '  주간 회의 ' })
    expect(row.title).toBe('주간 회의')
    expect(row.title_auto).toBe(0)
  })

  it('참석 인원이 0·음수·NaN이면 null이고 미확인', () => {
    for (const n of [0, -1, NaN, Infinity]) {
      const row = buildDraftRow({ expected_speakers: n })
      expect(row.expected_speakers).toBeNull()
      expect(row.speakers_confirmed).toBe(0)
    }
  })

  it('참석 인원은 반올림하고 확인으로 본다', () => {
    const row = buildDraftRow({ expected_speakers: 3.6 })
    expect(row.expected_speakers).toBe(4)
    expect(row.speakers_confirmed).toBe(1)
  })

  it('참석 인원은 20을 넘지 않는다', () => {
    expect(buildDraftRow({ expected_speakers: 99 }).expected_speakers).toBe(20)
  })

  it('compact_audio는 false일 때만 0', () => {
    expect(buildDraftRow({ compact_audio: false }).compact_audio).toBe(0)
    expect(buildDraftRow({}).compact_audio).toBe(1)
    expect(buildDraftRow({ compact_audio: true }).compact_audio).toBe(1)
  })

  it("source는 'mic+system'만 유지하고 나머지는 'mic'", () => {
    expect(buildDraftRow({ source: 'mic+system' }).source).toBe('mic+system')
    expect(buildDraftRow({ source: 'x' }).source).toBe('mic')
  })

  it('kind·summary_template 입력은 무시한다', () => {
    const row = buildDraftRow({ kind: 'other', summary_template: 'standup' } as never)
    expect(row).not.toHaveProperty('kind')
    expect(row).not.toHaveProperty('summary_template')
    expect(row.expected_speakers).toBeNull()
  })

  it('입력이 undefined면 기본값', () => {
    expect(buildDraftRow(undefined)).toEqual({
      title: '제목 없는 회의',
      title_auto: 1,
      source: 'mic',
      expected_speakers: null,
      compact_audio: 1,
      speakers_confirmed: 0
    })
  })
})
