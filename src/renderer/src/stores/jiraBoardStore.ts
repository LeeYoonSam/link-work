import { create } from 'zustand'
import type { JiraBoardSnapshot, JiraEpicAiSummary } from '../types'
import {
  DEFAULT_FILTER,
  EMPTY_FILTER,
  type BoardFilter,
  type BoardSort
} from '../components/project/boardModel'

// 프로젝트 화면(Jira 계층 보드) 상태. 데이터는 main 의 jiraBoard:fetch 스냅샷 하나다.
// 펼침·토글(내 담당만·완료 모두 숨김·이전 완료 보기)·정렬 같은 사용자별 편의만 localStorage 에 남긴다 (없거나 막혀도 동작한다).

export type JiraBoardErrorCode = 'not_connected' | 'no_default_project'

const PREFS_KEY = 'linkwork.jiraBoard.prefs'

interface Prefs {
  mineOnly: boolean
  hideDone: boolean
  showPastDone: boolean
  sort: BoardSort
  expanded: Record<string, boolean>
}

const SORTS: BoardSort[] = ['active', 'key', 'updated', 'due']

function readPrefs(): Partial<Prefs> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return {}
    const p = JSON.parse(raw) as Partial<Prefs>
    const out: Partial<Prefs> = {}
    if (typeof p.mineOnly === 'boolean') out.mineOnly = p.mineOnly
    if (typeof p.hideDone === 'boolean') out.hideDone = p.hideDone
    if (typeof p.showPastDone === 'boolean') out.showPastDone = p.showPastDone
    if (p.sort && SORTS.includes(p.sort)) out.sort = p.sort
    if (p.expanded && typeof p.expanded === 'object') {
      const expanded: Record<string, boolean> = {}
      for (const [k, v] of Object.entries(p.expanded)) if (typeof v === 'boolean') expanded[k] = v
      out.expanded = expanded
    }
    return out
  } catch {
    return {}
  }
}

function writePrefs(s: Pick<JiraBoardState, 'filter' | 'sort' | 'expanded'>): void {
  try {
    if (typeof localStorage === 'undefined') return
    const prefs: Prefs = {
      mineOnly: s.filter.mineOnly,
      hideDone: s.filter.hideDone,
      showPastDone: s.filter.showPastDone,
      sort: s.sort,
      expanded: s.expanded
    }
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // 저장 실패는 편의 기능만 잃는다
  }
}

export interface JiraBoardState {
  snapshot: JiraBoardSnapshot | null
  /** 조회 중. 재조회 때도 snapshot 은 그대로 둔다 */
  loading: boolean
  error: string | null
  errorCode: JiraBoardErrorCode | null
  filter: BoardFilter
  sort: BoardSort
  /** 행 id → 펼침. 없으면 기본값(에픽 펼침, 하위작업 접힘) */
  expanded: Record<string, boolean>
  /** 상세 패널에 띄운 행 id */
  selectedKey: string | null
  aiSummaries: Record<string, JiraEpicAiSummary>
  aiLoading: Record<string, boolean>
  aiErrors: Record<string, string>

  load: (force?: boolean) => Promise<void>
  summarizeEpic: (epicKey: string) => Promise<void>
  setFilter: (patch: Partial<BoardFilter>) => void
  clearFilter: () => void
  setSort: (sort: BoardSort) => void
  setExpanded: (id: string, expanded: boolean) => void
  setAllExpanded: (ids: string[], expanded: boolean) => void
  select: (key: string | null) => void
  dismissError: () => void
}

const prefs = readPrefs()

// 늦게 끝난 옛 요청이 새 결과를 덮지 않게 요청마다 번호를 붙인다
let loadSeq = 0

export const useJiraBoardStore = create<JiraBoardState>((set, get) => ({
  snapshot: null,
  loading: false,
  error: null,
  errorCode: null,
  filter: {
    ...DEFAULT_FILTER,
    mineOnly: prefs.mineOnly ?? DEFAULT_FILTER.mineOnly,
    hideDone: prefs.hideDone ?? DEFAULT_FILTER.hideDone,
    showPastDone: prefs.showPastDone ?? DEFAULT_FILTER.showPastDone
  },
  sort: prefs.sort ?? 'active',
  expanded: prefs.expanded ?? {},
  selectedKey: null,
  aiSummaries: {},
  aiLoading: {},
  aiErrors: {},

  load: async (force = false) => {
    // 이미 도는 조회가 있으면 강제 새로고침이 아닌 한 겹쳐 부르지 않는다
    if (get().loading && !force) return
    const seq = ++loadSeq
    set({ loading: true })
    try {
      const res = await window.api.jiraBoard.fetch(force)
      if (seq !== loadSeq) return
      if (res.success) {
        set({ snapshot: res.snapshot, loading: false, error: null, errorCode: null })
        return
      }
      const errorCode = res.code ?? null
      set({
        loading: false,
        error: res.error,
        errorCode,
        // 연결이 끊겼거나 기본 프로젝트가 바뀌었으면 옛 티켓을 계속 보여주지 않는다
        ...(errorCode ? { snapshot: null } : {})
      })
    } catch (e) {
      if (seq !== loadSeq) return
      set({
        loading: false,
        error: e instanceof Error ? e.message : 'Jira 티켓을 불러오지 못했어요',
        errorCode: null
      })
    }
  },

  summarizeEpic: async (epicKey) => {
    if (get().aiLoading[epicKey]) return
    set((s) => ({
      aiLoading: { ...s.aiLoading, [epicKey]: true },
      aiErrors: omit(s.aiErrors, epicKey)
    }))
    try {
      const res = await window.api.jiraBoard.summarizeEpic(epicKey)
      if (res.success) {
        set((s) => ({ aiSummaries: { ...s.aiSummaries, [epicKey]: res.summary } }))
      } else {
        set((s) => ({ aiErrors: { ...s.aiErrors, [epicKey]: res.error } }))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'AI 요약을 만들지 못했어요'
      set((s) => ({ aiErrors: { ...s.aiErrors, [epicKey]: msg } }))
    } finally {
      set((s) => ({ aiLoading: omit(s.aiLoading, epicKey) }))
    }
  },

  setFilter: (patch) => {
    set((s) => ({ filter: { ...s.filter, ...patch } }))
    writePrefs(get())
  },

  clearFilter: () => {
    set({ filter: { ...EMPTY_FILTER } })
    writePrefs(get())
  },

  setSort: (sort) => {
    set({ sort })
    writePrefs(get())
  },

  setExpanded: (id, expanded) => {
    set((s) => ({ expanded: { ...s.expanded, [id]: expanded } }))
    writePrefs(get())
  },

  setAllExpanded: (ids, expanded) => {
    set((s) => {
      const next = { ...s.expanded }
      for (const id of ids) next[id] = expanded
      return { expanded: next }
    })
    writePrefs(get())
  },

  select: (key) => set({ selectedKey: key }),

  dismissError: () => set({ error: null })
}))

function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const next = { ...rec }
  delete next[key]
  return next
}
