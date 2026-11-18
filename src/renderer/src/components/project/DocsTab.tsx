import { useMemo, useState } from 'react'
import { Card, EmptyState, SearchIcon, taskTag, typo } from '../ui'
import { useJiraBoardStore } from '../../stores/jiraBoardStore'
import { useNavigationStore } from '../../stores/navigationStore'
import { CheckItem, FilterPopover, SyncControls, toggleIn } from './BoardControls'
import { IssueTypeIcon } from './BoardBits'
import { ConnectPrompt, ErrorBanner } from './BoardStates'
import { DocLinkLine } from './DocBits'
import { buildIssueForest, forestOptions, localDate } from './boardModel'
import {
  DOC_KIND_LABELS,
  DOC_KIND_ORDER,
  EMPTY_DOCS_FILTER,
  buildDocsView,
  type DocEntry,
  type DocGroup,
  type DocKind
} from './docsModel'
import { openBoardLink, revealInTickets } from './projectNav'

// 링크가 걸린 티켓 칩. 누르면 티켓 탭에서 그 이슈로 간다
function OriginChips({ entry }: { entry: DocEntry }): React.ReactNode {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 pl-7 text-xs text-gray-400">
      {entry.origins.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => revealInTickets(o.key)}
          title={`${o.key} ${o.summary} — 티켓 탭에서 보기`}
          className={`rounded px-1 text-[11px] hover:underline ${taskTag.issue}`}
        >
          {o.key}
        </button>
      ))}
      {entry.origins.length > 1 ? <span>{entry.origins.length}개 티켓에서 연결</span> : null}
    </div>
  )
}

function EntryList({ entries, onOpen }: { entries: DocEntry[]; onOpen: (url: string) => void }): React.ReactNode {
  return (
    <ul className="divide-y divide-gray-50">
      {entries.map((e) => (
        <li key={e.url} className="py-2" data-doc-kind={e.kind}>
          <DocLinkLine entry={e} onOpen={onOpen} />
          <OriginChips entry={e} />
        </li>
      ))}
    </ul>
  )
}

function GroupSection({ group, onOpen }: { group: DocGroup; onOpen: (url: string) => void }): React.ReactNode {
  const count = group.docs.length + group.issues.length
  return (
    <section className="px-5 py-4" aria-label={group.title} data-doc-group={group.id}>
      <header className="flex items-center gap-1.5 min-w-0">
        {group.kind === 'epic' ? (
          <IssueTypeIcon level="epic" typeName="에픽" />
        ) : (
          <span aria-hidden className="inline-block h-3.5 w-3.5 flex-shrink-0 rounded-sm border border-dashed border-gray-300" />
        )}
        {group.kind === 'epic' && group.epicKey ? (
          <button
            type="button"
            onClick={() => revealInTickets(group.epicKey!)}
            title="티켓 탭에서 보기"
            className={`flex-shrink-0 rounded px-1 text-[11px] hover:underline ${taskTag.issue}`}
          >
            {group.epicKey}
          </button>
        ) : group.epicKey ? (
          <span className={`flex-shrink-0 rounded px-1 text-[11px] ${taskTag.issue}`}>{group.epicKey}</span>
        ) : null}
        <h3 className="min-w-0 truncate text-sm font-semibold text-gray-900">{group.title}</h3>
        <span className={`${typo.metaFaint} flex-shrink-0`}>{count}</span>
      </header>
      {group.docs.length > 0 ? (
        <div className="mt-1">
          <EntryList entries={group.docs} onOpen={onOpen} />
        </div>
      ) : null}
      {group.issues.length > 0 ? (
        <div className="mt-2">
          <p className={`${typo.microLabel} mt-2`}>연결 이슈 {group.issues.length}</p>
          <EntryList entries={group.issues} onOpen={onOpen} />
        </div>
      ) : null}
    </section>
  )
}

/**
 * 문서 탭: 보드 스냅샷의 티켓 링크(웹링크·첨부·본문 링크·연결 이슈)를 에픽 → 티켓으로 묶어 모아 본다.
 * 보드와 같은 store·같은 보임 규칙·같은 "내 담당만" 값을 쓴다 (docs/PROJECT_BOARD.md).
 */
