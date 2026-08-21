import { useState } from 'react'
import { format } from 'date-fns'
import { useReleaseNoteStore } from '../../stores/releaseNoteStore'
import { buildReleaseNoteMarkdown } from '../../utils/releaseNoteExport'
import type { ReleaseNoteItem, ReleaseNoteSummary } from '../../types'
import {
  Badge,
  ChevronDownIcon,
  EmptyState,
  button,
  releaseItemStatus,
  taskTag,
  typo
} from '../ui'

/** issue_type이 비어 있는 항목이 모이는 그룹 */
const FALLBACK_TYPE = '기타'

/** 한 릴리스에서 가져오는 이슈 상한 (services/jira.ts의 MAX_ISSUES와 같은 값) */
export const MAX_ISSUES = 500

export interface ReleaseItemRow {
  item: ReleaseNoteItem
  child: boolean
}

export interface ReleaseItemGroup {
  type: string
  rows: ReleaseItemRow[]
}

// 이슈를 유형별로 묶고, 하위 이슈는 부모 바로 아래에 붙인다.
// 하위(Sub-task)는 부모와 유형이 다른 경우가 흔해서, 자기 유형이 아니라 **부모의 그룹**에 넣어야
// 들여쓴 항목 위에 항상 부모가 보인다. 그룹 순서는 Jira가 준 sort_order 안에서
// 최상위 항목이 처음 등장한 유형 순서를 따른다.
export function groupReleaseNoteItems(items: ReleaseNoteItem[]): ReleaseItemGroup[] {
  const ordered = [...items].sort((a, b) => a.sort_order - b.sort_order)
  const byKey = new Map(ordered.map((i) => [i.issue_key, i]))

  // 부모가 이 릴리스 안에 없으면(=릴리스에 안 묶인 상위 이슈) 그 항목은 최상위로 둔다
  const hasParent = (i: ReleaseNoteItem): boolean =>
    i.parent_key !== null && i.parent_key !== i.issue_key && byKey.has(i.parent_key)

  const childrenOf = new Map<string, ReleaseNoteItem[]>()
  for (const item of ordered) {
    if (!hasParent(item)) continue
    const siblings = childrenOf.get(item.parent_key!) ?? []
    siblings.push(item)
    childrenOf.set(item.parent_key!, siblings)
  }

  const groups: ReleaseItemGroup[] = []
  const byType = new Map<string, ReleaseItemGroup>()
  const placed = new Set<string>()

  const groupFor = (item: ReleaseNoteItem): ReleaseItemGroup => {
    const type = item.issue_type?.trim() || FALLBACK_TYPE
    let group = byType.get(type)
    if (!group) {
      group = { type, rows: [] }
      byType.set(type, group)
      groups.push(group)
    }
    return group
  }

  // 손자 이상도 한 단계 들여쓰기로 평탄화한다 — 계약상 계층은 1단계다
  const appendDescendants = (parent: ReleaseNoteItem, group: ReleaseItemGroup): void => {
    for (const child of childrenOf.get(parent.issue_key) ?? []) {
      if (placed.has(child.issue_key)) continue
      placed.add(child.issue_key)
      group.rows.push({ item: child, child: true })
      appendDescendants(child, group)
    }
  }

  for (const item of ordered) {
    if (hasParent(item) || placed.has(item.issue_key)) continue
    placed.add(item.issue_key)
    const group = groupFor(item)
    group.rows.push({ item, child: false })
    appendDescendants(item, group)
  }

  // 부모-자식이 순환하면 위 루프에서 아무도 최상위가 되지 못한다. 항목이 조용히 사라지지 않도록 건진다.
  for (const item of ordered) {
    if (placed.has(item.issue_key)) continue
    placed.add(item.issue_key)
    groupFor(item).rows.push({ item, child: false })
  }

  return groups
}

/**
 * Jira 상태 이름 → 뱃지 색 계열.
 *
 * Jira 워크플로는 프로젝트마다 손댈 수 있어 상태 이름이 고정되어 있지 않다. 그래서 아는 이름을
 * 정확히 맞춰 보고, 못 맞추면 키워드로 한 번 더 본다 — '개발 완료', 'QA 진행중', '완료 대기'처럼
 * 수식어가 앞에 붙은 이름이 흔하다.
 *
 * 키워드가 여럿 걸리면 **가장 뒤에 있는 것이 이긴다.** 한국어 상태 이름은 앞이 수식어, 뒤가 실제
 * 상태이기 때문이다: '개발 완료'는 완료지만 '완료 대기'는 대기다. 앞에서부터 훑으면 둘 다
 * 완료로 보인다. 자리가 같으면 급한 쪽(중단 → 미착수 → 진행 → 완료)을 택한다.
 *
 * 아무것도 못 맞추면 회색이다. 모르는 상태에 색을 찍으면 없는 정보를 지어내는 셈이다.
 */
