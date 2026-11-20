import { create } from 'zustand'
import type {
  JiraBoardSnapshot,
  JiraBoardSyncInfo,
  JiraBoardSyncMode,
  JiraEpicAiSummary
} from '../types'
import {
  CLOSED_SECTION_ID,
  DEFAULT_FILTER,
  EMPTY_FILTER,
  ancestorIds,
  doneFoldId,
  flattenVisible,
  shouldFoldDone,
  buildIssueForest,
  filterForest,
  findIssue,
  forestOptions,
  isRevealable,
  localDate,
  revealFilter,
  type BoardFilter,
  type BoardSort
} from '../components/project/boardModel'
import { EMPTY_DOCS_FILTER, type DocsFilter } from '../components/project/docsModel'

// 프로젝트 화면(Jira 계층 보드) 상태. 데이터는 main 의 스냅샷 하나다 — 저장본(jiraBoard:cached)을 먼저
// 띄우고 Jira 동기화(jiraBoard:fetch) 결과로 교체한다 (docs/PROJECT_BOARD.md).
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

// 저장은 늘 savedFilter(사용자가 직접 정한 값)로 한다. 화면용 filter 에는 reveal 이 잠깐 푼 조건이 섞여 있을 수 있다
function writePrefs(s: Pick<JiraBoardState, 'savedFilter' | 'sort' | 'expanded'>): void {
  try {
    if (typeof localStorage === 'undefined') return
    const prefs: Prefs = {
      mineOnly: s.savedFilter.mineOnly,
      hideDone: s.savedFilter.hideDone,
      showPastDone: s.savedFilter.showPastDone,
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
  /** Jira 동기화 중. 저장본을 띄운 채 도는 동안에도 true 다(snapshot 은 그대로 둔다) */
  loading: boolean
  /** 마지막으로 성공한 동기화의 결과. 툴바 한 줄 표시에 쓴다 */
  lastSync: JiraBoardSyncInfo | null
  /** lastSync 를 받은 요청의 방식. 전체 다시 받기를 요청했는데 전체가 안 돈 경우를 알리는 데 쓴다 */
  lastSyncRequested: JiraBoardSyncMode | null
  /** "보드에서 보기"가 필터를 풀었을 때의 안내. 사용자가 필터를 만지거나 닫으면 지운다 */
  revealNotice: string | null
  error: string | null
  errorCode: JiraBoardErrorCode | null
  /** 화면에 적용 중인 필터 */
  filter: BoardFilter
  /**
   * 사용자가 직접 정한 필터. localStorage 에는 이 값만 쓴다.
   * "보드에서 보기"(revealIssue)는 filter 만 바꾸고 이 값은 두므로, 그 뒤 펼침·정렬을 바꿔도 푼 조건이 저장되지 않는다
   */
  savedFilter: BoardFilter
  sort: BoardSort
  /** 행 id → 펼침. 없으면 기본값(에픽 펼침, 하위작업 접힘) */
  expanded: Record<string, boolean>
  /** 상세 패널에 띄운 행 id */
  selectedKey: string | null
  aiSummaries: Record<string, JiraEpicAiSummary>
  aiLoading: Record<string, boolean>
  aiErrors: Record<string, string>
  /** 문서 탭 필터("내 담당만"은 filter.mineOnly 를 함께 쓴다) */
  docsFilter: DocsFilter

  /** 화면 진입: 저장본(cached)을 먼저 올리고 이어서 auto 동기화로 교체한다 */
  load: () => Promise<void>
  /** 새로고침(incremental) / 전체 다시 받기(full) */
  sync: (mode: 'incremental' | 'full') => Promise<void>
  summarizeEpic: (epicKey: string) => Promise<void>
  setFilter: (patch: Partial<BoardFilter>) => void
  clearFilter: () => void
  setSort: (sort: BoardSort) => void
  setExpanded: (id: string, expanded: boolean) => void
  setAllExpanded: (ids: string[], expanded: boolean) => void
  select: (key: string | null) => void
  dismissError: () => void
  setDocsFilter: (patch: Partial<DocsFilter>) => void
  dismissRevealNotice: () => void
  /**
   * 그 이슈를 선택하고 조상을 펼친다. 필터·"이전 완료 보기" 때문에 가려져 있으면 보이게 푼다.
   * 스냅샷에 없거나 트리에 그려질 수 없는 이슈(백로그 잎)면 아무것도 하지 않고 false.
   * 탭 전환은 하지 않는다 — 호출부가 navigationStore.openProjectsTab('tickets') 를 함께 부른다.
   */
  revealIssue: (key: string) => boolean
}

const prefs = readPrefs()
const initialFilter: BoardFilter = {
  ...DEFAULT_FILTER,
  mineOnly: prefs.mineOnly ?? DEFAULT_FILTER.mineOnly,
  hideDone: prefs.hideDone ?? DEFAULT_FILTER.hideDone,
  showPastDone: prefs.showPastDone ?? DEFAULT_FILTER.showPastDone
}

// 늦게 끝난 옛 요청이 새 결과를 덮지 않게 요청마다 번호를 붙인다
let loadSeq = 0

export const useJiraBoardStore = create<JiraBoardState>((set, get) => ({
  snapshot: null,
  loading: false,
  lastSync: null,
  lastSyncRequested: null,
  revealNotice: null,
  error: null,
  errorCode: null,
  filter: initialFilter,
  savedFilter: initialFilter,
  sort: prefs.sort ?? 'active',
  expanded: prefs.expanded ?? {},
  selectedKey: null,
  aiSummaries: {},
  aiLoading: {},
  aiErrors: {},
  docsFilter: { ...EMPTY_DOCS_FILTER },

  load: async () => {
    // 이미 도는 동기화가 있으면 겹쳐 부르지 않는다(메뉴 재진입마다 불린다)
    if (get().loading) return
    const seq = ++loadSeq
    set({ loading: true })
    // ① 저장본. DB만 읽으므로 빠르다. 있으면 첫 로딩 문구 없이 바로 그린다
    try {
      const cached = await window.api.jiraBoard.cached()
      if (seq !== loadSeq) return
      if (!cached.success) {
        if (cached.code) {
          // 미연결·기본 프로젝트 없음이면 Jira 를 부를 이유가 없다
          set({ loading: false, error: cached.error, errorCode: cached.code, snapshot: null })
          return
        }
        // 저장본 읽기 실패는 동기화로 메운다
      } else if (cached.snapshot) {
        set({ snapshot: cached.snapshot, errorCode: null })
      }
    } catch {
      if (seq !== loadSeq) return
    }
    // ② Jira 동기화(main 이 full / incremental / 생략을 고른다)
    await runFetch(seq, 'auto', set)
  },

  sync: async (mode) => {
    // 사용자가 누른 동기화는 앞선 요청을 대신한다. 늦게 온 옛 응답은 seq 로 버린다
    const seq = ++loadSeq
    set({ loading: true })
    await runFetch(seq, mode, set)
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
    // 사용자가 바꾼 키만 저장용에 반영한다 — reveal 이 푼 다른 조건까지 함께 저장되지 않게
    set((s) => ({
      filter: { ...s.filter, ...patch },
      savedFilter: { ...s.savedFilter, ...patch },
      revealNotice: null
    }))
    writePrefs(get())
  },

  clearFilter: () => {
    set({ filter: { ...EMPTY_FILTER }, savedFilter: { ...EMPTY_FILTER }, revealNotice: null })
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

  dismissError: () => set({ error: null }),

  setDocsFilter: (patch) => set((s) => ({ docsFilter: { ...s.docsFilter, ...patch } })),

  dismissRevealNotice: () => set({ revealNotice: null }),

  revealIssue: (key) => {
    const { snapshot, filter, expanded } = get()
    if (!snapshot || !isRevealable(snapshot.issues, key)) return false
    const issue = snapshot.issues.find((i) => i.key === key)!
    const today = localDate(new Date())
    const days = snapshot.recentDoneDays
    const my = snapshot.myAccountId
    const cleared: string[] = []
    let pastDoneOn = false
    let next = filter
    let forest = buildIssueForest(snapshot.issues, today, forestOptions(next, days))
    // 이전 완료 잎이라 숨겨졌으면 이전 완료를 보이게 한다
    if (!findIssue(forest, key)) {
      if (next.hideDone) cleared.push('완료 모두 숨김')
      pastDoneOn = !next.showPastDone || next.hideDone
      next = { ...next, hideDone: false, showPastDone: true }
      forest = buildIssueForest(snapshot.issues, today, forestOptions(next, days))
    }
    if (!findIssue(forest, key)) return false
    // 필터에 가려졌으면 그 이슈를 가리는 조건만 푼다
    if (!findIssue(filterForest(forest, next, my), key)) {
      const r = revealFilter(issue, next, my)
      next = r.filter
      cleared.push(...r.cleared)
      // 조건별로 풀어도 안 보이는 경우(있어선 안 되지만)만 전부 푼다
      if (!findIssue(filterForest(forest, next, my), key)) next = { ...EMPTY_FILTER, showPastDone: next.showPastDone }
    }
    const open = { ...expanded }
    const ancestors = ancestorIds(forest, key)
    for (const id of ancestors) open[id] = true
    // 조상만 펼쳐도 닫힘 묶음·닫힌 그룹 섹션 속에 숨어 있으면 그것도 연다. 보이면 사용자가 접어 둔 묶음은 그대로 둔다
    const rows = flattenVisible(filterForest(forest, next, my), open, { foldDone: shouldFoldDone(next) })
    if (!rows.some((r) => r.id === key)) {
      for (const id of ancestors) open[doneFoldId(id)] = true
      open[CLOSED_SECTION_ID] = true
    }
    const changed = next !== filter
    set({
      filter: next,
      expanded: open,
      selectedKey: key,
      revealNotice: changed ? revealMessage(key, cleared, pastDoneOn) : null
    })
    // reveal 은 화면용 filter 만 바꾼다. 저장은 savedFilter 그대로이고 펼침만 남는다
    writePrefs(get())
    return true
  }
}))

function revealMessage(key: string, cleared: string[], pastDoneOn: boolean): string {
  const parts: string[] = []
  if (cleared.length > 0) parts.push(`${cleared.map((c) => `'${c}'`).join('·')} 조건을 풀었어요`)
  if (pastDoneOn) parts.push("'이전 완료 보기'를 켰어요")
  return `${key}를 보여 주려고 ${parts.join(', ') || '필터를 바꿨어요'}. 이번에만 적용돼요`
}

/** 그 키를 보드 트리에서 보여 줄 수 있는가. 스냅샷이 바뀌면 다시 계산한다 */
export function useBoardHasIssue(key: string): boolean {
  return useJiraBoardStore((s) => (s.snapshot ? isRevealable(s.snapshot.issues, key) : false))
}

type SetState = (partial: Partial<JiraBoardState>) => void

async function runFetch(seq: number, mode: JiraBoardSyncMode, set: SetState): Promise<void> {
  try {
    const res = await window.api.jiraBoard.fetch(mode)
    if (seq !== loadSeq) return
    if (res.success) {
      set({
        snapshot: res.snapshot,
        lastSync: res.sync,
        lastSyncRequested: mode,
        loading: false,
        error: null,
        errorCode: null
      })
      return
    }
    const errorCode = res.code ?? null
    set({
      loading: false,
      error: res.error,
      errorCode,
      // 연결이 끊겼거나 기본 프로젝트가 없으면 옛 티켓을 계속 보여주지 않는다.
      // 그 밖의 실패는 저장본을 그대로 두고 오류만 띄운다
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
}

function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const next = { ...rec }
  delete next[key]
  return next
}
