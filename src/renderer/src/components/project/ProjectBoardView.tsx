import { useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Card, EmptyState, typo } from '../ui'
import { useJiraBoardStore } from '../../stores/jiraBoardStore'
import { useNavigationStore } from '../../stores/navigationStore'
import BoardSummaryTiles from './BoardSummaryTiles'
import BoardToolbar from './BoardToolbar'
import IssueTree from './IssueTree'
import IssueDetailPanel from './IssueDetailPanel'
import { ConnectPrompt, ErrorBanner, TruncatedNotice } from './BoardStates'
import { openBoardLink, openDocsFor, openReleaseForVersion } from './projectNav'
import {
  autoExpandIds,
  buildIssueForest,
  deriveFacets,
  detailTarget,
  effectiveExpanded,
  expandableIds,
  filterForest,
  forestOptions,
  flattenVisible,
  isFilterActive,
  localDate,
  shouldFoldDone,
  sortGroups,
  summaryTiles,
  type BoardForest
} from './boardModel'

const openJira = (key: string): void => {
  void window.api.jira.openIssue(key)
}

// '/' 로 검색창에 들어간다. 입력 중인 칸에서는 가로채지 않는다
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)
}

/**
 * 프로젝트 화면: 기본 Jira 프로젝트의 '할 일' 이상 티켓을 에픽 → 작업 → 하위작업 트리로 요약한다.
 * 읽기 전용이다. 편집은 Jira 에서 한다 (docs/PROJECT_BOARD.md).
 */
