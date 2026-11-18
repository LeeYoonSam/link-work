// 문서 탭·상세 "관련 문서"의 순수 모델. React·스토어·window 를 쓰지 않는다.
// 보드 트리(buildIssueForest 결과)를 그대로 받아 같은 그룹 규칙(에픽 → 티켓, 에픽 없음·범위 밖)과
// 같은 보임 규칙(백로그·이전 완료 잎 제외)을 따른다 (docs/PROJECT_BOARD.md).
import type { JiraBoardIssue, JiraIssueLink, JiraIssueLinkKind } from '../../types'
import type { BoardForest, BoardNode, DetailTarget, GroupKind } from './boardModel'

export type DocKind = JiraIssueLinkKind

/** 표시 순서. 문서(웹링크·첨부·본문)가 먼저고 연결 이슈는 맨 뒤다 */
export const DOC_KIND_ORDER: DocKind[] = ['web', 'attachment', 'description', 'issue']

export const DOC_KIND_LABELS: Record<DocKind, string> = {
  web: '웹링크',
  attachment: '첨부',
  description: '본문 링크',
  issue: '연결 이슈'
}

/** 링크가 걸린 티켓 */
export interface DocOrigin {
  key: string
  summary: string
}

export interface DocEntry {
  url: string
  kind: DocKind
  title: string
  /** 표시용 출처 라벨(첨부는 '첨부'로 고정) */
  source: string
  link: JiraIssueLink
  /** 이 링크가 걸린 티켓들(같은 그룹 안에서 URL 이 같으면 합친다) */
  origins: DocOrigin[]
}

export interface DocGroup {
  /** 보드 그룹 id 와 같다 */
  id: string
  kind: GroupKind
  epicKey: string | null
  title: string
  /** 문서(웹링크·첨부·본문) */
  docs: DocEntry[]
  /** 연결 이슈. 관계 이름 순으로 묶여 있다 */
  issues: DocEntry[]
}

export interface DocsFilter {
  query: string
  /** 비면 전체 */
  kinds: DocKind[]
  /** 출처 라벨. 비면 전체 */
  sources: string[]
}

export const EMPTY_DOCS_FILTER: DocsFilter = { query: '', kinds: [], sources: [] }

/** 출처 라벨. 첨부는 호스트(Jira)가 아니라 '첨부'로 묶어야 출처 필터가 읽힌다 */
export function docSource(link: JiraIssueLink): string {
  if (link.kind === 'attachment') return '첨부'
  return link.source?.trim() || '기타'
}

// 그룹 안 이슈를 보드 순서대로(에픽 → 자식 → 하위작업) 모은다
function groupIssues(epic: JiraBoardIssue | null, children: BoardNode[]): JiraBoardIssue[] {
  const out: JiraBoardIssue[] = []
  if (epic) out.push(epic)
  for (const c of children) {
    out.push(c.issue)
    for (const s of c.children) out.push(s.issue)
  }
  return out
}

/**
 * 이슈 목록의 링크를 URL 로 합친다. 첫 등장 순서를 지키고, 같은 URL 이면 출처 티켓만 더한다.
 * 종류 순(문서 → 연결 이슈)으로 안정 정렬한다.
 */
export function mergeLinks(issues: JiraBoardIssue[]): DocEntry[] {
  const byUrl = new Map<string, DocEntry>()
  for (const i of issues) {
    for (const l of i.links ?? []) {
      if (!l?.url) continue
      const hit = byUrl.get(l.url)
      if (hit) {
        if (!hit.origins.some((o) => o.key === i.key)) hit.origins.push({ key: i.key, summary: i.summary })
        continue
      }
      byUrl.set(l.url, {
        url: l.url,
        kind: l.kind,
        title: l.title || l.url,
        source: docSource(l),
        link: l,
        origins: [{ key: i.key, summary: i.summary }]
      })
    }
  }
  const order = (k: DocKind): number => {
    const i = DOC_KIND_ORDER.indexOf(k)
    return i < 0 ? DOC_KIND_ORDER.length : i
  }
  return [...byUrl.values()]
    .map((e, idx) => ({ e, idx }))
    .sort((a, b) => order(a.e.kind) - order(b.e.kind) || a.idx - b.idx)
    .map(({ e }) => e)
}

const tokens = (q: string): string[] => q.trim().toLowerCase().split(/\s+/).filter(Boolean)

/**
 * 검색(제목·URL·출처 티켓 키, 그리고 그룹의 에픽 키) + 종류 + 출처.
 * 에픽 키로 찾으면 그 에픽 그룹의 문서가 모두 나온다 — 상세의 "문서 탭에서 모두 보기"가 이 규칙을 쓴다.
 */
