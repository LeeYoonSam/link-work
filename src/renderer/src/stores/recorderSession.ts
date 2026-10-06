import { useRecorderStore } from './recorderStore'
import type { RecorderState } from './recorderStore'
import { useRecordingStore } from './recordingStore'
import type { MeetingKind, RecorderCommand } from '../types'

// 녹음 세션 수명주기(시작 → 종료·저장 → 후속 처리 / 취소) 오케스트레이션.
// 컴포넌트가 아니라 모듈 함수로 둔다 — 녹음 화면이 언마운트된 상태(다른 메뉴)에서도
// main의 창 닫기/앱 종료 가드가 보낸 명령으로 저장할 수 있어야 하기 때문.
//
// 불변식: DB의 draft 회의 행(status='recording')은 녹음기 세션과 수명을 같이한다.
// 시작 실패·취소 시 행을 지우고, 저장 실패 시에는 blob(lastResult)을 남겨 재시도할 수 있게 한다.

export interface StartSessionInput {
  source: 'mic' | 'mic+system'
  kind: MeetingKind
  // 참석 인원(화자분리 클러스터 수). null이면 자동 추정.
  expected_speakers: number | null
  attendee_ids: number[]
  compact_audio: boolean
}

// 진행 중인 종료·저장 — 중복 클릭이나 UI·main 명령이 겹쳐도 한 번만 저장한다.
let pendingSave: Promise<void> | null = null

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

// 진행 중인 시작 — 권한 팝업·화면 선택창이 떠 있는 동안에는 state가 아직 'idle'이라
// 시작을 다시 누를 수 있다. 겹치면 draft가 2개 생기고 스트림이 새므로 한 번만 시작한다.
let pendingStart: Promise<void> | null = null

export function startSession(input: StartSessionInput): Promise<void> {
  if (pendingStart) return pendingStart
  pendingStart = runStartSession(input).finally(() => {
    pendingStart = null
  })
  return pendingStart
}

async function runStartSession(input: StartSessionInput): Promise<void> {
  useRecorderStore.getState().setSaveError(null)
  const id = await useRecordingStore.getState().createDraft(input)
  const ok = await useRecorderStore.getState().start({ source: input.source, draftId: id })
  if (!ok) {
    // 마이크 권한 거부 등으로 시작하지 못했다 — 방금 만든 draft 행이 '녹음 중'으로 남지 않게 지운다.
    await useRecordingStore.getState().discardDraft(id)
    throw new Error(useRecorderStore.getState().error ?? '녹음을 시작할 수 없습니다.')
  }
}

export function stopAndSave(opts: { process?: boolean } = {}): Promise<void> {
  if (pendingSave) return pendingSave
  pendingSave = runStopAndSave(opts.process ?? true).finally(() => {
    pendingSave = null
  })
  return pendingSave
}

async function runStopAndSave(process: boolean): Promise<void> {
  const recorder = useRecorderStore.getState()
  const draftId = recorder.draftId
  if (draftId == null) throw new Error('저장할 녹음이 없습니다.')

  recorder.setSaving(true)
  recorder.setSaveError(null)
  try {
    // 이전 저장이 실패해 이미 멈춘 상태면 보존된 녹음으로 다시 저장한다.
    const current = useRecorderStore.getState()
    const result =
      current.state === 'stopped' && current.lastResult ? current.lastResult : await current.stop()
    await useRecordingStore
      .getState()
      .saveRecording(draftId, result.blob, result.durationMs, result.mime)
  } catch (e) {
    const store = useRecorderStore.getState()
    // 종료 대기 중 cancelSession이 reset했다(stop이 '녹음이 취소되었습니다.'로 reject) —
    // 사용자가 버리기로 한 것이므로 에러를 띄우지 않고 조용히 끝낸다.
    if (store.state === 'idle' && store.draftId == null) return
    // 저장 실패 — state 'stopped'와 lastResult를 그대로 두어 '다시 저장'할 수 있게 한다.
    store.setSaveError(errorMessage(e, '저장 실패'))
    store.setSaving(false)
    throw e
  }

  // 오디오가 저장되면 녹음기는 바로 비운다. 전사·요약은 수 분 걸리므로 기다리지 않고
  // 백그라운드로 돌린다(진행률은 목록·상세 화면이 스트림 이벤트로 표시한다).
  // 순서 주의: processAndSummarize는 첫 await 전에 process IPC를 보낸다. main 가드는
  // command-done을 받자마자 창을 닫고 'recording' 행을 정리하므로, 그보다 먼저
  // status='processing'으로 바뀌도록 이 호출은 stopAndSave가 resolve되기 전에 동기로 일어나야 한다.
  useRecorderStore.getState().reset()
  if (process) void useRecordingStore.getState().processAndSummarize(draftId)
}

export async function retrySave(): Promise<void> {
  const { state, lastResult } = useRecorderStore.getState()
  if (state !== 'stopped' || !lastResult) return
  await stopAndSave({ process: true })
}

export async function cancelSession(): Promise<void> {
  const draftId = useRecorderStore.getState().draftId
  useRecorderStore.getState().reset()
  if (draftId != null) await useRecordingStore.getState().discardDraft(draftId)
}

function isActive(state: RecorderState): boolean {
  return state !== 'idle'
}

async function handleCommand(cmd: RecorderCommand): Promise<void> {
  const api = window.api.recorder
  if (!isActive(useRecorderStore.getState().state)) {
    // 저장할 녹음이 없다 — 가드는 그대로 닫기/종료를 진행하면 된다.
    api.commandDone({ requestId: cmd.requestId, success: true })
    return
  }
  try {
    await stopAndSave({ process: cmd.process })
    api.commandDone({ requestId: cmd.requestId, success: true })
  } catch (e) {
    api.commandDone({ requestId: cmd.requestId, success: false, error: errorMessage(e, '저장 실패') })
  }
}

// main 가드와의 브리지. 녹음 활성 여부를 main에 알리고, main의 저장 명령을 수행한다.
// App에서 1회 설치하고, 반환한 함수로 해제한다.
export function installRecorderBridge(): () => void {
  const api = window.api.recorder
  // 처음 한 번은 무조건 보고한다 — 창 새로고침 후 main에 남은 이전 상태를 덮어쓴다.
  let last: { active: boolean; draftId: number | null } | null = null
  const report = (state: RecorderState, draftId: number | null): void => {
    const active = isActive(state)
    if (last && last.active === active && last.draftId === draftId) return
    last = { active, draftId }
    api.reportState(last)
  }

  const initial = useRecorderStore.getState()
  report(initial.state, initial.draftId)
  const unsubscribe = useRecorderStore.subscribe((s) => report(s.state, s.draftId))
  const offCommand = api.onCommand((cmd) => {
    if (cmd.type === 'stop-and-save') void handleCommand(cmd)
  })

  return () => {
    unsubscribe()
    offCommand()
  }
}
