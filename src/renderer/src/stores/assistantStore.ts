import { create } from 'zustand'
import type {
  AssistantNavigateEvent,
  AssistantSettings,
  Candidate,
  CommandApplyOutcome,
  CommandInterpretation,
  PlanItem,
  PlanItemStatus,
  Task,
  TodayPayload,
  TodayResult
} from '../types'
import { refreshEntity } from './dataSync'

type Focus = NonNullable<AssistantNavigateEvent['focus']>

interface AssistantStore {
  today: TodayPayload | null
  loading: boolean
  // 버튼 동작이 진행 중이면 true. 중복 클릭을 막는다
  busy: boolean
  error: string
  candidates: Candidate[]
  candidatesLoading: boolean
  candidatesError: string
  // 사용자가 '건너뛰기'를 누른 어제 메모 날짜
  skippedWrapupDate: string | null
  // 알림 클릭으로 열린 영역
  focus: Focus | null
  // 명령 입력 (부록 G.10.2). 한 번에 해석 1건만 둔다
  command: CommandInterpretation | null
  commandPhase: 'idle' | 'interpreting' | 'applying'
  commandError: string
  commandResult: Pick<CommandApplyOutcome, 'results' | 'applied' | 'failed'> | null
  // 마지막 해석·적용 요청의 범위 항목. 진행 중·오류·결과를 요청한 입력창에만 보인다
  commandScope: number | null
  // 회의 브리핑을 다시 만드는 중인 이벤트 id. 전역 busy 를 쓰지 않는다.
  // 이유: LLM 줄이 길면 오늘 화면 전체 버튼이 오래 잠긴다
  meetingRegeneratingIds: number[]

  load: () => Promise<void>
  startDay: () => Promise<void>
  closeDay: (note?: string) => Promise<void>
  reopenDay: () => Promise<void>
  saveWrapup: (note: string, date: string) => Promise<boolean>
  skipWrapup: (date: string) => void
  refresh: () => Promise<void>
  refreshBriefing: () => Promise<void>
  // 맥락 복구 본문을 만든다 (부록 F.7)
  generateRecovery: () => Promise<void>
  loadCandidates: () => Promise<void>
  addItem: (candidateId: string) => Promise<void>
  acceptSuggestion: (itemId: number) => Promise<void>
  dismissSuggestion: (itemId: number) => Promise<void>
  setItemStatus: (itemId: number, status: PlanItemStatus, note?: string) => Promise<void>
  // 항목을 집중 작업으로 바꾼다 (부록 B.4)
  focusItem: (itemId: number) => Promise<void>
  // 계속 제외한다. jira·task 항목만 된다 (부록 M.5.6)
  excludeItem: (itemId: number) => Promise<void>
  // 계속 제외 기록을 지운다. 계획 항목은 바꾸지 않는다 (부록 M.5.6)
  removeExclusion: (candidateId: string) => Promise<void>
  completeOrigin: (item: PlanItem) => Promise<boolean>
  saveSettings: (patch: Partial<AssistantSettings>) => Promise<boolean>
  setFocus: (focus: Focus | null) => void
  clearError: () => void
  // 명령을 해석한다. DB 를 쓰지 않는다. busy 를 바꾸지 않는다
  interpretCommand: (text: string, scopeItemId?: number) => Promise<void>
  // 미리보기의 실행 가능한 조작을 적용한다. 성공하면 true
  applyCommand: () => Promise<boolean>
  clearCommand: () => void
  // 회의 브리핑의 AI 본문을 다시 만든다 (부록 I.10.3). 결과를 기다린다
  regenerateMeetingBriefing: (eventId: number) => Promise<void>
  // assistant:changed 를 구독한다. 해제 함수를 돌려준다
  subscribe: () => () => void
}

const errorText = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message ? e.message : fallback

// 원본 완료 처리가 가능한 출처인지 판정한다. jira·action_item 은 원본 API 가 없다
export function originTarget(
  item: Pick<PlanItem, 'source' | 'candidate_id'>
): { kind: 'todo' | 'task'; id: number } | null {
  const m = item.candidate_id.match(/^(todo|task):(\d+)$/)
  if (!m || (item.source !== 'todo' && item.source !== 'task')) return null
  return { kind: m[1] as 'todo' | 'task', id: Number(m[2]) }
}

