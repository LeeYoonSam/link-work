import { describe, it, expect } from 'vitest'
import {
  beginPipeline,
  cancelPipeline,
  endPipeline,
  isPipelineActive,
  PipelineCancelledError
} from './pipeline-abort'

// 레지스트리는 모듈 전역 상태이므로 테스트마다 겹치지 않는 meetingId를 쓰고 끝에 endPipeline으로 정리한다.
describe('pipeline-abort 레지스트리', () => {
  it('begin하면 isPipelineActive가 true가 된다', () => {
    const id = 1001
    expect(isPipelineActive(id)).toBe(false)
    const signal = beginPipeline(id)
    expect(isPipelineActive(id)).toBe(true)
    expect(signal.aborted).toBe(false)
    endPipeline(id)
    expect(isPipelineActive(id)).toBe(false)
  })

  it('이미 활성인 회의를 다시 begin하면 throw한다', () => {
    const id = 1002
    beginPipeline(id)
    expect(() => beginPipeline(id)).toThrow('이미 처리 중인 회의입니다.')
    endPipeline(id)
  })

  it('cancel하면 signal.aborted가 true가 되고 true를 반환한다', () => {
    const id = 1003
    const signal = beginPipeline(id)
    expect(signal.aborted).toBe(false)
    const result = cancelPipeline(id)
    expect(result).toBe(true)
    expect(signal.aborted).toBe(true)
    endPipeline(id)
  })

  it('활성 파이프라인이 없으면 cancel은 false를 반환한다', () => {
    const id = 1004
    expect(isPipelineActive(id)).toBe(false)
    expect(cancelPipeline(id)).toBe(false)
  })

  it('end 후에는 같은 회의를 다시 begin할 수 있다', () => {
    const id = 1005
    beginPipeline(id)
    cancelPipeline(id)
    endPipeline(id)
    // 취소·정리 후 재시작이 가능해야 한다 (재처리 시나리오). 새 컨트롤러이므로 aborted=false.
    const signal = beginPipeline(id)
    expect(signal.aborted).toBe(false)
    expect(isPipelineActive(id)).toBe(true)
    endPipeline(id)
  })

  it('PipelineCancelledError는 Error의 인스턴스이며 name이 지정돼 있다', () => {
    const err = new PipelineCancelledError()
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PipelineCancelledError)
    expect(err.name).toBe('PipelineCancelledError')
    expect(err.message).toBe('사용자가 취소했습니다.')
  })
})