export default function DocsTab(): React.ReactNode {
  const {
    snapshot,
    loading,
    error,
    errorCode,
    filter,
    docsFilter,
    lastSync,
    lastSyncRequested,
    load,
    sync,
    setFilter,
    setDocsFilter,
    dismissError
  } = useJiraBoardStore()
  const setView = useNavigationStore((s) => s.setView)
  const [linkError, setLinkError] = useState<string | null>(null)
  const today = localDate(new Date())
  const myAccountId = snapshot?.myAccountId ?? null

  const forest = useMemo(
    () => (snapshot ? buildIssueForest(snapshot.issues, today, forestOptions(filter, snapshot.recentDoneDays)) : null),
    [snapshot, today, filter]
  )
  const view = useMemo(
    () => (forest ? buildDocsView(forest, docsFilter, { on: filter.mineOnly, myAccountId }) : null),
    [forest, docsFilter, filter.mineOnly, myAccountId]
  )

  if (errorCode === 'not_connected' || errorCode === 'no_default_project') {
    return <ConnectPrompt kind={errorCode} message={error} onGoSettings={() => setView('settings')} />
  }
  if (!snapshot || !view) {
    if (error && !loading) {
      return <ErrorBanner error={error} lastSuccessAt={null} retrying={loading} onRetry={() => void load()} />
    }
    return (
      <Card>
        <EmptyState>Jira 티켓을 불러오는 중…</EmptyState>
      </Card>
    )
  }

  const openLink = (url: string): void => {
    void openBoardLink(url).then(setLinkError)
  }
  const mineOn = filter.mineOnly && !!myAccountId
  const docsFiltered =
    docsFilter.query.trim() !== '' || docsFilter.kinds.length > 0 || docsFilter.sources.length > 0
  const shownCount = view.groups.reduce((n, g) => n + g.docs.length + g.issues.length, 0)
  const kindTotal = DOC_KIND_ORDER.reduce((n, k) => n + view.kindCounts[k], 0)

  return (
    <div className="space-y-4">
      {error ? (
        <ErrorBanner
          error={error}
          lastSuccessAt={snapshot.fetchedAt}
          retrying={loading}
          onRetry={() => void sync('incremental')}
          onDismiss={dismissError}
        />
      ) : null}
      {linkError ? (
        <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          <span className="min-w-0 break-words">링크를 열지 못했어요 — {linkError}</span>
          <button type="button" onClick={() => setLinkError(null)} className="text-red-500 hover:text-red-700">
            닫기
          </button>
        </div>
      ) : null}

      {/* 종류별 건수 요약이자 종류 토글. 숫자는 종류 필터를 뺀 값이다 */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="종류별 건수">
        <button
          type="button"
          aria-pressed={docsFilter.kinds.length === 0}
          onClick={() => setDocsFilter({ kinds: [] })}
          className={`rounded-full px-3 py-1 text-sm ${
            docsFilter.kinds.length === 0 ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          전체 <span className="tabular-nums">{kindTotal}</span>
        </button>
        {DOC_KIND_ORDER.map((k: DocKind) => {
          const on = docsFilter.kinds.includes(k)
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              data-kind-count={k}
              onClick={() => setDocsFilter({ kinds: toggleIn(docsFilter.kinds, k, !on) })}
              className={`rounded-full px-3 py-1 text-sm ${
                on ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {DOC_KIND_LABELS[k]} <span className="tabular-nums">{view.kindCounts[k]}</span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex-1 min-w-[12rem] max-w-sm">
          <span className="sr-only">문서 검색</span>
          <SearchIcon size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={docsFilter.query}
            onChange={(e) => setDocsFilter({ query: e.target.value })}
            placeholder="제목·URL·티켓 키 검색"
            className="w-full rounded-md border border-gray-200 bg-white py-1.5 pl-8 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </label>
        <FilterPopover label="출처" count={docsFilter.sources.length}>
          {view.sources.length === 0 ? <p className={`px-3 py-1.5 ${typo.metaFaint}`}>출처가 없어요</p> : null}
          {view.sources.map((s) => (
            <CheckItem
              key={s}
              checked={docsFilter.sources.includes(s)}
              onChange={(on) => setDocsFilter({ sources: toggleIn(docsFilter.sources, s, on) })}
            >
              {s}
            </CheckItem>
          ))}
        </FilterPopover>
        <label
          className={`inline-flex items-center gap-1.5 text-sm ${myAccountId ? 'text-gray-700' : 'text-gray-400'}`}
          title="티켓 탭의 '내 담당만'과 같은 설정이에요"
        >
          <input
            type="checkbox"
            checked={mineOn}
            disabled={!myAccountId}
            onChange={(e) => setFilter({ mineOnly: e.target.checked })}
          />
          내 담당만
        </label>
        <div className="ml-auto flex items-center gap-2">
          <SyncControls
            loading={loading}
            fetchedAt={snapshot.fetchedAt}
            lastFullSyncAt={snapshot.lastFullSyncAt}
            lastSync={lastSync}
            lastSyncRequested={lastSyncRequested}
            onRefresh={() => void sync('incremental')}
            onFullSync={() => void sync('full')}
          />
        </div>
      </div>

      {view.total === 0 ? (
        <Card>
          <EmptyState>
            {mineOn ? (
              <>
                <p>내 담당 티켓에 연결된 문서가 없어요</p>
                <button type="button" onClick={() => setFilter({ mineOnly: false })} className="mt-2 text-sm text-blue-600 hover:text-blue-700">
                  내 담당만 끄기
                </button>
              </>
            ) : (
              <p>연결된 문서가 없어요 — Jira 티켓에 웹링크를 추가하거나 본문에 링크를 넣으면 여기에 모여요</p>
            )}
          </EmptyState>
        </Card>
      ) : shownCount === 0 ? (
        <Card>
          <EmptyState>
            <p>조건에 맞는 문서가 없어요</p>
            {docsFiltered ? (
              <button type="button" onClick={() => setDocsFilter({ ...EMPTY_DOCS_FILTER })} className="mt-2 text-sm text-blue-600 hover:text-blue-700">
                필터 지우기
              </button>
            ) : null}
          </EmptyState>
        </Card>
      ) : (
        <Card padding="none" className="divide-y divide-gray-100">
          {view.groups.map((g) => (
            <GroupSection key={g.id} group={g} onOpen={openLink} />
          ))}
        </Card>
      )}
    </div>
  )
}