// Jira 연결 작업은 상태를 Jira 가 정한다(PROJECT_SYNC R12). 원본 완료로 바꾸지 않는다.
// 이유: 바꿔도 다음 동기화가 Jira 값으로 되돌린다.
// 계획 항목에 키가 있으면 바로 판정한다. 화면이 원본 완료 체크박스를 숨길 때 쓴다.
export function isJiraLinkedTaskItem(item: Pick<PlanItem, 'source' | 'jira_issue_key'>): boolean {
  return item.source === 'task' && !!item.jira_issue_key
}

// 계획 항목에 키가 없으면 작업 목록을 조회해 판정한다.
// 계획 항목은 만든 시점의 스냅샷이라, 그 뒤 R12 가 키를 백필한 작업은 키가 비어 있을 수 있다.
// 조회할 수 없으면 false 를 돌려준다. 그러면 기존처럼 호출하고 main 의 task:update 가 막는다.
export async function isJiraLinkedTask(
  item: Pick<PlanItem, 'source' | 'jira_issue_key' | 'project_id'>,
  taskId: number,
  listTasks: (projectId: number) => Promise<Task[]>
): Promise<boolean> {
  if (isJiraLinkedTaskItem(item)) return true
  if (item.source !== 'task' || item.project_id == null) return false
  try {
    const tasks = await listTasks(item.project_id)
    return !!tasks.find((t) => t.id === taskId)?.jira_issue_key
  } catch {
    return false
  }
}

// 명령 미리보기를 버려야 하는지 판정한다.
// 새 today 의 계획이 근무 중이 아니거나 계획 id 가 바뀌면, 예전 미리보기는 쓸 수 없다
export function isCommandStale(prev: TodayPayload | null, next: TodayPayload): boolean {
  if (next.plan?.status !== 'active') return true
  return (prev?.plan?.id ?? null) !== next.plan.id
}

const EMPTY_COMMAND = {
  command: null,
  commandError: '',
  commandResult: null,
  commandScope: null
} as const

