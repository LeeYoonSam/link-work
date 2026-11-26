import { describe, it, expect } from 'vitest'
import { speakerCountPrompt } from './speakerCountPrompt'

const base = {
  status: 'summarized' as const,
  expected_speakers: null,
  speakers_confirmed: 0
}
const speakers = [{ id: 1 }, { id: 2 }, { id: 3 }]
const segments = [{ speaker_id: 1 }, { speaker_id: 2 }, { speaker_id: 1 }, { speaker_id: null }]

describe('speakerCountPrompt', () => {
  it('이미 확인했으면(speakers_confirmed=1) 묻지 않는다', () => {
    expect(speakerCountPrompt({ ...base, speakers_confirmed: 1 }, speakers, segments)).toBeNull()
  })

  it('speakers_confirmed 값이 없으면 묻지 않는다', () => {
    const { speakers_confirmed: _omit, ...rest } = base
    expect(speakerCountPrompt(rest, speakers, segments)).toBeNull()
  })

  it('참석 인원을 지정했으면 묻지 않는다', () => {
    expect(speakerCountPrompt({ ...base, expected_speakers: 3 }, speakers, segments)).toBeNull()
  })

  it('처리 중이면 묻지 않는다', () => {
    expect(speakerCountPrompt({ ...base, status: 'processing' }, speakers, segments)).toBeNull()
  })

  it('발언이 없으면 묻지 않는다', () => {
    expect(speakerCountPrompt(base, speakers, [])).toBeNull()
  })

  it('화자 3명 중 발언이 있는 2명을 센다', () => {
    expect(speakerCountPrompt(base, speakers, segments)).toEqual({ detected: 2 })
    expect(speakerCountPrompt({ ...base, status: 'transcribed' }, speakers, segments)).toEqual({ detected: 2 })
  })

  it('발언에 화자가 하나도 없어도 최소 1명으로 본다', () => {
    expect(speakerCountPrompt(base, speakers, [{ speaker_id: null }])).toEqual({ detected: 1 })
  })
})
