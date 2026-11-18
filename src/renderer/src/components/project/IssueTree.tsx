import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { ChevronDownIcon, ClampedText, taskTag, typo } from '../ui'
import { ExternalLinkIcon, FixVersionChips, IssueTypeIcon, JiraStatusBadge, PriorityMarks, SegmentedBar, rollupText } from './BoardBits'
import {
  assigneeSummary,
  isOverdue,
  isTreeRowTarget,
  resolveFocus,
  shortDate,
  treeKeyAction,
  type BoardForest,
  type EpicGroup,
  type VisibleRow
} from './boardModel'

// 행은 2열이다. 1열 제목·메타, 2열 상태 배지. 열을 늘리지 않아야 좁은 창에서도 가로 스크롤이 없다
const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-start'
const META = 'mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500 tabular-nums'
// 레벨별 들여쓰기. Tailwind 는 리터럴만 스캔하므로 조합하지 않는다
const INDENT: Record<1 | 2 | 3, string> = { 1: 'pl-3', 2: 'pl-8', 3: 'pl-14' }
const URGENT = 'text-red-600 font-medium'

/** 넓은 창 기준점. 이보다 좁으면 상세를 행 아래 인라인으로 펼친다 (ProjectBoardView 와 짝) */
export const INLINE_DETAIL_HIDE = 'min-[1120px]:hidden'

export interface IssueTreeProps {
  rows: VisibleRow[]
  /** 포커스가 사라진 행의 조상을 찾는 데 쓴다 */
  forest: BoardForest
  selectedId: string | null
  today: string
  onSelect: (id: string) => void
  onToggle: (id: string, expanded: boolean) => void
  onOpenJira: (key: string) => void
  /** fixVersion 칩 → 릴리스 탭 */
  onOpenRelease?: (versionId: string) => void
  /** 좁은 창에서 선택 행 아래에 그릴 상세 */
  renderInlineDetail?: (id: string) => ReactNode
}

function Toggle({ row, onToggle }: { row: VisibleRow; onToggle: IssueTreeProps['onToggle'] }): ReactNode {
  if (!row.hasChildren) return <span className="w-5 flex-shrink-0" aria-hidden />
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={row.expanded ? '접기' : '펼치기'}
      onClick={(e) => {
        e.stopPropagation()
        onToggle(row.id, !row.expanded)
      }}
      className="w-5 h-5 flex-shrink-0 inline-flex items-center justify-center rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100"
    >
      <ChevronDownIcon size={14} className={row.expanded ? '' : '-rotate-90'} />
    </button>
  )
}

function KeyChip({ issueKey, onOpenJira }: { issueKey: string; onOpenJira: (key: string) => void }): ReactNode {
  return (
    <span className="inline-flex items-center gap-0.5 flex-shrink-0">
      <span className={`rounded px-1 text-[11px] ${taskTag.issue}`}>{issueKey}</span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`${issueKey} Jira에서 열기`}
        title="Jira에서 열기"
        onClick={(e) => {
          e.stopPropagation()
          onOpenJira(issueKey)
        }}
        className="p-0.5 rounded text-gray-300 hover:text-blue-600 hover:bg-blue-50"
      >
        <ExternalLinkIcon size={11} />
      </button>
    </span>
  )
}

