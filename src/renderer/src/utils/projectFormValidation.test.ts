import { describe, it, expect } from 'vitest'
import {
  AUTO_STATUS,
  PRIORITY_REQUIRED_MESSAGE,
  resolveEffectiveStatus,
  statusSelectionPatch,
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

describe('statusSelectionPatch', () => {
  it('중단을 고르면 상태를 수동으로 고정한다', () => {
    expect(statusSelectionPatch('on_hold')).toEqual({ status: 'on_hold', status_manual: 1 })
  })

  it('다른 수동 상태도 같은 경로를 탄다', () => {
    expect(statusSelectionPatch('development')).toEqual({
      status: 'development',
      status_manual: 1
    })
  })

  // 재개는 "중단 직전 상태로 되돌리기"가 아니라 "자동 계산 다시 켜기"다.
  // status를 패치에 넣지 않아야 main이 그 컬럼을 건드리지 않는다.
  it('auto를 고르면 status는 건드리지 않고 수동 고정만 푼다', () => {
    const patch = statusSelectionPatch(AUTO_STATUS)
    expect(patch).toEqual({ status_manual: 0 })
    expect('status' in patch).toBe(false)
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

  // 중단은 날짜상 개발 기간 한복판이어도 우선순위 필수 대상이 아니다.
  // 멈춰 세운 프로젝트에까지 순위를 요구하면 중단 자체가 번거로워진다.
  it('중단 상태는 우선순위가 없어도 저장할 수 있다', () => {
    const held = draft({ ...statusSelectionPatch('on_hold'), priority: null })
    expect(resolveEffectiveStatus(held, TODAY)).toBe('on_hold')
    expect(validateProjectDraft(held, TODAY)).toBeNull()
  })

  it('중단을 풀어 자동으로 되돌리면 다시 우선순위를 요구한다', () => {
    const resumed = draft({ ...statusSelectionPatch(AUTO_STATUS), priority: null })
    expect(resolveEffectiveStatus(resumed, TODAY)).toBe('development')
    expect(validateProjectDraft(resumed, TODAY)).toBe(PRIORITY_REQUIRED_MESSAGE)
  })

  it('날짜가 덜 채워진 중간 상태를 개발 중으로 오인해 막지 않는다', () => {
    const partial = draft({ qa_start_date: '', qa_end_date: '', deploy_date: '' })
    expect(validateProjectDraft(partial, TODAY)).toBeNull()
  })
})
