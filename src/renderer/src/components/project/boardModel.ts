// Jira 계층 보드(프로젝트 화면)의 순수 모델.
// React·스토어·window 를 쓰지 않는다. 트리 구성·롤업·필터·정렬·평탄화·키보드 이동·요약 타일을 맡는다.
// 규칙의 근거는 docs/PROJECT_BOARD.md 와 리서치 메모(에픽 롤업 = 직계 자식 개수 기반)를 따른다.
import type { JiraBoardIssue } from '../../types'
import { releaseItemStatus } from '../ui/tokens'

export type StatusCategory = JiraBoardIssue['statusCategory']
export type IssueLevel = JiraBoardIssue['level']

// ─── 트리 구조 ─────────────────────────────────────────────

/** 상태 카테고리별 개수. 막대·롤업이 같은 모양을 쓴다 */
export interface CategoryCounts {
  new: number
  indeterminate: number
  done: number
}

export interface Rollup extends CategoryCounts {
  /** 분모. 조회 범위 안(inScope) 직계 자식 수 */
  total: number
  /** 완료가 아닌데 기한이 지난 직계 자식 수 */
  overdue: number
}

export interface BoardNode {
  issue: JiraBoardIssue
  /** 표준 이슈면 하위작업, 하위작업이면 빈 배열 */
  children: BoardNode[]
  /** 하위작업 진행(하위 2/3). 하위작업이 없으면 total 0 */
  rollup: Rollup
  /** 이전 완료라 숨긴 하위작업 수 */
  pastDoneCount: number
  /** 필터에 직접 맞았는가. false 면 맞은 자손 때문에 남은 조상이라 흐리게 그린다 */
  matched: boolean
}

/**
 * - epic: 스냅샷에 있는 에픽(범위 밖 에픽도 자식이 보이면 그린다)
 * - missingEpic: 부모 에픽이 스냅샷에 없는 자식을 parentSummary 로 묶은 가상 그룹
 * - noEpic: 에픽 없는 스토리·작업·버그
 * - orphanSubtasks: 상위가 스냅샷에 없는 하위작업
 */
export type GroupKind = 'epic' | 'missingEpic' | 'noEpic' | 'orphanSubtasks'

export interface EpicGroup {
  /** 행 id. 에픽이면 키, 가상 그룹이면 접두사가 붙은 id */
  id: string
  kind: GroupKind
  epic: JiraBoardIssue | null
  /** 에픽 키(가상 에픽이면 부모 키). 고아 그룹은 null */
  epicKey: string | null
  title: string
  children: BoardNode[]
  rollup: Rollup
  /** 범위 밖(백로그)이라 숨긴 직계 자식 수 */
  backlogCount: number
  /** 이전 완료라 숨긴 직계 자식 수 */
  pastDoneCount: number
  matched: boolean
}

export interface BoardForest {
  groups: EpicGroup[]
}

export const NO_EPIC_ID = 'group:no-epic'
export const ORPHAN_SUBTASKS_ID = 'group:orphan-subtasks'
export const missingEpicId = (parentKey: string): string => `group:missing:${parentKey}`

// ─── 날짜·키 도우미 ─────────────────────────────────────────

/** 기한이 오늘보다 앞이고 아직 끝나지 않았는가. today 는 YYYY-MM-DD */
export function isOverdue(
  issue: Pick<JiraBoardIssue, 'duedate' | 'statusCategory'>,
  today: string
): boolean {
  return issue.statusCategory !== 'done' && !!issue.duedate && issue.duedate < today
}

const KEY_RE = /^(.*?)-(\d+)$/

/** 이슈 키를 숫자 순으로 비교한다. 문자열 비교면 PROJ-10 이 PROJ-9 보다 앞선다 */
export function compareIssueKeys(a: string, b: string): number {
  const ma = KEY_RE.exec(a)
  const mb = KEY_RE.exec(b)
  if (!ma || !mb) return a < b ? -1 : a > b ? 1 : 0
  if (ma[1] !== mb[1]) return ma[1] < mb[1] ? -1 : 1
  return Number(ma[2]) - Number(mb[2])
}

/** 'YYYY-MM-DD' 에서 n 일을 뺀 날짜 */
function shiftDate(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + delta))
  return t.toISOString().slice(0, 10)
}

/** 완료로 본 날짜(로컬 YYYY-MM-DD). resolvedAt 이 없으면 updated 로 대신한다 */
function completedDay(issue: Pick<JiraBoardIssue, 'resolvedAt' | 'updated'>): string | null {
  const iso = issue.resolvedAt ?? issue.updated
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : localDate(d)
}

/**
 * 최근 완료인가: done 이고 완료 시각이 recentDoneDays 일 이내.
 * 스냅샷에는 에픽 롤업용으로 가져온 오래전 완료 자식도 섞여 있어 done 만으로는 '최근'을 셀 수 없다.
 */
export function isRecentDone(
  issue: Pick<JiraBoardIssue, 'statusCategory' | 'resolvedAt' | 'updated'>,
  today: string,
  recentDoneDays: number
): boolean {
  if (issue.statusCategory !== 'done') return false
  const day = completedDay(issue)
  return day !== null && day >= shiftDate(today, -recentDoneDays)
}

/** 이전 완료인가: done 인데 최근 완료 기간보다 오래됐다 */
export function isPastDone(
  issue: Pick<JiraBoardIssue, 'statusCategory' | 'resolvedAt' | 'updated'>,
  today: string,
  recentDoneDays: number
): boolean {
  return issue.statusCategory === 'done' && !isRecentDone(issue, today, recentDoneDays)
}

// ─── 롤업 ─────────────────────────────────────────────────

const emptyRollup = (): Rollup => ({ total: 0, new: 0, indeterminate: 0, done: 0, overdue: 0 })

/**
 * 직계 자식의 진행 집계. 분모는 inScope 자식만 센다(백로그 제외).
 * 하위작업은 호출부가 넘기지 않는다 — 잘게 쪼갠 스토리가 에픽 진행률을 왜곡하지 않게 한다.
 */
export function rollupChildren(children: JiraBoardIssue[], today: string): Rollup {
  const r = emptyRollup()
  for (const c of children) {
    if (!c.inScope) continue
    r.total += 1
    r[normalizeCategory(c.statusCategory)] += 1
    if (isOverdue(c, today)) r.overdue += 1
  }
  return r
}

