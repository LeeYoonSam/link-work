// 처리 파이프라인 취소 레지스트리 — 회의별 AbortController를 관리한다.
// electron/DB에 의존하지 않는 순수 모듈(테스트 용이). meeting-pipeline이 단계 사이마다
// signal.aborted를 확인하고, recording.ipc의 recording:cancel이 cancelPipeline을 호출한다.

/**
 * 파이프라인이 취소되었을 때 단계 체크에서 던지는 전용 에러.
 * meeting-pipeline의 catch가 이 타입(또는 signal.aborted)으로 취소를 일반 실패와 구분해
 * status를 이전 상태로 복원한다. 일반 에러로 오인해 'failed'로 덮어쓰면 안 되기 때문에 별도 타입으로 둔다.
 */
export class PipelineCancelledError extends Error {
  constructor(message = '사용자가 취소했습니다.') {
    super(message)
    this.name = 'PipelineCancelledError'
  }
}

// meetingId → 진행 중 파이프라인의 AbortController. 완료/실패/취소로 파이프라인이 끝날 때
// endPipeline으로 제거한다. 항목이 존재한다는 것은 곧 해당 회의가 처리 중이라는 뜻.
const registry = new Map<number, AbortController>()

/**
 * 회의 처리를 시작하며 취소용 AbortSignal을 발급한다.
 * 이미 활성 파이프라인이 있으면 throw(중복 처리 방지) — 이 경우 호출측은 진행 중 작업을
 * 건드리지 말아야 한다(DB status를 덮어쓰지 말 것).
 */
export function beginPipeline(meetingId: number): AbortSignal {
  if (registry.has(meetingId)) {
    throw new Error('이미 처리 중인 회의입니다.')
  }
  const controller = new AbortController()
  registry.set(meetingId, controller)
  return controller.signal
}

/**
 * 활성 파이프라인을 취소한다. abort를 발동했으면 true, 활성 파이프라인이 없으면 false.
 * 레지스트리에서 제거하지는 않는다 — 취소된 파이프라인이 catch/finally에서 상태를 복원한 뒤
 * 스스로 endPipeline으로 정리한다. 여기서 미리 지우면 아직 언와인딩 중인 옛 파이프라인과
 * 새 beginPipeline이 같은 회의에 동시 진입할 수 있다.
 */
export function cancelPipeline(meetingId: number): boolean {
  const controller = registry.get(meetingId)
  if (!controller) return false
  controller.abort()
  return true
}

/**
 * 파이프라인 종료(완료/실패/취소) 시 레지스트리에서 제거한다.
 * 이후 같은 회의를 다시 beginPipeline할 수 있게 한다. 없는 항목이면 no-op.
 */
export function endPipeline(meetingId: number): void {
  registry.delete(meetingId)
}

/** 해당 회의에 진행 중인 파이프라인이 있는지 여부. */
export function isPipelineActive(meetingId: number): boolean {
  return registry.has(meetingId)
}
