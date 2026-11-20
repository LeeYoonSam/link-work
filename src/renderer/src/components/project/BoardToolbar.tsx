import type { RefObject } from 'react'
import { SearchIcon, XIcon, button, typo } from '../ui'
import { CheckItem, FilterPopover, SyncControls, toggleIn } from './BoardControls'
import {
  CATEGORY_LABELS,
  NO_RELEASE,
  SORT_LABELS,
  type BoardFacets,
  type BoardFilter,
  type BoardSort,
  type StatusCategory
} from './boardModel'

const CATEGORIES: StatusCategory[] = ['indeterminate', 'new', 'done']

interface BoardToolbarProps {
  filter: BoardFilter
  facets: BoardFacets
  sort: BoardSort
  myAccountId: string | null
  /** 최근 완료로 보는 기간(일). 완료 토글 설명에 쓴다 */
  recentDoneDays: number
  loading: boolean
  /** 마지막 동기화 시각(스냅샷 fetchedAt) */
  fetchedAt: string | null
  /** 마지막 전체 동기화 시각. 시각 툴팁에 보인다 */
  lastFullSyncAt: string | null
  /** 마지막 동기화 결과. cache 면 표시하지 않는다 */
  lastSync: { mode: 'full' | 'incremental' | 'cache'; changed: number } | null
  lastSyncRequested: 'auto' | 'incremental' | 'full' | null
  searchRef: RefObject<HTMLInputElement | null>
  onFilterChange: (patch: Partial<BoardFilter>) => void
  onClearFilter: () => void
  onSortChange: (sort: BoardSort) => void
  onExpandAll: () => void
  onCollapseAll: () => void
  /** 새로고침 = 바뀐 티켓만(incremental) */
  onRefresh: () => void
  /** 전체 다시 받기(full) */
  onFullSync: () => void
}