function normalizeCategory(c: string): StatusCategory {
  return c === 'done' || c === 'indeterminate' ? c : 'new'
}

// ─── 트리 구성 ─────────────────────────────────────────────

export interface ForestOptions {
  /** 최근 완료로 보는 기간(일). 스냅샷의 recentDoneDays */
  recentDoneDays: number
  /** 이전 완료 잎도 그린다(툴바 "이전 완료 보기") */
  showPastDone: boolean
}

/** 필터에서 트리 구성 옵션을 만든다. 완료 숨김이 켜져 있으면 이전 완료 보기는 무시한다 */
export function forestOptions(f: BoardFilter, recentDoneDays: number): ForestOptions {
  return { recentDoneDays, showPastDone: f.showPastDone && !f.hideDone }
}

const DEFAULT_FOREST_OPTIONS: ForestOptions = { recentDoneDays: 14, showPastDone: false }

/**
 * 스냅샷 이슈를 에픽 그룹 트리로 묶는다.
 * - 화면은 inScope 이슈와 그 조상만 그린다. 범위 밖 잎(백로그 자식)은 숨기고 backlogCount 로만 센다.
 * - 이전 완료 잎도 기본은 숨기고 pastDoneCount 로 센다. 오래 끈 에픽의 옛 완료 자식이 트리를 덮지 않게 한다.
 *   보이는 자손이 있으면 조상으로 남는다. 롤업은 숨김과 무관하게 전체(이전 완료 포함)로 센다.
 * - 계층은 level 로 고정 3단이다(에픽 → 표준 → 하위작업). 그래서 parent 체인 순환이 트리에 생길 수 없다.
 *   자기 참조·레벨이 맞지 않는 부모는 부모가 없는 것으로 다룬다.
 * - 같은 키가 두 번 오면 처음 것만 쓴다.
 */
export function buildIssueForest(
  issues: JiraBoardIssue[],
  today: string,
  options: Partial<ForestOptions> = {}
): BoardForest {
  const { recentDoneDays, showPastDone } = { ...DEFAULT_FOREST_OPTIONS, ...options }
  const byKey = new Map<string, JiraBoardIssue>()
  for (const i of issues) if (!byKey.has(i.key)) byKey.set(i.key, i)
  const all = [...byKey.values()]

  const parentOf = (i: JiraBoardIssue): JiraBoardIssue | null => {
    if (!i.parentKey || i.parentKey === i.key) return null
    return byKey.get(i.parentKey) ?? null
  }
  // 잎으로서 그릴 만한가. 아니면 왜 숨겼는지(백로그/이전 완료)를 돌려준다
  const hiddenReason = (i: JiraBoardIssue): 'backlog' | 'pastDone' | null => {
    if (!i.inScope) return 'backlog'
    if (!showPastDone && isPastDone(i, today, recentDoneDays)) return 'pastDone'
    return null
  }

  // 1) 표준 이슈 노드와 하위작업 배치
  const standardNodes = new Map<string, BoardNode>()
  for (const i of all) {
    if (i.level === 'standard') standardNodes.set(i.key, leaf(i))
  }
  const epicDirectSubtasks = new Map<string, JiraBoardIssue[]>()
  const orphanSubtasks: JiraBoardIssue[] = []
  for (const i of all) {
    if (i.level !== 'subtask') continue
    const p = parentOf(i)
    if (p && p.level === 'standard') {
      standardNodes.get(p.key)!.children.push(leaf(i))
    } else if (p && p.level === 'epic') {
      const list = epicDirectSubtasks.get(p.key) ?? []
      list.push(i)
      epicDirectSubtasks.set(p.key, list)
    } else {
      orphanSubtasks.push(i)
    }
  }
  // 하위 진행은 전체로 센 뒤, 숨길 하위작업을 걸러 낸다
  for (const n of standardNodes.values()) {
    n.rollup = rollupChildren(
      n.children.map((c) => c.issue),
      today
    )
    n.pastDoneCount = n.children.filter((c) => hiddenReason(c.issue) === 'pastDone').length
    n.children = n.children.filter((c) => hiddenReason(c.issue) === null)
  }

  // 2) 에픽·가상 그룹 배치
  const epicChildren = new Map<string, JiraBoardIssue[]>() // 롤업용 원본(숨긴 것 포함)
  const missing = new Map<string, { summary: string; items: JiraBoardIssue[] }>()
  const noEpic: JiraBoardIssue[] = []
  const pushTo = (m: Map<string, JiraBoardIssue[]>, k: string, i: JiraBoardIssue): void => {
    const list = m.get(k) ?? []
    list.push(i)
    m.set(k, list)
  }
  for (const i of all) {
    if (i.level !== 'standard') continue
    const p = parentOf(i)
    if (p && p.level === 'epic') pushTo(epicChildren, p.key, i)
    else if (!p && i.parentKey && i.parentKey !== i.key && !byKey.has(i.parentKey) && i.parentSummary) {
      const g = missing.get(i.parentKey) ?? { summary: i.parentSummary, items: [] }
      g.items.push(i)
      missing.set(i.parentKey, g)
    } else noEpic.push(i)
  }
  for (const [epicKey, subs] of epicDirectSubtasks) for (const s of subs) pushTo(epicChildren, epicKey, s)

  // 보이는 자손이 있으면 자신이 숨김 대상이어도 조상으로 남는다
  const toNodes = (items: JiraBoardIssue[]): { nodes: BoardNode[]; backlog: number; pastDone: number } => {
    const nodes: BoardNode[] = []
    let backlog = 0
    let pastDone = 0
    for (const i of items) {
      const n = i.level === 'standard' ? standardNodes.get(i.key)! : leaf(i)
      const reason = hiddenReason(i)
      if (reason === null || n.children.length > 0) nodes.push(n)
      else if (reason === 'backlog') backlog += 1
      else pastDone += 1
    }
    return { nodes, backlog, pastDone }
  }

  const groups: EpicGroup[] = []
  const pushGroup = (
    base: Pick<EpicGroup, 'id' | 'kind' | 'epic' | 'epicKey' | 'title'>,
    raw: JiraBoardIssue[],
    t: { nodes: BoardNode[]; backlog: number; pastDone: number }
  ): void => {
    groups.push({
      ...base,
      children: t.nodes,
      rollup: rollupChildren(raw, today),
      backlogCount: t.backlog,
      pastDoneCount: t.pastDone,
      matched: true
    })
  }
  for (const e of all) {
    if (e.level !== 'epic') continue
    const raw = epicChildren.get(e.key) ?? []
    const t = toNodes(raw)
    // 범위 밖·이전 완료 에픽은 보이는 자손이 있을 때만 그린다
    if (hiddenReason(e) !== null && t.nodes.length === 0) continue
    pushGroup({ id: e.key, kind: 'epic', epic: e, epicKey: e.key, title: e.summary }, raw, t)
  }
  for (const [parentKey, g] of missing) {
    const t = toNodes(g.items)
    if (t.nodes.length === 0) continue
    pushGroup(
      { id: missingEpicId(parentKey), kind: 'missingEpic', epic: null, epicKey: parentKey, title: g.summary },
      g.items,
      t
    )
  }
  const noEpicT = toNodes(noEpic)
  if (noEpicT.nodes.length > 0) {
    pushGroup({ id: NO_EPIC_ID, kind: 'noEpic', epic: null, epicKey: null, title: '에픽 없음' }, noEpic, noEpicT)
  }
  const orphanT = toNodes(orphanSubtasks)
  if (orphanT.nodes.length > 0) {
    pushGroup(
      { id: ORPHAN_SUBTASKS_ID, kind: 'orphanSubtasks', epic: null, epicKey: null, title: '상위가 범위 밖인 하위작업' },
      orphanSubtasks,
      orphanT
    )
  }
  return { groups }
}