export function releaseItemStatusTone(status: string): string {
  const name = status.replace(/\s+/g, '').toLowerCase()
  if (!name) return releaseItemStatus.unknown

  // 배열 순서 = 같은 자리에서 부딪혔을 때의 우선순위
  const groups = [
    {
      tone: releaseItemStatus.blocked,
      exact: ['보류', '차단', '중단', '취소', '취소됨', '반려', '거절', 'blocked', 'onhold', 'cancelled', 'canceled', 'rejected'],
      keywords: ['보류', '차단', '중단', '취소', '반려', '거절', 'blocked', 'hold', 'cancel', 'reject']
    },
    {
      tone: releaseItemStatus.todo,
      exact: ['할일', '대기', '접수', '백로그', '신규', 'todo', 'open', 'backlog', 'new', 'created'],
      keywords: ['할일', '대기', '접수', '백로그', '신규', 'todo', 'backlog']
    },
    {
      tone: releaseItemStatus.progress,
      exact: ['처리중', '진행중', '개발중', '검토중', '리뷰중', '확인중', '검수중', 'inprogress', 'inreview', 'indevelopment', 'review', 'testing', 'qa'],
      keywords: ['처리', '진행', '개발', '검토', '리뷰', '확인', '검수', 'progress', 'review', 'develop', 'test']
    },
    {
      tone: releaseItemStatus.done,
      exact: ['닫힘', '해결됨', '완료', '완료됨', '종료', 'done', 'closed', 'resolved', 'complete', 'completed'],
      keywords: ['닫힘', '해결', '완료', '종료', 'done', 'close', 'resolve', 'complete']
    }
  ]

  for (const group of groups) {
    if (group.exact.includes(name)) return group.tone
  }

  let tone = releaseItemStatus.unknown
  let found = -1
  for (const group of groups) {
    for (const keyword of group.keywords) {
      const at = name.lastIndexOf(keyword)
      // 같은 자리면 앞선(=더 급한) 그룹이 이미 잡았으므로 더 뒤에 있을 때만 바꾼다
      if (at > found) {
        found = at
        tone = group.tone
      }
    }
  }
  return tone
}

// 'YYYY-MM-DD HH:MM:SS'(localtime)는 Safari/Chrome 파싱이 갈려 T를 끼워 넣는다
export function formatSyncedAt(value: string | null): string | null {
  if (!value) return null
  const parsed = new Date(value.replace(' ', 'T'))
  if (Number.isNaN(parsed.getTime())) return value
  return format(parsed, 'yyyy-MM-dd HH:mm')
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '릴리스노트'
}