export function matchesDoc(e: DocEntry, f: DocsFilter, groupEpicKey: string | null = null): boolean {
  if (f.kinds.length > 0 && !f.kinds.includes(e.kind)) return false
  if (f.sources.length > 0 && !f.sources.includes(e.source)) return false
  const ts = tokens(f.query)
  if (ts.length === 0) return true
  const hay = [e.title, e.url, e.link.issueKey ?? '', groupEpicKey ?? '', ...e.origins.map((o) => o.key)]
    .join(' ')
    .toLowerCase()
  return ts.every((t) => hay.includes(t))
}

export interface DocsView {
  groups: DocGroup[]
  /** 종류 필터를 빼고 센 종류별 건수. 상단 요약이자 종류 토글의 숫자다 */
  kindCounts: Record<DocKind, number>
  /** 출처 필터 후보. 종류·출처 필터를 뺀 조건에서 등장한 라벨(건수 많은 순) + 이미 고른 라벨 */
  sources: string[]
  /** 필터 전 전체 건수(그룹별 중복 제거 후 합) */
  total: number
}

/**
 * 보드 트리 → 문서 탭 묶음.
 * - 그룹 안에서 같은 URL 은 한 번만, 걸린 티켓을 모은다.
 * - mine 이면 내 담당 티켓에서 온 링크만 남긴다(보드의 "내 담당만"과 같은 값).
 * - 문서는 위, 연결 이슈는 아래에 관계 이름별로 모은다 — 연결 이슈만 많아도 문서가 묻히지 않는다.
 */
export function buildDocsView(
  forest: BoardForest,
  f: DocsFilter,
  mine: { on: boolean; myAccountId: string | null } = { on: false, myAccountId: null }
): DocsView {
  const kindCounts: Record<DocKind, number> = { web: 0, attachment: 0, description: 0, issue: 0 }
  const sourceCounts = new Map<string, number>()
  const groups: DocGroup[] = []
  let total = 0
  const mineOnly = mine.on && !!mine.myAccountId
  for (const g of forest.groups) {
    let issues = groupIssues(g.epic, g.children)
    if (mineOnly) issues = issues.filter((i) => i.assigneeAccountId === mine.myAccountId)
    const merged = mergeLinks(issues)
    total += merged.length
    // 출처 목록은 종류·출처 필터를 모두 빼고 센다 — 하나를 고른 뒤에도 다른 출처를 더 고르거나 풀 수 있어야 한다
    for (const e of merged.filter((x) => matchesDoc(x, { ...f, kinds: [], sources: [] }, g.epicKey))) {
      sourceCounts.set(e.source, (sourceCounts.get(e.source) ?? 0) + 1)
    }
    // 종류 건수는 종류 필터만 빼고 센다 — 토글 숫자는 "이 종류를 켜면 몇 건"이어야 한다(종류는 늘 4개가 다 보인다)
    const noKind = merged.filter((e) => matchesDoc(e, { ...f, kinds: [] }, g.epicKey))
    for (const e of noKind) kindCounts[e.kind] += 1
    const shown = noKind.filter((e) => f.kinds.length === 0 || f.kinds.includes(e.kind))
    if (shown.length === 0) continue
    const docs = shown.filter((e) => e.kind !== 'issue')
    const issueLinks = shown
      .filter((e) => e.kind === 'issue')
      .map((e, idx) => ({ e, idx }))
      .sort((a, b) => (a.e.link.relation ?? '').localeCompare(b.e.link.relation ?? '') || a.idx - b.idx)
      .map(({ e }) => e)
    groups.push({ id: g.id, kind: g.kind, epicKey: g.epicKey, title: g.title, docs, issues: issueLinks })
  }
  // 이미 고른 출처는 검색어에 다 가려져 0건이어도 남긴다 — 해제할 체크박스가 사라지면 안 된다
  for (const s of f.sources) if (!sourceCounts.has(s)) sourceCounts.set(s, 0)
  const sources = [...sourceCounts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([s]) => s)
  return { groups, kindCounts, sources, total }
}

/**
 * 상세 패널 "관련 문서". 이슈면 자기 링크와 하위 목록(하위작업)의 링크,
 * 에픽·가상 그룹이면 보이는 자손 전부를 URL 로 합친다.
 */
export function relatedDocs(target: DetailTarget | null, limit = 6): { items: DocEntry[]; total: number } {
  if (!target) return { items: [], total: 0 }
  const issues: JiraBoardIssue[] = target.group
    ? groupIssues(target.group.epic, target.group.children)
    : [...(target.issue ? [target.issue] : []), ...target.children.map((c) => c.issue)]
  const all = mergeLinks(issues)
  return { items: all.slice(0, limit), total: all.length }
}

/** 첨부 크기 표기 */
export function formatSize(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