function leaf(i: JiraBoardIssue): BoardNode {
  return { issue: i, children: [], rollup: emptyRollup(), pastDoneCount: 0, matched: true }
}

/** 행 id 로 그 행의 이슈를 찾는다(가상 그룹은 null) */
export function findIssue(forest: BoardForest, id: string): JiraBoardIssue | null {
  for (const g of forest.groups) {
    if (g.id === id) return g.epic
    for (const c of g.children) {
      if (c.issue.key === id) return c.issue
      for (const s of c.children) if (s.issue.key === id) return s.issue
    }
  }
  return null
}

export interface DetailTarget {
  id: string
  /** 행의 이슈. 가상 그룹이면 null */
  issue: JiraBoardIssue | null
  /** 그룹 행이면 그 그룹 */
  group: EpicGroup | null
  /** 자식·하위작업 행이면 그 노드 */
  node: BoardNode | null
  /** 상세에 늘어놓을 하위 항목(그룹이면 직계 자식, 표준이면 하위작업) */
  children: BoardNode[]
  parentKey: string | null
  parentSummary: string | null
  /** 하위 목록에서 숨긴 수(백로그 / 이전 완료) */
  hiddenBacklog: number
  hiddenPastDone: number
}

/** 상세 패널 대상. 필터 전 트리를 넘겨야 하위 목록이 빠짐없이 나온다 */
export function detailTarget(forest: BoardForest, id: string | null): DetailTarget | null {
  if (!id) return null
  for (const g of forest.groups) {
    if (g.id === id) {
      return {
        id,
        issue: g.epic,
        group: g,
        node: null,
        children: g.children,
        parentKey: null,
        parentSummary: null,
        hiddenBacklog: g.backlogCount,
        hiddenPastDone: g.pastDoneCount
      }
    }
    const parentOfChild = g.epic ? { key: g.epic.key, summary: g.epic.summary } : null
    for (const c of g.children) {
      if (c.issue.key === id) {
        return {
          id,
          issue: c.issue,
          group: null,
          node: c,
          children: c.children,
          parentKey: parentOfChild?.key ?? c.issue.parentKey,
          parentSummary: parentOfChild?.summary ?? c.issue.parentSummary,
          hiddenBacklog: 0,
          hiddenPastDone: c.pastDoneCount
        }
      }
      for (const s of c.children) {
        if (s.issue.key === id) {
          return {
            id,
            issue: s.issue,
            group: null,
            node: s,
            children: [],
            parentKey: c.issue.key,
            parentSummary: c.issue.summary,
            hiddenBacklog: 0,
            hiddenPastDone: 0
          }
        }
      }
    }
  }
  return null
}

/** 행 id 의 조상 id 목록(가까운 순). 없으면 빈 배열 */
export function ancestorIds(forest: BoardForest, id: string): string[] {
  for (const g of forest.groups) {
    if (g.id === id) return []
    for (const c of g.children) {
      if (c.issue.key === id) return [g.id]
      for (const s of c.children) if (s.issue.key === id) return [c.issue.key, g.id]
    }
  }
  return []
}

// ─── 필터 ─────────────────────────────────────────────────

/** 릴리스 필터의 "릴리스 없음" 값. 실제 버전 이름과 겹치지 않게 공백으로 시작한다 */
export const NO_RELEASE = ' none'

export interface BoardFilter {
  query: string
  /** 비면 전체 */
  categories: StatusCategory[]
  /** 세부 상태명. 비면 전체 */
  statuses: string[]
  /** 이슈 유형 표시 이름. 비면 전체 */
  types: string[]
  /** fixVersion 이름. NO_RELEASE 는 "릴리스 없음". 비면 전체 */
  releases: string[]
  mineOnly: boolean
  /** 완료(최근 완료 포함)를 모두 숨긴다 */
  hideDone: boolean
  /**
   * 이전 완료(최근 완료 기간보다 오래된 완료) 잎도 그린다. 결과를 넓히는 표시 옵션이라
   * 필터 활성 판정·칩에는 넣지 않는다. hideDone 이 켜져 있으면 의미가 없다.
   */
  showPastDone: boolean
}

export const DEFAULT_FILTER: BoardFilter = {
  query: '',
  categories: [],
  statuses: [],
  types: [],
  releases: [],
  mineOnly: true,
  hideDone: false,
  showPastDone: false
}

export const EMPTY_FILTER: BoardFilter = { ...DEFAULT_FILTER, mineOnly: false }

/** 결과를 좁히는 조건이 하나라도 켜졌는가 */
export function isFilterActive(f: BoardFilter, myAccountId: string | null): boolean {
  return (
    f.query.trim() !== '' ||
    f.categories.length > 0 ||
    f.statuses.length > 0 ||
    f.types.length > 0 ||
    f.releases.length > 0 ||
    f.hideDone ||
    (f.mineOnly && !!myAccountId)
  )
}