// 이슈 목록 — 그룹 헤더 + 하위 들여쓰기
export function ReleaseNoteItemList({ items }: { items: ReleaseNoteItem[] }): React.ReactNode {
  if (items.length === 0) {
    return <EmptyState compact>이 릴리스에 포함된 이슈가 없습니다</EmptyState>
  }
  return (
    <div className="space-y-3">
      {groupReleaseNoteItems(items).map((group) => (
        <div key={group.type}>
          <div className={`${typo.microLabel} px-3 mb-1`}>{group.type}</div>
          <div className="divide-y divide-gray-100">
            {group.rows.map(({ item, child }) => (
              <div
                key={item.id}
                className={`flex items-center gap-2 py-1.5 pr-3 ${child ? 'pl-9' : 'pl-3'}`}
              >
                {child && <span className="text-gray-300 -ml-4 select-none shrink-0">↳</span>}
                <button
                  type="button"
                  onClick={() => void window.api.jira.openIssue(item.issue_key)}
                  title="Jira에서 열기"
                  className={`shrink-0 rounded px-1 py-0 text-[10px] hover:opacity-70 transition-opacity ${taskTag.issue}`}
                >
                  {item.issue_key}
                </button>
                <span className="flex-1 min-w-0 text-sm text-gray-800 truncate" title={item.summary}>
                  {item.summary}
                </span>
                {item.status && (
                  <Badge color={releaseItemStatusTone(item.status)} size="xs">
                    {item.status}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

interface ReleaseNoteRowProps {
  note: ReleaseNoteSummary
}

// 릴리스 한 건 — 프로젝트 상세 카드와 Releases 화면이 함께 쓴다.
// 같은 규칙(0건 명시·실패 표시·상한 안내·계층 들여쓰기)이 두 곳에 복제되면
// 한쪽만 고쳐져 어긋나므로 행 전체를 여기 한 곳에 둔다.
export default function ReleaseNoteRow({ note }: ReleaseNoteRowProps): React.ReactNode {
  const { details, syncingId, syncResults, syncErrors, fetchDetail, syncNote } =
    useReleaseNoteStore()

  const [expanded, setExpanded] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [actionError, setActionError] = useState('')
  const [savedPath, setSavedPath] = useState<string | null>(null)

  const detail = details[note.id]
  const syncing = syncingId === note.id
  // 이번 세션의 실패 메시지를 우선한다 — main이 last_sync_error를 남기지 않는 경우에도 보여야 한다
  const error = syncErrors[note.id] ?? note.last_sync_error
  const syncedAt = formatSyncedAt(note.last_synced_at)
  // truncated는 DB에 남지 않아 앱을 다시 켜면 사라진다. 상한에 닿은 항목 수로 보완하되,
  // 이때는 정확히 500건인 릴리스와 구분할 수 없으므로 단정하지 않는다.
  const truncated = syncResults[note.id]?.truncated === true
  const atCap = !truncated && note.item_count >= MAX_ISSUES

  const toggleExpand = async (): Promise<void> => {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (detail) return
    setDetailLoading(true)
    try {
      await fetchDetail(note.id)
    } finally {
      setDetailLoading(false)
    }
  }

  const handleSync = async (): Promise<void> => {
    setActionError('')
    setSavedPath(null)
    await syncNote(note.id)
  }

  const handleExport = async (): Promise<void> => {
    setActionError('')
    setSavedPath(null)
    setExporting(true)
    try {
      const full = detail ?? (await fetchDetail(note.id))
      if (!full) {
        setActionError('릴리스 노트를 불러오지 못했습니다')
        return
      }
      const fileName = `${sanitizeFileName(note.version_name)}-릴리스노트.md`
      const result = await window.api.export.saveMarkdown(buildReleaseNoteMarkdown(full), fileName)
      if (result.canceled) return
      if (result.success) {
        setSavedPath(result.path ?? null)
      } else {
        setActionError(result.error ?? '파일 저장에 실패했습니다')
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : '마크다운 내보내기에 실패했습니다')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      {/* 행 어디를 눌러도 펼쳐진다 — 화살표만 누를 수 있으면 과녁이 14px짜리 아이콘 하나뿐이다.
          화살표 버튼은 그대로 남긴다: 키보드로 이 행을 여닫는 유일한 통로이고,
          펼침/접힘 상태를 눈으로 알려주는 표시이기도 하다. */}
      <div
        onClick={() => void toggleExpand()}
        className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors cursor-pointer"
      >
        {/* 부모가 이미 같은 일을 한다 — 막지 않으면 화살표를 누를 때만 두 번 토글돼 제자리로 돌아온다 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            void toggleExpand()
          }}
          title={expanded ? '접기' : '이슈 보기'}
          className="shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
        >
          <ChevronDownIcon size={14} className={expanded ? '' : '-rotate-90'} />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-800 truncate">{note.version_name}</span>
            <Badge
              color={
                note.released === 1 ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'
              }
              size="xs"
            >
              {note.released === 1 ? '출시됨' : '미출시'}
            </Badge>
            {note.archived === 1 && (
              <Badge color="bg-gray-100 text-gray-600" size="xs">
                보관됨
              </Badge>
            )}
            <span className={`rounded px-1 py-0 text-[10px] ${taskTag.domain}`}>
              {note.jira_project_key}
            </span>
          </div>
          {/* 0건도 정상 결과라 "가져온 이슈: 0건"으로 못 박는다 — 빈 화면이 실패로 읽히면 안 된다 */}
          <div className="text-xs text-gray-400">
            {syncedAt
              ? `가져온 이슈: ${note.item_count}건 · 마지막 동기화 ${syncedAt}`
              : '아직 동기화하지 않았습니다'}
            {note.release_date && ` · 릴리스일 ${note.release_date}`}
          </div>
        </div>

        {/* 동기화·내보내기는 행을 여닫는 것과 별개의 동작이라 클릭이 위로 새면 안 된다 */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation()
              void handleSync()
            }}
            disabled={syncing}
            className={`px-2.5 py-1 text-xs disabled:opacity-40 ${button.subtle}`}
          >
            {syncing ? '동기화 중…' : '동기화'}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              void handleExport()
            }}
            disabled={exporting}
            className={`px-2.5 py-1 text-xs disabled:opacity-40 ${button.subtle}`}
          >
            {exporting ? '내보내는 중…' : '마크다운 내보내기'}
          </button>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 border-t border-red-200 bg-red-50 text-xs text-red-600 break-all">
          동기화 실패 — {error}
        </div>
      )}

      {(truncated || atCap) && (
        <div className="px-3 py-2 border-t border-amber-200 bg-amber-50 text-xs text-amber-700">
          {truncated
            ? `이슈가 상한을 넘어 상위 ${MAX_ISSUES}건만 가져왔습니다.`
            : `가져온 이슈가 상한(${MAX_ISSUES}건)에 닿았습니다. 일부가 빠졌을 수 있습니다.`}
        </div>
      )}

      {(actionError || savedPath) && (
        <div className="px-3 py-2 border-t border-gray-100 text-xs break-all">
          {actionError ? (
            <span className="text-red-600">{actionError}</span>
          ) : (
            <span className="text-gray-500">저장됨 — {savedPath}</span>
          )}
        </div>
      )}

      {expanded && (
        <div className="border-t border-gray-100 py-2">
          {detailLoading && !detail ? (
            <EmptyState compact>불러오는 중입니다…</EmptyState>
          ) : (
            <ReleaseNoteItemList items={detail?.items ?? []} />
          )}
        </div>
      )}
    </div>
  )
}
