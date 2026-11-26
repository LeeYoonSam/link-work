import { describe, it, expect } from 'vitest'
import { shouldAskHeadcountOnStop } from './RecorderControls'

// 종료 시 참석 인원 질문(#8): 회의인데 참석 인원을 비워 두고 시작했을 때만 묻는다.
describe('shouldAskHeadcountOnStop', () => {
  const cases: Array<[Parameters<typeof shouldAskHeadcountOnStop>[0], boolean]> = [
    [{ kind: 'meeting', speakersInput: '' }, true],
    [{ kind: 'meeting', speakersInput: '   ' }, true],
    [{ kind: 'meeting', speakersInput: '3' }, false],
    [{ kind: 'interview', speakersInput: '' }, false],
    [{ kind: 'interview', speakersInput: '2' }, false]
  ]
  it.each(cases)('%j → %s', (input, expected) => {
    expect(shouldAskHeadcountOnStop(input)).toBe(expected)
  })
})