const queryTokens = (q: string): string[] => q.trim().toLowerCase().split(/\s+/).filter(Boolean)

/**
 * 이슈 하나가 조건에 맞는가.
 * 검색은 키·제목을 대소문자 없이 보고, 공백으로 나눈 토큰은 모두 만족해야 한다.
 * 내 계정 id 를 모르면 "내 담당만"은 무시한다 — 화면이 통째로 비면 원인을 알 수 없다.
 */
export function matchesFilter(
  issue: JiraBoardIssue,
  f: BoardFilter,
  myAccountId: string | null
): boolean {
  const tokens = queryTokens(f.query)
  if (tokens.length > 0) {
    const hay = `${issue.key} ${issue.summary}`.toLowerCase()
    if (!tokens.every((t) => hay.includes(t))) return false
  }
  const cat = normalizeCategory(issue.statusCategory)
  if (f.categories.length > 0 && !f.categories.includes(cat)) return false
  if (f.statuses.length > 0 && !f.statuses.includes(issue.status)) return false
  if (f.types.length > 0 && !f.types.includes(issue.issueType)) return false
  if (f.releases.length > 0) {
    const names = (issue.fixVersions ?? []).map((v) => v.name)
    const hit =
      names.length === 0 ? f.releases.includes(NO_RELEASE) : names.some((n) => f.releases.includes(n))
    if (!hit) return false
  }
  if (f.hideDone && cat === 'done') return false
  if (f.mineOnly && myAccountId && issue.assigneeAccountId !== myAccountId) return false
  return true
}

/**
 * 트리를 조건으로 가지친다. 맞은 항목의 조상은 맥락으로 남기고 matched=false 로 표시한다.
 * 롤업은 필터 전 값을 그대로 둔다(막대가 필터에 따라 출렁이지 않게).
 * 범위 밖 조상(inScope=false)은 그 자체로 맞았다고 보지 않는다 — 자손 때문에 그려질 뿐이다.
 */
export function filterForest(
  forest: BoardForest,
  f: BoardFilter,
  myAccountId: string | null
): BoardForest {
  const hit = (i: JiraBoardIssue): boolean => i.inScope && matchesFilter(i, f, myAccountId)
  const groups: EpicGroup[] = []
  for (const g of forest.groups) {
    const children: BoardNode[] = []
    for (const c of g.children) {
      const subs = c.children.filter((s) => hit(s.issue)).map((s) => ({ ...s, matched: true }))
      const matched = hit(c.issue)
      if (matched || subs.length > 0) children.push({ ...c, children: subs, matched })
    }
    const matched = g.epic ? hit(g.epic) : false
    if (matched || children.length > 0) groups.push({ ...g, children, matched })
  }
  return { groups }
}

/**
 * 필터 중 자동으로 펼칠 행 id.
 * - 맞지 않았지만 자손 때문에 남은 조상(흐린 행)은 늘 펼친다 — 접혀 있으면 왜 남았는지 안 보인다.
 * - 검색어가 있으면 맞은 항목의 조상도 펼친다.
 */
export function autoExpandIds(filtered: BoardForest, query: string): Set<string> {
  const ids = new Set<string>()
  const searching = query.trim() !== ''
  for (const g of filtered.groups) {
    for (const c of g.children) {
      const subHit = c.children.some((s) => s.matched)
      if (subHit && (!c.matched || searching)) ids.add(c.issue.key)
      if (c.matched || subHit) {
        if (!g.matched || searching) ids.add(g.id)
      }
    }
  }
  return ids
}

/**
 * 사용자가 정한 펼침 상태와 자동 펼침을 합친다.
 * 검색 중에는 자동 펼침이 이긴다(찾은 항목이 접힌 조상 밑에 숨으면 안 된다).
 * 그 밖의 필터에서는 자동 펼침이 기본값일 뿐이라 사용자가 접은 행은 접힌 채 둔다.
 */
export function effectiveExpanded(
  expanded: Record<string, boolean>,
  auto: Set<string>,
  query: string
): Record<string, boolean> {
  const autoRec: Record<string, boolean> = {}
  for (const id of auto) autoRec[id] = true
  return query.trim() !== '' ? { ...expanded, ...autoRec } : { ...autoRec, ...expanded }
}

// ─── 정렬 ─────────────────────────────────────────────────

export type BoardSort = 'active' | 'key' | 'updated' | 'due'

export const SORT_LABELS: Record<BoardSort, string> = {
  active: '진행 중 많은 순',
  key: '키 순',
  updated: '최근 업데이트 순',
  due: '기한 임박 순'
}

const CATEGORY_ORDER: Record<StatusCategory, number> = { indeterminate: 0, new: 1, done: 2 }

/** 그룹 안 자식: 진행 → 할 일 → 완료, 같으면 키 숫자 순 */
export function sortChildren(nodes: BoardNode[]): BoardNode[] {
  return [...nodes]
    .sort(
      (a, b) =>
        CATEGORY_ORDER[normalizeCategory(a.issue.statusCategory)] -
          CATEGORY_ORDER[normalizeCategory(b.issue.statusCategory)] ||
        compareIssueKeys(a.issue.key, b.issue.key)
    )
    .map((n) => (n.children.length > 1 ? { ...n, children: sortChildren(n.children) } : n))
}

const GROUP_KIND_ORDER: Record<GroupKind, number> = {
  epic: 0,
  missingEpic: 1,
  noEpic: 2,
  orphanSubtasks: 3
}

const latestUpdated = (g: EpicGroup): string =>
  [g.epic?.updated ?? '', ...g.children.map((c) => c.issue.updated)].reduce(
    (a, b) => (b > a ? b : a),
    ''
  )

const earliestDue = (g: EpicGroup): string | null => {
  const dates = [g.epic, ...g.children.map((c) => c.issue)]
    .filter((i): i is JiraBoardIssue => !!i && i.statusCategory !== 'done' && !!i.duedate)
    .map((i) => i.duedate as string)
  return dates.length ? dates.reduce((a, b) => (b < a ? b : a)) : null
}

