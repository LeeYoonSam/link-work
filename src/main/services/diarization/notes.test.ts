import { describe, it, expect } from 'vitest'
import { sherpaFailedNote, sherpaUnavailableNote, twoStageDegradedNote, errorMessage } from './notes'

describe('diarization notes', () => {
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
