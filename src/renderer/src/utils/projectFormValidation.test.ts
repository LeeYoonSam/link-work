import { describe, it, expect } from 'vitest'
import {
  PRIORITY_REQUIRED_MESSAGE,
  resolveEffectiveStatus,
  validateProjectDraft,
  type ProjectDraft
} from './projectFormValidation'

// 개발 중 프로젝트에 우선순위를 강제하는 규칙은 "폼에 적힌 상태"가 아니라
// "저장하면 갖게 될 상태"로 판정해야 한다. 자동 상태는 날짜에서 계산되기 때문에,
// 폼의 status 필드는 scheduled인 채로 남아 있어도 실제로는 개발 중일 수 있다.

const TODAY = '2026-03-10'

const draft = (over: Partial<ProjectDraft> = {}): ProjectDraft => ({
  status: 'scheduled',
  status_manual: 0,
  dev_start_date: '2026-03-02',
  dev_end_date: '2026-03-20',
  qa_start_date: '2026-03-23',
  qa_end_date: '2026-03-25',
  deploy_date: '2026-03-27',
  priority: null,
  ...over
})

describe('resolveEffectiveStatus', () => {
  it('자동 모드에서는 폼의 status가 아니라 날짜로 계산한 상태를 쓴다', () => {
    expect(resolveEffectiveStatus(draft(), TODAY)).toBe('development')
  })

  it('수동 모드에서는 고른 상태를 그대로 쓴다', () => {
    expect(resolveEffectiveStatus(draft({ status: 'qa', status_manual: 1 }), TODAY)).toBe('qa')
  })

  it('날짜가 아직 비어 있으면 계산하지 않고 폼 상태를 그대로 둔다', () => {
    const partial = draft({ qa_start_date: '', qa_end_date: '', deploy_date: '' })
    expect(resolveEffectiveStatus(partial, TODAY)).toBe('scheduled')
  })
})

describe('validateProjectDraft', () => {
  it('자동 계산 결과가 개발 중인데 우선순위가 없으면 저장을 막는다', () => {
    expect(validateProjectDraft(draft(), TODAY)).toBe(PRIORITY_REQUIRED_MESSAGE)
  })

  it('수동으로 development를 고른 경우에도 우선순위가 없으면 막는다', () => {
    const manual = draft({ status: 'development', status_manual: 1, dev_start_date: '2026-04-01' })
    expect(validateProjectDraft(manual, TODAY)).toBe(PRIORITY_REQUIRED_MESSAGE)
  })

  it('우선순위를 지정하면 개발 중이어도 통과한다', () => {
    expect(validateProjectDraft(draft({ priority: 'now' }), TODAY)).toBeNull()
  })

  it('개발 중이 아니면 우선순위 없이도 통과한다', () => {
    const scheduled = draft({ dev_start_date: '2026-04-01', dev_end_date: '2026-04-20' })
    expect(resolveEffectiveStatus(scheduled, TODAY)).toBe('scheduled')
    expect(validateProjectDraft(scheduled, TODAY)).toBeNull()
  })

  it('날짜가 덜 채워진 중간 상태를 개발 중으로 오인해 막지 않는다', () => {
    const partial = draft({ qa_start_date: '', qa_end_date: '', deploy_date: '' })
    expect(validateProjectDraft(partial, TODAY)).toBeNull()
  })
})