/**
 * 에픽 그룹 정렬. 고아 그룹(가상 에픽 → 에픽 없음 → 상위 범위 밖 하위작업)은 늘 아래다.
 * 동률은 키 숫자 순이다.
 */
export function sortGroups(groups: EpicGroup[], sort: BoardSort): EpicGroup[] {
  const byKey = (a: EpicGroup, b: EpicGroup): number =>
    compareIssueKeys(a.epicKey ?? a.id, b.epicKey ?? b.id)
  const primary = (a: EpicGroup, b: EpicGroup): number => {
    switch (sort) {
      case 'active':
        return b.rollup.indeterminate - a.rollup.indeterminate
      case 'updated': {
        const ua = latestUpdated(a)
        const ub = latestUpdated(b)
        return ua === ub ? 0 : ua > ub ? -1 : 1
      }
      case 'due': {
        const da = earliestDue(a)
        const db = earliestDue(b)
        if (da === db) return 0
        if (da === null) return 1
        if (db === null) return -1
        return da < db ? -1 : 1
      }
      default:
        return 0
    }
  }
  return [...groups]
    .sort((a, b) => GROUP_KIND_ORDER[a.kind] - GROUP_KIND_ORDER[b.kind] || primary(a, b) || byKey(a, b))
    .map((g) => ({ ...g, children: sortChildren(g.children) }))
}

// ─── 보이는 행 평탄화 ─────────────────────────────────────────

/** 닫힌 상위 티켓(에픽)을 모은 섹션 행 id */
export const CLOSED_SECTION_ID = 'fold:closed-groups'
/** 한 부모 안의 닫힘(done) 자식 묶음 행 id */
export const doneFoldId = (parentId: string): string => `fold:done:${parentId}`

export interface FoldInfo {
  /** closedGroups: 닫힌 상위 티켓 섹션, done: 한 부모 안의 닫힘 묶음 */
  scope: 'closedGroups' | 'done'
  count: number
}

export interface VisibleRow {
  id: string
  kind: 'group' | 'issue' | 'fold'
  /** aria-level: 그룹 1, 자식 2, 하위작업 3. 묶음 행은 묶인 항목과 같은 레벨 */
  level: 1 | 2 | 3
  posinset: number
  setsize: number
  parentId: string | null
  hasChildren: boolean
  expanded: boolean
  group?: EpicGroup
  node?: BoardNode
  /** kind==='fold' 일 때만 */
  fold?: FoldInfo
}

export interface FlattenOptions {
  /** 닫힘 항목을 묶어 기본 접힘으로 보인다 */
  foldDone: boolean
}

/** 펼침 기본값: 에픽 그룹은 펼침, 하위작업을 가진 자식은 접힘 */
export function isExpanded(
  expanded: Record<string, boolean>,
  id: string,
  kind: 'group' | 'issue'
): boolean {
  return expanded[id] ?? kind === 'group'
}

/**
 * 닫힘 묶음을 쓸 필터인가. 검색어·상태 분류·세부 상태·유형·릴리스 필터가 모두 비어 있을 때만 —
 * 찾으려고 거른 결과가 묶음 속에 숨지 않게 한다. 내 담당만·완료 숨김·이전 완료 보기는 묶음을 유지한다.
 */
export function shouldFoldDone(f: BoardFilter): boolean {
  return (
    f.query.trim() === '' &&
    f.categories.length === 0 &&
    f.statuses.length === 0 &&
    f.types.length === 0 &&
    f.releases.length === 0
  )
}

/** 닫힘 묶음 대상: 자신이 완료이고 보이는 하위작업도 모두 완료. 열린 하위작업이 묶음 속에 숨지 않게 한다 */
const isDoneNode = (n: BoardNode): boolean =>
  normalizeCategory(n.issue.statusCategory) === 'done' && n.children.every(isDoneNode)

/** 닫힌 그룹: 완료된 에픽이고 자식이 모두 닫힘 묶음 대상이다(자식 0개 포함) */
const isClosedGroup = (g: EpicGroup): boolean =>
  g.kind === 'epic' && g.epic?.statusCategory === 'done' && g.children.every(isDoneNode)

/**
 * 접힌 자식은 빼고 화면 순서대로 늘어놓는다. aria 값도 여기서 정한다.
 * foldDone 이면 닫힌 그룹은 맨 아래 섹션 행으로, 한 부모 안의 닫힘 자식(2개 이상)은 묶음 행으로 모은다.
 * 둘 다 기본 접힘이고, 열린 항목이 하나도 없으면 묶지 않는다.
 */
export function flattenVisible(
  forest: BoardForest,
  expanded: Record<string, boolean>,
  options: Partial<FlattenOptions> = {}
): VisibleRow[] {
  const foldDone = options.foldDone ?? true
  const rows: VisibleRow[] = []

  const pushFold = (
    id: string,
    level: 1 | 2 | 3,
    posinset: number,
    parentId: string | null,
    scope: FoldInfo['scope'],
    count: number
  ): boolean => {
    const open = expanded[id] ?? false
    rows.push({
      id,
      kind: 'fold',
      level,
      posinset,
      setsize: posinset,
      parentId,
      hasChildren: true,
      expanded: open,
      fold: { scope, count }
    })
    return open
  }

  const emitNode = (n: BoardNode, level: 2 | 3, posinset: number, setsize: number, parentId: string): void => {
    // 하위작업 행은 자식을 갖지 않는다
    const hasChildren = level === 2 && n.children.length > 0
    const open = hasChildren && isExpanded(expanded, n.issue.key, 'issue')
    rows.push({
      id: n.issue.key,
      kind: 'issue',
      level,
      posinset,
      setsize,
      parentId,
      hasChildren,
      expanded: open,
      node: n
    })
    if (open) emitChildren(n.children, n.issue.key, 3)
  }

  // 한 부모의 자식들. 닫힘이 2개 이상이고 열린 자식이 있으면 열린 것 뒤에 묶음 행을 둔다
  const emitChildren = (nodes: BoardNode[], parentId: string, level: 2 | 3): void => {
    const done = foldDone ? nodes.filter(isDoneNode) : []
    if (done.length < 2 || done.length === nodes.length) {
      nodes.forEach((n, i) => emitNode(n, level, i + 1, nodes.length, parentId))
      return
    }
    const rest = nodes.filter((n) => !isDoneNode(n))
    const size = rest.length + 1
    rest.forEach((n, i) => emitNode(n, level, i + 1, size, parentId))
    const foldId = doneFoldId(parentId)
    if (pushFold(foldId, level, size, parentId, 'done', done.length)) {
      done.forEach((n, i) => emitNode(n, level, i + 1, done.length, foldId))
    }
  }

  const emitGroup = (g: EpicGroup, posinset: number, setsize: number, parentId: string | null): void => {
    const hasChildren = g.children.length > 0
    // 닫힌 그룹은 기본 접힘
    const def = foldDone && isClosedGroup(g) ? (expanded[g.id] ?? false) : isExpanded(expanded, g.id, 'group')
    const open = hasChildren && def
    rows.push({
      id: g.id,
      kind: 'group',
      level: 1,
      posinset,
      setsize,
      parentId,
      hasChildren,
      expanded: open,
      group: g
    })
    if (open) emitChildren(g.children, g.id, 2)
  }

  const gs = forest.groups
  const closed = foldDone ? gs.filter(isClosedGroup) : []
  if (closed.length === 0 || closed.length === gs.length) {
    gs.forEach((g, i) => emitGroup(g, i + 1, gs.length, null))
    return rows
  }
  const rest = gs.filter((g) => !isClosedGroup(g))
  const size = rest.length + 1
  rest.forEach((g, i) => emitGroup(g, i + 1, size, null))
  if (pushFold(CLOSED_SECTION_ID, 1, size, null, 'closedGroups', closed.length)) {
    closed.forEach((g, i) => emitGroup(g, i + 1, closed.length, CLOSED_SECTION_ID))
  }
  return rows
}

