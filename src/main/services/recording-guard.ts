// 창 닫기/앱 종료 녹음 가드의 순수 로직.
// SSOT: docs/MEETING_RECORDING.md "녹음 수명주기와 비정상 종료 복구"
//
// 녹음은 렌더러의 MediaRecorder 메모리에만 있으므로, 녹음 중 창을 닫거나 앱을 끄면 녹음이
// 사라진다. main은 렌더러가 보고하는 녹음 상태(recorder:state)를 들고 있다가, 닫기/종료 시
// 사용자에게 묻고 필요하면 렌더러에 저장을 요청(recorder:command)한 뒤 완료 응답
// (recorder:command-done)을 기다린다.
//
// electron을 import하지 않는다 — 전송 함수는 호출자가 주입하고, 다이얼로그 선택지 → 동작
// 매핑도 순수 함수로 두어 테스트에서 그대로 검증한다. 실제 다이얼로그·창 조작은 index.ts.
import { randomUUID } from 'crypto'

export interface RecorderStatePayload {
  active: boolean
  draftId: number | null
}

export interface RecorderCommandPayload {
  type: 'stop-and-save'
  requestId: string
  process: boolean
}

export interface RecorderCommandDonePayload {
  requestId: string
  success: boolean
  error?: string
}

export interface StopAndSaveResult {
  success: boolean
  error?: string
}

// 렌더러가 저장(WAV 변환 + 파일 쓰기)을 끝낼 때까지 기다리는 기본 시간
export const STOP_AND_SAVE_TIMEOUT_MS = 60000

interface PendingRequest {
  resolve: (r: StopAndSaveResult) => void
  timer: ReturnType<typeof setTimeout>
}

export class RecordingGuard {
  private state: RecorderStatePayload = { active: false, draftId: null }
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly genId: () => string = randomUUID) {}

  isActive(): boolean {
    return this.state.active
  }

  draftId(): number | null {
    return this.state.draftId
  }

  // 렌더러의 recorder:state 보고 반영. 형식이 어긋난 payload는 비활성으로 본다.
  setState(payload: unknown): void {
    const p = payload as Partial<RecorderStatePayload> | null
    this.state = {
      active: !!p && p.active === true,
      draftId: p && typeof p.draftId === 'number' ? p.draftId : null
    }
  }

  // 렌더러에 저장을 요청하고 command-done을 기다린다. 전송 실패·타임아웃이면 success:false.
  requestStopAndSave(
    send: (cmd: RecorderCommandPayload) => void,
    process: boolean,
    timeoutMs: number = STOP_AND_SAVE_TIMEOUT_MS
  ): Promise<StopAndSaveResult> {
    const requestId = this.genId()
    return new Promise<StopAndSaveResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ success: false, error: 'timeout' })
      }, timeoutMs)
      this.pending.set(requestId, { resolve, timer })
      try {
        send({ type: 'stop-and-save', requestId, process })
      } catch (err) {
        this.settle(requestId, {
          success: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })
  }

  // 렌더러의 recorder:command-done 처리. 모르는 requestId(이미 타임아웃 등)는 무시한다.
  handleCommandDone(payload: unknown): void {
    const p = payload as Partial<RecorderCommandDonePayload> | null
    if (!p || typeof p.requestId !== 'string') return
    this.settle(p.requestId, {
      success: p.success === true,
      ...(typeof p.error === 'string' ? { error: p.error } : {})
    })
  }

  // 렌더러가 사라졌을 때(창 닫힘·크래시): 녹음 상태를 비우고 대기 중인 요청을 실패로 끝낸다.
  reset(): void {
    this.state = { active: false, draftId: null }
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { success: false, error: 'renderer-gone' })
    }
  }

  private settle(requestId: string, result: StopAndSaveResult): void {
    const req = this.pending.get(requestId)
    if (!req) return
    clearTimeout(req.timer)
    this.pending.delete(requestId)
    req.resolve(result)
  }
}

// ── 다이얼로그 선택지 → 동작 매핑 (버튼 순서는 index.ts의 buttons 배열과 같다) ──

// 녹음 중 창 닫기: ['녹음 계속 (창 숨기기)', '저장하고 닫기', '돌아가기']
export const CLOSE_BUTTONS = ['녹음 계속 (창 숨기기)', '저장하고 닫기', '돌아가기']
export type CloseAction = 'hide' | 'save-and-close' | 'cancel'
export function closeChoiceToAction(index: number): CloseAction {
  if (index === 0) return 'hide'
  if (index === 1) return 'save-and-close'
  return 'cancel'
}

// 녹음 중 앱 종료: ['저장하고 종료', '돌아가기']
export const QUIT_BUTTONS = ['저장하고 종료', '돌아가기']
export type QuitAction = 'save-and-quit' | 'cancel'
export function quitChoiceToAction(index: number): QuitAction {
  return index === 0 ? 'save-and-quit' : 'cancel'
}

// 저장 실패 후 재확인: ['그래도 닫기'|'그래도 종료', '돌아가기']
export type ForceAction = 'force' | 'cancel'
export function forceChoiceToAction(index: number): ForceAction {
  return index === 0 ? 'force' : 'cancel'
}