export default function BoardToolbar(p: BoardToolbarProps): React.ReactNode {
  const { filter: f, facets } = p
  const chips: { key: string; label: string; remove: () => void }[] = []
  if (f.query.trim()) chips.push({ key: 'q', label: `검색: ${f.query.trim()}`, remove: () => p.onFilterChange({ query: '' }) })
  for (const c of f.categories) {
    chips.push({
      key: `c:${c}`,
      label: CATEGORY_LABELS[c],
      remove: () => p.onFilterChange({ categories: f.categories.filter((x) => x !== c) })
    })
  }
  for (const s of f.statuses) {
    chips.push({ key: `s:${s}`, label: s, remove: () => p.onFilterChange({ statuses: f.statuses.filter((x) => x !== s) }) })
  }
  for (const t of f.types) {
    chips.push({ key: `t:${t}`, label: t, remove: () => p.onFilterChange({ types: f.types.filter((x) => x !== t) }) })
  }
  for (const r of f.releases) {
    chips.push({
      key: `r:${r}`,
      label: r === NO_RELEASE ? '릴리스 없음' : `릴리스 ${r}`,
      remove: () => p.onFilterChange({ releases: f.releases.filter((x) => x !== r) })
    })
  }
  if (f.mineOnly && p.myAccountId) chips.push({ key: 'mine', label: '내 담당만', remove: () => p.onFilterChange({ mineOnly: false }) })
  if (f.hideDone) chips.push({ key: 'done', label: '완료 모두 숨김', remove: () => p.onFilterChange({ hideDone: false }) })

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex-1 min-w-[12rem] max-w-sm">
          <span className="sr-only">키·제목 검색</span>
          <SearchIcon size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            ref={p.searchRef}
            type="search"
            value={f.query}
            onChange={(e) => p.onFilterChange({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && f.query) {
                e.stopPropagation()
                p.onFilterChange({ query: '' })
              }
            }}
            placeholder="키·제목 검색 ( / )"
            className="w-full rounded-md border border-gray-200 bg-white py-1.5 pl-8 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </label>
        <FilterPopover label="상태" count={f.categories.length + f.statuses.length}>
          <p className={`px-3 pt-1 pb-1 ${typo.microLabel}`}>분류</p>
          {CATEGORIES.map((c) => (
            <CheckItem
              key={c}
              checked={f.categories.includes(c)}
              onChange={(on) => p.onFilterChange({ categories: toggleIn(f.categories, c, on) })}
            >
              {CATEGORY_LABELS[c]}
            </CheckItem>
          ))}
          {facets.statuses.length > 0 ? (
            <>
              <div className="my-1 border-t border-gray-100" />
              <p className={`px-3 pt-1 pb-1 ${typo.microLabel}`}>세부 상태</p>
              {facets.statuses.map((s) => (
                <CheckItem
                  key={s.name}
                  checked={f.statuses.includes(s.name)}
                  onChange={(on) => p.onFilterChange({ statuses: toggleIn(f.statuses, s.name, on) })}
                >
                  {s.name}
                </CheckItem>
              ))}
            </>
          ) : null}
        </FilterPopover>
        <FilterPopover label="유형" count={f.types.length}>
          {facets.types.length === 0 ? <p className={`px-3 py-1.5 ${typo.metaFaint}`}>유형이 없어요</p> : null}
          {facets.types.map((t) => (
            <CheckItem key={t} checked={f.types.includes(t)} onChange={(on) => p.onFilterChange({ types: toggleIn(f.types, t, on) })}>
              {t}
            </CheckItem>
          ))}
        </FilterPopover>
        <FilterPopover label="릴리스" count={f.releases.length}>
          {facets.releases.length === 0 && !facets.hasNoRelease ? (
            <p className={`px-3 py-1.5 ${typo.metaFaint}`}>릴리스가 없어요</p>
          ) : null}
          {facets.hasNoRelease ? (
            <CheckItem
              checked={f.releases.includes(NO_RELEASE)}
              onChange={(on) => p.onFilterChange({ releases: toggleIn(f.releases, NO_RELEASE, on) })}
            >
              릴리스 없음
            </CheckItem>
          ) : null}
          {facets.releases.map((r) => (
            <CheckItem key={r} checked={f.releases.includes(r)} onChange={(on) => p.onFilterChange({ releases: toggleIn(f.releases, r, on) })}>
              {r}
            </CheckItem>
          ))}
        </FilterPopover>
        <label
          className={`inline-flex items-center gap-1.5 text-sm ${p.myAccountId ? 'text-gray-700' : 'text-gray-400'}`}
          title={p.myAccountId ? undefined : '내 Jira 계정을 확인하지 못해 쓸 수 없어요'}
        >
          <input
            type="checkbox"
            checked={f.mineOnly && !!p.myAccountId}
            disabled={!p.myAccountId}
            onChange={(e) => p.onFilterChange({ mineOnly: e.target.checked })}
          />
          내 담당만
        </label>
        <label
          className="inline-flex items-center gap-1.5 text-sm text-gray-700"
          title={`최근 ${p.recentDoneDays}일 안에 끝난 것까지 완료 티켓을 모두 숨겨요`}
        >
          <input type="checkbox" checked={f.hideDone} onChange={(e) => p.onFilterChange({ hideDone: e.target.checked })} />
          완료 모두 숨김
        </label>
        <label
          className={`inline-flex items-center gap-1.5 text-sm ${f.hideDone ? 'text-gray-400' : 'text-gray-700'}`}
          title={
            f.hideDone
              ? '완료 모두 숨김이 켜져 있어 쓸 수 없어요'
              : `${p.recentDoneDays}일보다 오래전에 끝난 티켓도 보여줘요. 끄면 건수로만 셉니다`
          }
        >
          <input
            type="checkbox"
            checked={f.showPastDone && !f.hideDone}
            disabled={f.hideDone}
            onChange={(e) => p.onFilterChange({ showPastDone: e.target.checked })}
          />
          이전 완료 보기
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1.5 text-sm text-gray-500">
          정렬
          <select
            value={p.sort}
            onChange={(e) => p.onSortChange(e.target.value as BoardSort)}
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-sm text-gray-700"
          >
            {(Object.keys(SORT_LABELS) as BoardSort[]).map((s) => (
              <option key={s} value={s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <div className="inline-flex">
          <button type="button" onClick={p.onExpandAll} className={`px-2.5 py-1 text-sm ${button.subtle} rounded-r-none`}>
            모두 펼치기
          </button>
          <button
            type="button"
            onClick={p.onCollapseAll}
            className={`px-2.5 py-1 text-sm ${button.subtle} rounded-l-none border-l border-gray-200`}
          >
            모두 접기
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <SyncControls
            loading={p.loading}
            fetchedAt={p.fetchedAt}
            lastFullSyncAt={p.lastFullSyncAt}
            lastSync={p.lastSync}
            lastSyncRequested={p.lastSyncRequested}
            onRefresh={p.onRefresh}
            onFullSync={p.onFullSync}
          />
        </div>
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="적용된 필터">
          {chips.map((c) => (
            <span key={c.key} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
              {c.label}
              <button type="button" onClick={c.remove} aria-label={`${c.label} 필터 해제`} className="text-gray-400 hover:text-gray-600">
                <XIcon size={12} />
              </button>
            </span>
          ))}
          <button type="button" onClick={p.onClearFilter} className="text-xs text-blue-600 hover:text-blue-700">
            필터 지우기
          </button>
        </div>
      ) : null}
    </div>
  )
}