/** 펼칠 수 있는 모든 행 id (모두 펼치기/접기용). 닫힘 묶음·닫힌 그룹 섹션도 함께 여닫는다 */
export function expandableIds(forest: BoardForest): string[] {
  const ids: string[] = []
  for (const g of forest.groups) {
    if (g.children.length > 0) ids.push(g.id, doneFoldId(g.id))
    for (const c of g.children) if (c.children.length > 0) ids.push(c.issue.key, doneFoldId(c.issue.key))
  }
  ids.push(CLOSED_SECTION_ID)
  return ids
}

// ─── 키보드 포커스 이동 (WAI-ARIA APG treegrid) ───────────────────

export interface FocusMove {
  focusId: string | null
  /** 펼침 상태를 바꿔야 하면 대상과 새 값 */
  toggle?: { id: string; expanded: boolean }
}

/**
 * ↑/↓ 보이는 행 이동(끝에서 멈춤), Home/End,
 * → 접힌 행은 펼침·펼친 행은 첫 자식으로, ← 펼친 행은 접기·아니면 부모로.
 * 다룰 수 없는 키는 null 을 돌려준다.
 */
export function nextFocus(rows: VisibleRow[], currentId: string | null, key: string): FocusMove | null {
  if (rows.length === 0) return { focusId: null }
  const idx = currentId === null ? -1 : rows.findIndex((r) => r.id === currentId)
  if (idx < 0) {
    return ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(key)
      ? { focusId: key === 'End' ? rows[rows.length - 1].id : rows[0].id }
      : null
  }
  const row = rows[idx]
  switch (key) {
    case 'ArrowDown':
      return { focusId: rows[Math.min(idx + 1, rows.length - 1)].id }
    case 'ArrowUp':
      return { focusId: rows[Math.max(idx - 1, 0)].id }
    case 'Home':
      return { focusId: rows[0].id }
    case 'End':
      return { focusId: rows[rows.length - 1].id }
    case 'ArrowRight':
      if (!row.hasChildren) return { focusId: row.id }
      if (!row.expanded) return { focusId: row.id, toggle: { id: row.id, expanded: true } }
      return { focusId: rows[idx + 1]?.parentId === row.id ? rows[idx + 1].id : row.id }
    case 'ArrowLeft':
      if (row.hasChildren && row.expanded) {
        return { focusId: row.id, toggle: { id: row.id, expanded: false } }
      }
      return { focusId: row.parentId ?? row.id }
    default:
      return null
  }
}

export type TreeKeyAction =
  | { kind: 'select'; id: string }
  | { kind: 'open'; key: string }
  | { kind: 'move'; move: FocusMove }

/**
 * 키 이벤트가 트리 행 자체에서 왔는가. 행 안의 버튼·인라인 상세의 버튼에서 온 키는
 * 트리가 가로채면 안 된다 — Enter 가 버튼 대신 행 선택으로 먹힌다.
 */
export function isTreeRowTarget(target: unknown): boolean {
  const el = target as { getAttribute?: (name: string) => string | null } | null
  return typeof el?.getAttribute === 'function' && el.getAttribute('role') === 'row'
}

/**
 * treegrid 키 입력을 동작으로 바꾼다. 행에서 온 키가 아니면 null(브라우저 기본 동작에 맡김).
 * Enter 상세 선택(묶음 행은 여닫기), ⌘/Ctrl+Enter·o Jira 열기, 나머지는 nextFocus.
 */
export function treeKeyAction(
  rows: VisibleRow[],
  activeId: string | null,
  e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
  fromRow: boolean
): TreeKeyAction | null {
  if (!fromRow) return null
  if (e.key === 'Enter' || e.key === 'o') {
    if (e.altKey || (e.key === 'o' && (e.metaKey || e.ctrlKey))) return null
    const current = rows.find((r) => r.id === activeId)
    if (!current) return null
    // 묶음 행: Enter 는 여닫기, Jira 열기는 없다
    if (current.kind === 'fold') {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey) return null
      return { kind: 'move', move: { focusId: current.id, toggle: { id: current.id, expanded: !current.expanded } } }
    }
    if (e.key === 'o' || e.metaKey || e.ctrlKey) {
      const key = current.group?.epicKey ?? current.node?.issue.key ?? null
      return key ? { kind: 'open', key } : null
    }
    return { kind: 'select', id: current.id }
  }
  const move = nextFocus(rows, activeId, e.key)
  return move ? { kind: 'move', move } : null
}

/** 행 id 의 그룹 또는 노드 */
function findRowItem(forest: BoardForest, id: string): { group?: EpicGroup; node?: BoardNode } | null {
  for (const g of forest.groups) {
    if (g.id === id) return { group: g }
    for (const c of g.children) {
      if (c.issue.key === id) return { node: c }
      for (const s of c.children) if (s.issue.key === id) return { node: s }
    }
  }
  return null
}

