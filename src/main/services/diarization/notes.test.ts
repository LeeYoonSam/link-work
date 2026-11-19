import { describe, it, expect } from 'vitest'
import { mergeNote, sherpaFailedNote, sherpaUnavailableNote, twoStageDegradedNote, errorMessage } from './notes'

describe('diarization notes', () => {
  it('정제로 화자 수가 줄었을 때만 병합 안내를 낸다', () => {
    expect(mergeNote({ speakersBefore: 9, speakersAfter: 4, refined: true })).toBe(
      '유사한 화자 9명을 4명으로 병합했습니다.'
    )
    expect(mergeNote({ speakersBefore: 4, speakersAfter: 4, refined: true })).toBeUndefined()
    expect(mergeNote({ speakersBefore: 9, speakersAfter: 9, refined: false })).toBeUndefined()
    expect(mergeNote(undefined)).toBeUndefined()
  })

  it('실패 안내에 원인 메시지를 보존한다', () => {
    expect(sherpaFailedNote('화자분리가 시간 초과되었습니다')).toBe(
      '화자분리에 실패해 화자를 구분하지 않았습니다. (화자분리가 시간 초과되었습니다)'
    )
    expect(sherpaFailedNote()).toBe('화자분리에 실패해 화자를 구분하지 않았습니다.')
    expect(sherpaUnavailableNote('ensure-failed')).toBe('화자분리 모델을 준비하지 못해 화자를 구분하지 않았습니다.')
    expect(twoStageDegradedNote('failed', 'boom')).toBe('화자분리에 실패해 나/상대 2명으로만 구분했습니다. (boom)')
    expect(errorMessage(new Error('x'))).toBe('x')
  })
})