export const useAssistantStore = create<AssistantStore>((set, get) => {
  // today 를 바꾼다. 계획이 닫히거나 바뀌면 명령 상태도 비운다 (부록 G.10.2)
  const setToday = (today: TodayPayload, extra: Partial<AssistantStore> = {}): void => {
    const stale = isCommandStale(get().today, today)
    set({ ...extra, today, ...(stale ? EMPTY_COMMAND : {}) })
  }

  // today 를 돌려주는 동작의 공통 처리. 성공하면 today 를 바꾸고, 실패하면 error 를 둔다
  const run = async (call: () => Promise<TodayResult>, fallback: string): Promise<boolean> => {
    if (get().busy) return false
    set({ busy: true, error: '' })
    try {
      const res = await call()
      if (res.success) {
        setToday(res.today, { busy: false })
        return true
      }
      set({ error: res.error || fallback, busy: false })
      return false
    } catch (e) {
      set({ error: errorText(e, fallback), busy: false })
      return false
    }
  }

  // 후보 목록을 한 번이라도 불러왔으면 다시 읽는다. 후보의 excluded 표시가 바뀐다 (부록 M.5.6).
  // 기다리지 않는다. 이유: 후보 조회는 Jira 를 거쳐 느리다
  const reloadCandidatesIfOpen = (): void => {
    const { candidates, candidatesLoading } = get()
    if (candidates.length > 0 && !candidatesLoading) void get().loadCandidates()
  }

  return {
    today: null,
    loading: false,
    busy: false,
    error: '',
    candidates: [],
    candidatesLoading: false,
    candidatesError: '',
    skippedWrapupDate: null,
    focus: null,
    command: null,
    commandPhase: 'idle',
    commandError: '',
    commandResult: null,
    commandScope: null,
    meetingRegeneratingIds: [],

    load: async () => {
      set({ loading: true })
      try {
        const res = await window.api.assistant.getToday()
        if (res.success) setToday(res.today, { loading: false, error: '' })
        else set({ error: res.error || '오늘 계획을 불러오지 못했습니다', loading: false })
      } catch (e) {
        set({ error: errorText(e, '오늘 계획을 불러오지 못했습니다'), loading: false })
      }
    },

    startDay: async () => {
      await run(() => window.api.assistant.startDay(), '하루 시작에 실패했습니다')
    },

    closeDay: async (note) => {
      const trimmed = note?.trim()
      await run(
        () => window.api.assistant.closeDay(trimmed ? trimmed : undefined),
        '퇴근 처리에 실패했습니다'
      )
    },

    reopenDay: async () => {
      await run(() => window.api.assistant.reopenDay(), '다시 열기에 실패했습니다')
    },

    saveWrapup: async (note, date) => {
      const trimmed = note.trim()
      if (!trimmed) return false
      set({ busy: true, error: '' })
      try {
        const res = await window.api.assistant.saveWrapup(trimmed, date)
        set({ busy: false })
        if (!res.success) {
          set({ error: res.error || '메모 저장에 실패했습니다' })
          return false
        }
        // missingWrapupDate 가 바뀌므로 오늘 화면을 다시 읽는다
        set({ skippedWrapupDate: date })
        await get().load()
        return true
      } catch (e) {
        set({ error: errorText(e, '메모 저장에 실패했습니다'), busy: false })
        return false
      }
    },

    skipWrapup: (date) => set({ skippedWrapupDate: date }),

    refresh: async () => {
      await run(() => window.api.assistant.refresh(), '새로고침에 실패했습니다')
    },

    refreshBriefing: async () => {
      await run(() => window.api.assistant.refreshBriefing(), '브리핑 생성에 실패했습니다')
    },

    generateRecovery: async () => {
      await run(() => window.api.assistant.generateRecovery(), '맥락 복구에 실패했습니다')
    },

    loadCandidates: async () => {
      set({ candidatesLoading: true, candidatesError: '' })
      try {
        const res = await window.api.assistant.listCandidates()
        if (res.success) set({ candidates: res.candidates, candidatesLoading: false })
        else
          set({
            candidatesError: res.error || '후보를 불러오지 못했습니다',
            candidatesLoading: false
          })
      } catch (e) {
        set({
          candidatesError: errorText(e, '후보를 불러오지 못했습니다'),
          candidatesLoading: false
        })
      }
    },

    addItem: async (candidateId) => {
      await run(() => window.api.assistant.addItem(candidateId), '계획에 추가하지 못했습니다')
    },

    acceptSuggestion: async (itemId) => {
      await run(
        () => window.api.assistant.acceptSuggestion(itemId),
        '계획에 추가하지 못했습니다'
      )
    },

    dismissSuggestion: async (itemId) => {
      await run(() => window.api.assistant.dismissSuggestion(itemId), '무시 처리에 실패했습니다')
    },

    setItemStatus: async (itemId, status, note) => {
      await run(
        () => window.api.assistant.setItemStatus(itemId, status, note),
        '상태를 바꾸지 못했습니다'
      )
    },

    focusItem: async (itemId) => {
      await run(() => window.api.assistant.focusItem(itemId), '집중 작업을 바꾸지 못했습니다')
    },

    excludeItem: async (itemId) => {
      const ok = await run(() => window.api.assistant.excludeItem(itemId), '계속 제외하지 못했습니다')
      if (ok) reloadCandidatesIfOpen()
    },

    removeExclusion: async (candidateId) => {
      const ok = await run(
        () => window.api.assistant.removeExclusion(candidateId),
        '제외를 해제하지 못했습니다'
      )
      if (ok) reloadCandidatesIfOpen()
    },

    // 비서 main 코드는 원본을 쓰지 않는다(A2). 원본 완료는 기존 API 로 렌더러가 부른다
    completeOrigin: async (item) => {
      const target = originTarget(item)
      if (!target) return false
      try {
        if (target.kind === 'todo') await window.api.todo.complete(target.id)
        else {
          // Jira 연결 작업은 원본을 바꾸지 않는다 (R12)
          if (await isJiraLinkedTask(item, target.id, (id) => window.api.task.list(id))) return false
          await window.api.task.update(target.id, { status: 'done' })
        }
        // 열린 할 일·프로젝트 화면이 원본 완료를 반영하게 한다. 기다리지 않는다
        void refreshEntity(target.kind === 'todo' ? 'todo' : 'project')
        return true
      } catch (e) {
        set({ error: errorText(e, '원본 완료 처리에 실패했습니다') })
        return false
      }
    },

    saveSettings: async (patch) => {
      set({ busy: true, error: '' })
      try {
        const res = await window.api.assistant.saveSettings(patch)
        set({ busy: false })
        if (!res.success) {
          set({ error: res.error || '설정 저장에 실패했습니다' })
          return false
        }
        const today = get().today
        if (today) set({ today: { ...today, settings: res.settings } })
        return true
      } catch (e) {
        set({ error: errorText(e, '설정 저장에 실패했습니다'), busy: false })
        return false
      }
    },

    setFocus: (focus) => set({ focus }),

    clearError: () => set({ error: '' }),

    interpretCommand: async (text, scopeItemId) => {
      const trimmed = text.replace(/\s+/g, ' ').trim()
      if (!trimmed || get().commandPhase !== 'idle') return
      set({
        command: null,
        commandPhase: 'interpreting',
        commandError: '',
        commandResult: null,
        commandScope: scopeItemId ?? null
      })
      try {
        const res = await window.api.assistant.interpretCommand(trimmed, scopeItemId)
        // 해석 중에 하루가 닫혔으면 결과를 버린다
        if (res.success && get().today?.plan?.status === 'active')
          set({ command: res.interpretation, commandPhase: 'idle' })
        else if (res.success) set({ commandPhase: 'idle' })
        else set({ commandError: res.error || '명령을 해석하지 못했습니다', commandPhase: 'idle' })
      } catch (e) {
        set({ commandError: errorText(e, '명령을 해석하지 못했습니다'), commandPhase: 'idle' })
      }
    },

    applyCommand: async () => {
      const { command, busy, commandPhase } = get()
      if (!command || busy || commandPhase !== 'idle') return false
      // 실행 가능한 조작만 보낸다. unsupported 는 화면 안내용이다 (A40)
      const ops = command.ops.filter((o) => o.executable).map((o) => o.op)
      if (ops.length === 0) return false
      set({
        busy: true,
        commandPhase: 'applying',
        commandError: '',
        commandResult: null,
        commandScope: command.scopeItemId
      })
      try {
        const res = await window.api.assistant.applyCommand(ops, command.text)
        if (res.success) {
          set({
            today: res.today,
            command: null,
            commandResult: { results: res.results, applied: res.applied, failed: res.failed },
            busy: false,
            commandPhase: 'idle'
          })
          return true
        }
        set({ commandError: res.error || '명령을 적용하지 못했습니다', busy: false, commandPhase: 'idle' })
        return false
      } catch (e) {
        set({
          commandError: errorText(e, '명령을 적용하지 못했습니다'),
          busy: false,
          commandPhase: 'idle'
        })
        return false
      }
    },

    clearCommand: () => set({ command: null, commandError: '', commandResult: null }),

    // 행 단위 상태를 쓴다. 같은 행의 중복 클릭만 막는다
    regenerateMeetingBriefing: async (eventId) => {
      if (get().meetingRegeneratingIds.includes(eventId)) return
      const fallback = '회의 브리핑을 다시 만들지 못했습니다'
      set({ meetingRegeneratingIds: [...get().meetingRegeneratingIds, eventId], error: '' })
      const finish = (): void =>
        set({ meetingRegeneratingIds: get().meetingRegeneratingIds.filter((id) => id !== eventId) })
      try {
        const res = await window.api.assistant.regenerateMeetingBriefing(eventId)
        finish()
        if (res.success) setToday(res.today)
        else set({ error: res.error || fallback })
      } catch (e) {
        finish()
        set({ error: errorText(e, fallback) })
      }
    },

    // reason 과 무관하게 다시 읽는다. 'meeting' 도 같다 (부록 I.10.3).
    // 메인 창은 dataSync.installDataSync 가 전역으로 구독한다. 화면에서 이 함수를 부르지 않는다.
    // 이유: 같은 이벤트로 load 가 2번 돈다
    subscribe: () => {
      const api = window.api?.assistant
      if (!api) return () => {}
      return api.onChanged(() => {
        void get().load()
      })
    }
  }
})