/**
 * 포커스된 행이 사라졌을 때(부모가 접힘·필터) 남아 있는 가장 가까운 조상으로, 그것도 없으면 첫 행으로 옮긴다.
 * 닫힘 묶음 대상이면 그것을 감싼 묶음 행을 부모보다 먼저 본다. 닫힌 그룹 안이면 마지막으로 닫힌 그룹 섹션 행을 본다.
 */
export function resolveFocus(
  rows: VisibleRow[],
  focusId: string | null,
  forest: BoardForest
): string | null {
  if (rows.length === 0) return null
  if (focusId && rows.some((r) => r.id === focusId)) return focusId
  if (focusId) {
    const candidates: string[] = []
    const ancestors = ancestorIds(forest, focusId)
    // 각 조상 바로 아래 항목(대상 → 부모 → …)이 닫힘 대상이면 그 조상의 묶음 행이 먼저다
    let below = findRowItem(forest, focusId)
    for (const a of ancestors) {
      if (below?.node && isDoneNode(below.node)) candidates.push(doneFoldId(a))
      candidates.push(a)
      below = findRowItem(forest, a)
    }
    if (below?.group && isClosedGroup(below.group)) candidates.push(CLOSED_SECTION_ID)
    for (const id of candidates) if (rows.some((r) => r.id === id)) return id
  }
  return rows[0].id
}

// ─── 요약 타일 ─────────────────────────────────────────────

export type BoardTileKey = 'progress' | 'review' | 'todo' | 'done'

export interface BoardTile {
  key: BoardTileKey
  label: string
  value: string
  sub: string | null
  alert: string | null
}

/** 리뷰·QA 계열 상태명인가. 진행 중 카테고리 안에서 이름으로만 갈린다 */
export function isReviewStatus(name: string): boolean {
  return /review|리뷰|검토|qa|검수|test|테스트/i.test(name)
}

/**
 * 상단 요약 타일. 범위 안 이슈만 세고 에픽은 뺀다 — 에픽은 묶음이지 할 일이 아니다.
 * 리뷰·QA 타일은 0건이면 숨긴다. 마감 지남은 해당 타일 안의 건수만 붙인다.
 */
export function summaryTiles(
  issues: JiraBoardIssue[],
  today: string,
  myAccountId: string | null,
  recentDoneDays: number
): BoardTile[] {
  const work = issues.filter((i) => i.inScope && i.level !== 'epic')
  const cat = (i: JiraBoardIssue): StatusCategory => normalizeCategory(i.statusCategory)
  const progress = work.filter((i) => cat(i) === 'indeterminate' && !isReviewStatus(i.status))
  const review = work.filter((i) => cat(i) === 'indeterminate' && isReviewStatus(i.status))
  const todo = work.filter((i) => cat(i) === 'new')
  // 스냅샷에는 롤업용 옛 완료 자식도 있다. 이 타일은 기간 안에 끝난 것만 센다
  const done = work.filter((i) => isRecentDone(i, today, recentDoneDays))
  const mine = (list: JiraBoardIssue[]): string | null =>
    myAccountId ? `내 담당 ${list.filter((i) => i.assigneeAccountId === myAccountId).length}` : null
  const overdue = (list: JiraBoardIssue[]): string | null => {
    const n = list.filter((i) => isOverdue(i, today)).length
    return n > 0 ? `마감 지남 ${n}` : null
  }
  const tiles: BoardTile[] = [
    { key: 'progress', label: '진행 중', value: `${progress.length}건`, sub: mine(progress), alert: overdue(progress) }
  ]
  if (review.length > 0) {
    tiles.push({ key: 'review', label: '리뷰·QA', value: `${review.length}건`, sub: mine(review), alert: overdue(review) })
  }
  tiles.push(
    { key: 'todo', label: '할 일', value: `${todo.length}건`, sub: mine(todo), alert: overdue(todo) },
    { key: 'done', label: `완료(최근 ${recentDoneDays}일)`, value: `${done.length}건`, sub: mine(done), alert: null }
  )
  return tiles
}

// ─── 필터 후보 ─────────────────────────────────────────────

export interface BoardFacets {
  /** 실제로 등장한 세부 상태명. 카테고리 순(진행 → 할 일 → 완료) 다음 이름 순 */
  statuses: { name: string; category: StatusCategory }[]
  types: string[]
  /** 등장한 fixVersion 이름. 버전 번호가 큰 것(최근) 먼저 */
  releases: string[]
  /** fixVersion 이 없는 범위 안 이슈가 있는가("릴리스 없음" 후보) */
  hasNoRelease: boolean
}

export function deriveFacets(issues: JiraBoardIssue[]): BoardFacets {
  const statuses = new Map<string, StatusCategory>()
  const types = new Set<string>()
  const releases = new Set<string>()
  let hasNoRelease = false
  for (const i of issues) {
    if (!i.inScope) continue
    if (!statuses.has(i.status)) statuses.set(i.status, normalizeCategory(i.statusCategory))
    types.add(i.issueType)
    const fv = i.fixVersions ?? []
    if (fv.length === 0) hasNoRelease = true
    for (const v of fv) releases.add(v.name)
  }
  return {
    statuses: [...statuses]
      .map(([name, category]) => ({ name, category }))
      .sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || a.name.localeCompare(b.name)),
    types: [...types].sort((a, b) => a.localeCompare(b)),
    releases: [...releases].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
    hasNoRelease
  }
}

// ─── 표기 매핑 ─────────────────────────────────────────────

export interface StatusVisual {
  badge: string
  /** 색 외 신호. ○ 할 일, ◐ 진행, ● 완료 */
  shape: '○' | '◐' | '●'
  categoryLabel: string
}

/**
 * 상태 배지는 카테고리로만 칠한다. 이름 기반 매핑은 사이트 언어·워크플로마다 틀린다.
 * 막힘(빨강)은 카테고리로 판정할 수 없어 쓰지 않는다.
 */
export function statusVisual(category: string): StatusVisual {
  switch (normalizeCategory(category)) {
    case 'done':
      return { badge: releaseItemStatus.done, shape: '●', categoryLabel: '완료' }
    case 'indeterminate':
      return { badge: releaseItemStatus.progress, shape: '◐', categoryLabel: '진행 중' }
    default:
      return { badge: releaseItemStatus.todo, shape: '○', categoryLabel: '할 일' }
  }
}