export default function ProjectBoardView(): React.ReactNode {
  const {
    snapshot,
    loading,
    error,
    errorCode,
    filter,
    sort,
    expanded,
    selectedKey,
    aiSummaries,
    aiLoading,
    aiErrors,
    load,
    sync,
    lastSync,
    lastSyncRequested,
    revealNotice,
    dismissRevealNotice,
    summarizeEpic,
    setFilter,
    clearFilter,
    setSort,
    setExpanded,
    setAllExpanded,
    select,
    dismissError
  } = useJiraBoardStore()
  const setView = useNavigationStore((s) => s.setView)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const openLink = (url: string): void => {
    void openBoardLink(url).then(setLinkError)
  }
  const openRelease = (versionId: string): void => {
    void openReleaseForVersion(versionId)
  }

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      if (!searchRef.current) return
      e.preventDefault()
      searchRef.current.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const today = localDate(new Date())
  const myAccountId = snapshot?.myAccountId ?? null

  const forest = useMemo<BoardForest | null>(
    () =>
      snapshot
        ? {
            groups: sortGroups(
              buildIssueForest(snapshot.issues, today, forestOptions(filter, snapshot.recentDoneDays)).groups,
              sort
            )
          }
        : null,
    [snapshot, sort, today, filter]
  )
  const filtered = useMemo(
    () => (forest ? filterForest(forest, filter, myAccountId) : null),
    [forest, filter, myAccountId]
  )
  const rows = useMemo(() => {
    if (!filtered) return []
    const auto = autoExpandIds(filtered, filter.query)
    return flattenVisible(filtered, effectiveExpanded(expanded, auto, filter.query), { foldDone: shouldFoldDone(filter) })
  }, [filtered, expanded, filter])
  const tiles = useMemo(
    () => (snapshot ? summaryTiles(snapshot.issues, today, myAccountId, snapshot.recentDoneDays) : []),
    [snapshot, today, myAccountId]
  )
  const facets = useMemo(() => deriveFacets(snapshot?.issues ?? []), [snapshot])
  const detail = forest ? detailTarget(forest, selectedKey) : null

  const goSettings = (): void => setView('settings')

  if (errorCode === 'not_connected' || errorCode === 'no_default_project') {
    return <ConnectPrompt kind={errorCode} message={error} onGoSettings={goSettings} />
  }

  if (!snapshot) {
    if (error && !loading) {
      return (
        <div className="space-y-4">
          <ErrorBanner error={error} lastSuccessAt={null} retrying={loading} onRetry={() => void load()} />
        </div>
      )
    }
    return (
      <Card>
        <EmptyState>Jira 티켓을 불러오는 중…</EmptyState>
      </Card>
    )
  }

  const renderDetail = (): React.ReactNode => {
    const epicKey = detail?.issue?.level === 'epic' ? detail.issue.key : null
    return (
      <IssueDetailPanel
        target={detail}
        today={today}
        aiSummary={epicKey ? aiSummaries[epicKey] : undefined}
        aiLoading={epicKey ? !!aiLoading[epicKey] : false}
        aiError={epicKey ? aiErrors[epicKey] : undefined}
        onSummarize={(k) => void summarizeEpic(k)}
        onOpenJira={openJira}
        onOpenRelease={openRelease}
        onOpenLink={openLink}
        onShowAllDocs={openDocsFor}
      />
    )
  }

  const filterOn = isFilterActive(filter, myAccountId)
  const allIds = forest ? expandableIds(forest) : []

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge color="bg-slate-100 text-slate-700" size="xs">
          Jira {snapshot.projectKey}
        </Badge>
        <span className={typo.metaFaint}>읽기 전용 · 할 일 이상 상태</span>
      </div>

      {error ? (
        <ErrorBanner
          error={error}
          lastSuccessAt={snapshot.fetchedAt}
          retrying={loading}
          onRetry={() => void sync('incremental')}
          onDismiss={dismissError}
        />
      ) : null}
      {snapshot.truncated ? <TruncatedNotice /> : null}
      {revealNotice ? (
        <div role="status" className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
          <span className="min-w-0 break-words">{revealNotice}</span>
          <button type="button" onClick={dismissRevealNotice} className="text-blue-600 hover:text-blue-800">
            닫기
          </button>
        </div>
      ) : null}
      {linkError ? (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          <span className="min-w-0 break-words">링크를 열지 못했어요 — {linkError}</span>
          <button type="button" onClick={() => setLinkError(null)} className="text-red-500 hover:text-red-700">
            닫기
          </button>
        </div>
      ) : null}

      <BoardSummaryTiles tiles={tiles} />

      <BoardToolbar
        filter={filter}
        facets={facets}
        sort={sort}
        myAccountId={myAccountId}
        recentDoneDays={snapshot.recentDoneDays}
        loading={loading}
        fetchedAt={snapshot.fetchedAt}
        lastFullSyncAt={snapshot.lastFullSyncAt}
        lastSync={lastSync}
        lastSyncRequested={lastSyncRequested}
        searchRef={searchRef}
        onFilterChange={setFilter}
        onClearFilter={clearFilter}
        onSortChange={setSort}
        onExpandAll={() => setAllExpanded(allIds, true)}
        onCollapseAll={() => setAllExpanded(allIds, false)}
        onRefresh={() => void sync('incremental')}
        onFullSync={() => void sync('full')}
      />

      {forest && forest.groups.length === 0 ? (
        <Card>
          <EmptyState>할 일 이상 상태의 티켓이 없어요</EmptyState>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState>
            <p>조건에 맞는 티켓이 없어요</p>
            {filterOn ? (
              <button type="button" onClick={clearFilter} className="mt-2 text-sm text-blue-600 hover:text-blue-700">
                필터 지우기
              </button>
            ) : null}
          </EmptyState>
        </Card>
      ) : (
        <div className="grid grid-cols-1 min-[1120px]:grid-cols-[minmax(0,1fr)_20rem] gap-4 items-start">
          <Card padding="none" className="overflow-hidden">
            <IssueTree
              rows={rows}
              forest={filtered ?? forest!}
              selectedId={selectedKey}
              today={today}
              onSelect={select}
              onToggle={setExpanded}
              onOpenJira={openJira}
              onOpenRelease={openRelease}
              renderInlineDetail={renderDetail}
            />
          </Card>
          <aside className="hidden min-[1120px]:block sticky top-0" aria-label="티켓 상세">
            <Card padding="sm">{renderDetail()}</Card>
          </aside>
        </div>
      )}
    </div>
  )
}
