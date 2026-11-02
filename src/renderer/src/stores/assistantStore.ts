import { create } from 'zustand'
import type {
  AssistantNavigateEvent,
  AssistantSettings,
  Candidate,
  CommandApplyOutcome,
  CommandInterpretation,
  PlanItem,
  PlanItemStatus,
  TodayPayload,
  TodayResult
} from '../types'

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
  completeOrigin: (item: PlanItem) => Promise<boolean>
  saveSettings: (patch: Partial<AssistantSettings>) => Promise<boolean>
  setFocus: (focus: Focus | null) => void
  clearError: () => void
  // 명령을 해석한다. DB 를 쓰지 않는다. busy 를 바꾸지 않는다
  interpretCommand: (text: string, scopeItemId?: number) => Promise<void>
  // 미리보기의 실행 가능한 조작을 적용한다. 성공하면 true
  applyCommand: () => Promise<boolean>
  clearCommand: () => void
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

    // 비서 main 코드는 원본을 쓰지 않는다(A2). 원본 완료는 기존 API 로 렌더러가 부른다
    completeOrigin: async (item) => {
      const target = originTarget(item)
      if (!target) return false
      try {
        if (target.kind === 'todo') await window.api.todo.complete(target.id)
        else await window.api.task.update(target.id, { status: 'done' })
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

    subscribe: () => {
      const api = window.api?.assistant
      if (!api) return () => {}
      return api.onChanged(() => {
        void get().load()
      })
    }
  }
})