export const CATEGORY_LABELS: Record<StatusCategory, string> = {
  indeterminate: '진행 중',
  new: '할 일',
  done: '완료'
}

export interface PriorityVisual {
  marks: '●●●' | '●●' | '●'
  text: string
  label: string
}

/**
 * 우선순위 표기. 색이 아니라 점 개수로 순위를 싣는다(색각 이상 대응).
 * 빨강은 마감 뜻으로만 쓰므로 회색 농도만 바꾼다. 모르는 이름·없음은 null.
 */
export function priorityVisual(name: string | null): PriorityVisual | null {
  if (!name) return null
  const n = name.trim().toLowerCase()
  if (/^(highest|high|critical|blocker|최고|높음|긴급|매우 높음)$/.test(n)) {
    return { marks: '●●●', text: 'text-gray-700', label: name }
  }
  if (/^(medium|normal|보통|중간)$/.test(n)) return { marks: '●●', text: 'text-gray-500', label: name }
  if (/^(low|lowest|minor|trivial|낮음|최저|매우 낮음)$/.test(n)) {
    return { marks: '●', text: 'text-gray-400', label: name }
  }
  return null
}

export function priorityMarks(name: string | null): PriorityVisual['marks'] | null {
  return priorityVisual(name)?.marks ?? null
}

export type IssueTypeKind = 'epic' | 'story' | 'task' | 'bug' | 'subtask' | 'other'

/** 유형 아이콘 종류. level 이 먼저고, 표준 이슈의 세부 유형은 이름(한/영)으로 정한다 */
export function issueTypeKind(level: IssueLevel, typeName: string): IssueTypeKind {
  if (level === 'epic') return 'epic'
  if (level === 'subtask') return 'subtask'
  const n = typeName.trim().toLowerCase()
  if (/story|스토리/.test(n)) return 'story'
  if (/bug|버그|결함|defect/.test(n)) return 'bug'
  if (/task|작업|태스크/.test(n)) return 'task'
  return 'other'
}

/** 직계 자식 담당자 요약: 가장 많은 1명 + "외 n" */
export function assigneeSummary(nodes: BoardNode[]): string | null {
  const counts = new Map<string, number>()
  for (const n of nodes) {
    const name = n.issue.assigneeName
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  const [top] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return counts.size > 1 ? `${top[0]} 외 ${counts.size - 1}` : top[0]
}

/** 'YYYY-MM-DD' → 'M/D' */
export function shortDate(d: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(d)
  return m ? `${Number(m[1])}/${Number(m[2])}` : d
}

/** ISO → 'HH:mm'(로컬). 잘못된 값은 빈 문자열 */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 로컬 날짜 'YYYY-MM-DD' */
export function localDate(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * 동기화 결과 한 줄. 실제로 돈 방식(sync.mode)을 그대로 말한다.
 * 저장본만 돌려준 경우(cache)는 알릴 것이 없어 null 이다. 단 전체 다시 받기를 요청했는데 전체가 돌지 않았으면
 * 그 사실을 붙인다 — "3건 갱신"만 보이면 전체를 받은 줄 안다.
 */
export function syncResultText(
  sync: { mode: 'full' | 'incremental' | 'cache'; changed: number } | null,
  requested: 'auto' | 'incremental' | 'full' | null = null
): string | null {
  if (!sync) return null
  const missedFull = requested === 'full' && sync.mode !== 'full'
  const base =
    sync.mode === 'full'
      ? '전체 동기화'
      : sync.mode === 'incremental'
        ? sync.changed > 0
          ? `${sync.changed}건 갱신`
          : '변경 없음'
        : null
  if (missedFull) return `${base ? `${base} · ` : ''}전체 다시 받기가 끝나지 않았어요. 다시 시도해 주세요`
  return base
}

/** ISO → 'M/D HH:mm'(로컬). 잘못된 값은 빈 문자열 */
export function shortDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()} ${clockTime(iso)}`
}

/**
 * 보드 트리에 보일 수 있는 이슈인가(보드에서 보기·문서 탭 키 칩의 노출 조건).
 * 스냅샷에 있고 범위 안이거나 범위 안 자손이 있어야 한다 — 백로그 잎은 트리에 그려지지 않는다.
 */
export function isRevealable(issues: JiraBoardIssue[], key: string): boolean {
  const issue = issues.find((i) => i.key === key)
  if (!issue) return false
  if (issue.inScope) return true
  const kids = issues.filter((i) => i.parentKey === key && i.key !== key)
  return kids.some((k) => k.inScope || issues.some((g) => g.parentKey === k.key && g.key !== k.key && g.inScope))
}

const FILTER_LABELS: Record<'query' | 'categories' | 'statuses' | 'types' | 'releases' | 'mineOnly' | 'hideDone', string> = {
  query: '검색',
  categories: '상태 분류',
  statuses: '세부 상태',
  types: '유형',
  releases: '릴리스',
  mineOnly: '내 담당만',
  hideDone: '완료 모두 숨김'
}

/**
 * 그 이슈를 가리는 조건만 푼 필터. 조건마다 "그 조건 하나만 켰을 때 이 이슈가 떨어지는가"를 보고
 * 떨어지는 조건만 끈다 — "보드에서 보기" 한 번에 무관한 조건까지 날아가지 않게 한다.
 */
export function revealFilter(
  issue: JiraBoardIssue,
  f: BoardFilter,
  myAccountId: string | null
): { filter: BoardFilter; cleared: string[] } {
  const next: BoardFilter = { ...f }
  const cleared: string[] = []
  const only = (patch: Partial<BoardFilter>): boolean =>
    matchesFilter(issue, { ...EMPTY_FILTER, ...patch }, myAccountId)
  const keys = Object.keys(FILTER_LABELS) as (keyof typeof FILTER_LABELS)[]
  for (const k of keys) {
    if (only({ [k]: f[k] } as Partial<BoardFilter>)) continue
    ;(next as unknown as Record<string, unknown>)[k] = EMPTY_FILTER[k]
    cleared.push(FILTER_LABELS[k])
  }
  return { filter: next, cleared }
}