function VirtualGroupIcon({ group }: { group: EpicGroup }): ReactNode {
  const label = group.kind === 'missingEpic' ? '범위 밖 에픽' : group.title
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-block w-3.5 h-3.5 flex-shrink-0 rounded-sm border border-dashed ${
        group.kind === 'missingEpic' ? 'border-purple-300' : 'border-gray-300'
      }`}
    />
  )
}

function GroupRowBody({ row, today, onToggle, onOpenJira }: { row: VisibleRow; today: string } & Pick<IssueTreeProps, 'onToggle' | 'onOpenJira'>): ReactNode {
  const g = row.group!
  const epic = g.epic
  const dim = !g.matched && !!epic
  const isVirtual = g.kind !== 'epic'
  const isSubtaskGroup = g.kind === 'orphanSubtasks'
  const assignees = assigneeSummary(g.children)
  return (
    <>
      <div role="gridcell" className={`min-w-0 ${dim ? 'opacity-60' : ''}`}>
        <div className="flex items-center gap-1.5 min-w-0">
          <Toggle row={row} onToggle={onToggle} />
          {epic ? <IssueTypeIcon level="epic" typeName={epic.issueType} /> : <VirtualGroupIcon group={g} />}
          {g.epicKey ? <KeyChip issueKey={g.epicKey} onOpenJira={onOpenJira} /> : null}
          <ClampedText
            text={g.title}
            lines={1}
            focusable={false}
            className={`min-w-0 text-sm font-semibold ${isVirtual && g.kind !== 'missingEpic' ? 'text-gray-600' : 'text-gray-900'}`}
          />
          {isVirtual && g.kind !== 'missingEpic' ? (
            <span className={`${typo.metaFaint} flex-shrink-0`}>({g.children.length})</span>
          ) : null}
        </div>
        <div className={`${META} pl-6`}>
          {isSubtaskGroup ? null : g.rollup.total > 0 ? (
            <span className="inline-flex items-center gap-2">
              <SegmentedBar counts={g.rollup} />
              <span>{rollupText(g.rollup)}</span>
            </span>
          ) : (
            <span className="text-gray-400">범위 안 자식 없음</span>
          )}
          {assignees ? <span>{assignees}</span> : null}
          {epic?.duedate ? (
            <span className={isOverdue(epic, today) ? URGENT : undefined}>기한 {shortDate(epic.duedate)}</span>
          ) : null}
          {g.rollup.overdue > 0 ? <span className={URGENT}>마감 지남 {g.rollup.overdue}</span> : null}
          {g.backlogCount > 0 ? <span className="text-gray-400">백로그 {g.backlogCount}건</span> : null}
          {g.pastDoneCount > 0 ? <span className="text-gray-400">이전 완료 {g.pastDoneCount}건</span> : null}
        </div>
      </div>
      <div role="gridcell" className="pt-0.5">
        {epic ? (
          <JiraStatusBadge status={epic.status} category={epic.statusCategory} dimmed={!epic.inScope} />
        ) : g.kind === 'missingEpic' ? (
          <span className={typo.metaFaint}>범위 밖 에픽</span>
        ) : null}
      </div>
    </>
  )
}

function IssueRowBody({
  row,
  today,
  onToggle,
  onOpenJira,
  onOpenRelease
}: { row: VisibleRow; today: string } & Pick<IssueTreeProps, 'onToggle' | 'onOpenJira' | 'onOpenRelease'>): ReactNode {
  const n = row.node!
  const i = n.issue
  const done = i.statusCategory === 'done'
  const dim = !n.matched || done
  const sub = row.level === 3
  // 상위가 스냅샷에 없는 하위작업은 상위 키를 메타에 붙여 맥락을 남긴다
  const orphanParent = i.level === 'subtask' && row.level === 2 && i.parentKey && i.parentKey !== i.key ? i.parentKey : null
  return (
    <>
      <div role="gridcell" className={`min-w-0 ${dim ? 'opacity-60' : ''}`}>
        <div className="flex items-center gap-1.5 min-w-0">
          <Toggle row={row} onToggle={onToggle} />
          <IssueTypeIcon level={i.level} typeName={i.issueType} />
          <KeyChip issueKey={i.key} onOpenJira={onOpenJira} />
          <ClampedText text={i.summary} lines={1} focusable={false} className={`min-w-0 text-gray-800 ${sub ? 'text-[13px]' : 'text-sm'}`} />
        </div>
        <div className={`${META} pl-6`}>
          <span>{i.assigneeName ?? '담당 없음'}</span>
          {!sub && i.duedate ? (
            <span className={isOverdue(i, today) ? URGENT : undefined}>기한 {shortDate(i.duedate)}</span>
          ) : null}
          {!sub ? <PriorityMarks priority={i.priority} /> : null}
          {n.rollup.total > 0 ? <span>하위 {n.rollup.done}/{n.rollup.total}</span> : null}
          {n.pastDoneCount > 0 ? <span className="text-gray-400">이전 완료 {n.pastDoneCount}건</span> : null}
          {orphanParent ? <span className="font-mono text-gray-400">상위 {orphanParent}</span> : null}
          {onOpenRelease ? <FixVersionChips versions={i.fixVersions} onOpen={onOpenRelease} tabbable={false} /> : null}
        </div>
      </div>
      <div role="gridcell" className="pt-0.5">
        <JiraStatusBadge status={i.status} category={i.statusCategory} dimmed={!i.inScope} />
      </div>
    </>
  )
}

/**
 * 에픽 그룹 트리(treegrid). WAI-ARIA APG 를 따른다 — roving tabindex 로 탭 정지점은 하나,
 * ↑↓ Home End 로 이동, →/← 로 펼침·접힘, Enter 로 상세, ⌘Enter·o 로 Jira 열기.
 * 토글 화살표 클릭은 펼침만, 행 나머지 클릭은 선택만 한다(실수로 외부 브라우저가 열리지 않게).
 */
export default function IssueTree({
  rows,
  forest,
  selectedId,
  today,
  onSelect,
  onToggle,
  onOpenJira,
  onOpenRelease,
  renderInlineDetail
}: IssueTreeProps): ReactNode {
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  // 키보드로 옮긴 경우에만 DOM 포커스를 따라 옮긴다. 렌더마다 포커스를 뺏으면 검색창 입력이 끊긴다
  const moveDomFocus = useRef(false)

  const activeId = resolveFocus(rows, focusedId ?? selectedId, forest)

  useEffect(() => {
    if (!moveDomFocus.current || !activeId) return
    moveDomFocus.current = false
    const el = rowRefs.current.get(activeId)
    el?.focus()
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId, rows])

  // 다른 탭에서 "보드에서 보기"로 들어오면 선택 행이 화면 밖일 수 있다. 선택이 바뀔 때만 스크롤한다(행 목록 변화로는 끌어오지 않는다)
  useEffect(() => {
    if (!selectedId) return
    rowRefs.current.get(selectedId)?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedId])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // 행 안의 버튼·인라인 상세에서 온 키는 건드리지 않는다(버튼의 Enter 가 그대로 동작해야 한다)
    const action = treeKeyAction(rows, activeId, e, isTreeRowTarget(e.target))
    if (!action) return
    e.preventDefault()
    if (action.kind === 'open') onOpenJira(action.key)
    else if (action.kind === 'select') onSelect(action.id)
    else {
      const { move } = action
      if (move.toggle) onToggle(move.toggle.id, move.toggle.expanded)
      moveDomFocus.current = true
      setFocusedId(move.focusId)
    }
  }

  return (
    <div role="treegrid" aria-label="Jira 티켓 계층" onKeyDown={onKeyDown} className="divide-y divide-gray-100">
      {rows.map((r) => {
        const selected = r.id === selectedId
        const missing = r.group?.kind === 'missingEpic'
        return (
          <div
            key={r.id}
            ref={(el) => {
              if (el) rowRefs.current.set(r.id, el)
              else rowRefs.current.delete(r.id)
            }}
            id={`board-row-${r.id}`}
            role="row"
            aria-level={r.level}
            aria-posinset={r.posinset}
            aria-setsize={r.setsize}
            aria-expanded={r.hasChildren ? r.expanded : undefined}
            aria-selected={selected}
            tabIndex={r.id === activeId ? 0 : -1}
            data-row-kind={r.kind}
            onFocus={() => setFocusedId(r.id)}
            onClick={() => {
              setFocusedId(r.id)
              onSelect(r.id)
            }}
            className={`${ROW_GRID} ${INDENT[r.level]} pr-3 py-2 border-l-[3px] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 ${
              selected
                ? 'border-l-blue-500 bg-blue-50/60'
                : `border-l-transparent hover:bg-gray-50 ${r.kind === 'group' ? 'bg-gray-50/40' : ''}`
            } ${missing ? 'border-y border-dashed border-y-gray-200' : ''}`}
          >
            {r.kind === 'group' ? (
              <GroupRowBody row={r} today={today} onToggle={onToggle} onOpenJira={onOpenJira} />
            ) : (
              <IssueRowBody row={r} today={today} onToggle={onToggle} onOpenJira={onOpenJira} onOpenRelease={onOpenRelease} />
            )}
            {/* 좁은 창 인라인 상세. 별도 행으로 두면 트리 항목이 아닌 행이 끼어 계층이 어긋나므로
                선택한 행의 두 열을 가로지르는 칸으로 붙인다 */}
            {selected && renderInlineDetail ? (
              <div
                role="gridcell"
                aria-label="선택한 티켓 상세"
                data-inline-detail
                onClick={(e) => e.stopPropagation()}
                className={`${INLINE_DETAIL_HIDE} col-span-2 mt-3 cursor-default rounded-md border border-gray-200 bg-white px-4 py-3`}
              >
                {renderInlineDetail(r.id)}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
