import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMemoStore } from '../../stores/memoStore'
import { useFocusRequest, useFocusStore } from '../../stores/focusStore'
import { focusDomId, useFlash } from '../../hooks/useFocusFlash'
import MemoForm from './MemoForm'
import MemoViewer from './MemoViewer'
import CategoryManager from './CategoryManager'
import MemoRail, { MemoRailDropdown } from './MemoRail'
import MemoSearchInput from './MemoSearchInput'
import MemoScopeChips from './MemoScopeChips'
import MemoList, { type MemoListSection } from './MemoList'
import MemoReader from './MemoReader'
import { ChevronRightIcon, SortIcon } from './memoIcons'
import type { Memo, MemoCategory } from '../../types'
import { Card, ChevronDownIcon, DropdownMenu, EmptyState, button } from '../ui'
import {
  SORT_LABELS,
  buildRailItems,
  countMatches,
  groupImportantFirst,
  scopeChips,
  searchMemos,
  selectByRail,
  sortMemos,
  toListItem,
  type MemoSortOrder,
  type RailKey
} from './memoSearch'
import { isTypingTarget, layoutMode, moveSelection, neighborAfterRemoval, type MoveKey } from './memoNav'
import { parseMemoTitle } from './memoText'

// 메모를 읽기 영역에 이만큼 머물러 보면 '최근 본'에 기록한다. ↑↓로 훑을 때 기록이 넘치지 않게 한다
const RECENT_DWELL_MS = 800

const EMPTY_TEXT: Record<string, string> = {
  all: '아직 메모가 없어요. 새 메모를 만들어 보세요.',
  important: '중요 표시한 메모가 없어요.',
  recent: '최근 본 메모가 없어요.',
  archived: '보관한 메모가 없어요.',
  uncategorized: '미분류 메모가 없어요.',
  category: '이 분류에 메모가 없어요.'
}

const ARROW_KEYS: Record<string, MoveKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end'
}

// 메모 화면: 분류 레일 / 목록 + 상시 검색 / 고정 읽기 영역.
// 컨테이너 폭에 따라 3단 → 2단(레일 대신 드롭다운) → 1단(목록·읽기 전환)으로 접힌다
export default function MemoView(): React.ReactNode {
  const {
    memos,
    archivedMemos,
    categories,
    rail,
    sortOrder,
    query,
    scope,
    searchArchivedToo,
    selectedMemoId,
    recentIds,
    railCollapsed,
    setRail,
    setSortOrder,
    setQuery,
    setScope,
    setSearchArchivedToo,
    selectMemo,
    recordRecent,
    setRailCollapsed,
    revealMemo,
    fetchMemos,
    fetchArchivedMemos,
    fetchCategories,
    archiveMemo,
    restoreMemo,
    toggleImportant,
    deleteMemo,
    updateMemo
  } = useMemoStore()

  const [loaded, setLoaded] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingMemo, setEditingMemo] = useState<Memo | null>(null)
  const [showCategoryManager, setShowCategoryManager] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [pane, setPane] = useState<'list' | 'reader'>('list')
  const [searchFocused, setSearchFocused] = useState(false)
  const [width, setWidth] = useState(1000)
  const [now, setNow] = useState(() => new Date())
  const maxIdBeforeCreate = useRef<number | null>(null)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const listboxId = `${useId()}-memo-list`

  useEffect(() => {
    void Promise.all([fetchMemos(), fetchArchivedMemos(), fetchCategories()])
      .catch((e) => console.warn('[MemoView] 메모 불러오기 실패', e))
      .finally(() => setLoaded(true))
  }, [])

  // 상대 시각('n분 전')이 낡지 않게 1분마다 갱신한다
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  // 컨테이너 폭 측정. 사이드바 때문에 뷰포트 브레이크포인트는 맞지 않는다
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const mode = layoutMode(width)
  const showRail = mode === 'three' && !railCollapsed
  const searching = query.trim() !== ''

  // 지워진 분류를 가리키는 레일은 전체로 돌린다(분류를 다 불러온 뒤에만 판단)
  useEffect(() => {
    if (!loaded || typeof rail !== 'number') return
    if (!categories.some((c) => c.id === rail)) setRail('all')
  }, [loaded, rail, categories])

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const categoryOf = useCallback(
    (id: number | null): MemoCategory | null => (id == null ? null : (categoryById.get(id) ?? null)),
    [categoryById]
  )

  const railItems = useMemo(
    () => buildRailItems(memos, archivedMemos, categories),
    [memos, archivedMemos, categories]
  )

  // ---------- 목록 계산 ----------
  const allResults = useMemo(() => {
    if (!searching) return []
    const base =
      rail === 'archived' ? archivedMemos : searchArchivedToo ? [...memos, ...archivedMemos] : memos
    return searchMemos(base, categories, query)
  }, [searching, rail, searchArchivedToo, memos, archivedMemos, categories, query])
  const chips = useMemo(() => scopeChips(allResults, categories), [allResults, categories])
  const results = useMemo(
    () => (scope === null ? allResults : allResults.filter((r) => r.categoryKey === scope)),
    [allResults, scope]
  )

  const railList = useMemo(() => {
    const base = selectByRail(memos, archivedMemos, rail, recentIds, categories)
    return rail === 'recent' ? base : sortMemos(base, sortOrder)
  }, [memos, archivedMemos, rail, recentIds, categories, sortOrder])

  const sections = useMemo<MemoListSection[]>(() => {
    if (searching) return [{ key: 'results', label: null, items: results }]
    if (rail === 'all') {
      const { important, rest } = groupImportantFirst(railList)
      if (important.length === 0) return [{ key: 'rest', label: null, items: rest.map(toListItem) }]
      return [
        { key: 'important', label: '★ 중요', items: important.map(toListItem) },
        { key: 'rest', label: '메모', items: rest.map(toListItem) }
      ]
    }
    return [{ key: 'rail', label: null, items: railList.map(toListItem) }]
  }, [searching, results, rail, railList])

  const visibleIds = useMemo(() => sections.flatMap((s) => s.items.map((i) => i.memo.id)), [sections])
  const visibleKey = visibleIds.join(',')
  const showCategory = searching || (typeof rail !== 'number' && rail !== 'uncategorized')

  const memoById = useMemo(() => {
    const map = new Map<number, Memo>()
    for (const m of archivedMemos) map.set(m.id, m)
    for (const m of memos) map.set(m.id, m)
    return map
  }, [memos, archivedMemos])
  const selectedMemo = selectedMemoId !== null ? (memoById.get(selectedMemoId) ?? null) : null

  const recentList = useMemo(
    () =>
      recentIds
        .map((id) => memoById.get(id))
        .filter((m): m is Memo => m !== undefined)
        .map((m) => ({ id: m.id, title: parseMemoTitle(m.content).title })),
    [recentIds, memoById]
  )

  // ---------- 선택 규칙 ----------
  // 검색어·칩이 바뀌면 1위 결과를 바로 읽기 영역에 보인다(Top Hit)
  useEffect(() => {
    if (!searching) return
    if (results.length > 0) selectMemo(results[0].memo.id)
  }, [query, scope, searchArchivedToo])

  // 검색 중이 아니면 선택은 늘 목록 안에 있게 한다
  useEffect(() => {
    if (!loaded || searching) return
    if (selectedMemoId === null || !visibleIds.includes(selectedMemoId)) selectMemo(visibleIds[0] ?? null)
  }, [loaded, searching, rail, visibleKey])

  // 머물러 본 메모를 최근 본에 기록한다. 최근 본 레일을 보는 중에는 순서가 흔들리지 않게 기록하지 않는다
  useEffect(() => {
    if (selectedMemoId === null || rail === 'recent') return
    const id = selectedMemoId
    const t = setTimeout(() => recordRecent(id), RECENT_DWELL_MS)
    return () => clearTimeout(t)
  }, [selectedMemoId])

  // 선택 행을 목록 안에 보이게 한다
  useEffect(() => {
    if (selectedMemoId === null) return
    document.getElementById(focusDomId('memo', selectedMemoId))?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedMemoId, visibleKey])

  // 앱 내 링크(linkwork://memo/{id})로 들어오면 레일(전체/보관함)을 맞추고 검색을 풀고
  // 행을 강조하고 읽기 영역에 연다. 아직 목록에 없으면 로드를 기다리고, 끝내 없으면 focusStore TTL 이 지운다
  const focusRequest = useFocusRequest('memo')
  const [flashId, flash] = useFlash<number>()
  useEffect(() => {
    if (!focusRequest) return
    if (!revealMemo(focusRequest.id)) return
    flash(focusRequest.id)
    setPane('reader')
    useFocusStore.getState().consume(focusRequest.nonce)
  }, [focusRequest, memos, archivedMemos])

  // ---------- 동작 ----------
  const focusSearch = useCallback((): void => {
    setPane('list')
    // 1단에서 목록이 그려진 뒤에 포커스한다
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }, [])

  const changeQuery = (value: string): void => {
    // 검색을 지울 때, 검색으로 고른 메모가 현재 레일에 없으면 그 메모가 있는 레일로 옮겨 맥락을 잃지 않게 한다
    if (value.trim() === '' && searching && selectedMemoId !== null && !railList.some((m) => m.id === selectedMemoId)) {
      revealMemo(selectedMemoId)
      return
    }
    setQuery(value)
  }

  const openReader = (): void => {
    if (selectedMemoId === null) return
    if (mode === 'one') setPane('reader')
    else bodyRef.current?.focus()
  }

  const handleSelect = (id: number): void => {
    selectMemo(id)
    if (mode === 'one') setPane('reader')
  }

  const handleEdit = (memo: Memo): void => {
    if (memo.is_archived === 1) return
    setExpandedId(null)
    setEditingMemo(memo)
    setShowForm(true)
  }

  const handleNew = (): void => {
    maxIdBeforeCreate.current = memos.reduce((max, m) => Math.max(max, m.id), 0)
    setEditingMemo(null)
    setShowForm(true)
  }

  const handleCloseForm = (): void => {
    setShowForm(false)
    setEditingMemo(null)
    // 새로 만든 메모를 바로 선택해 읽기 영역에 보인다
    const before = maxIdBeforeCreate.current
    maxIdBeforeCreate.current = null
    if (before === null) return
    const created = useMemoStore.getState().memos.filter((m) => m.id > before)
    if (created.length === 0) return
    const id = created.reduce((max, m) => Math.max(max, m.id), 0)
    const s = useMemoStore.getState()
    const inRail = selectByRail(s.memos, s.archivedMemos, s.rail, s.recentIds, s.categories).some(
      (m) => m.id === id
    )
    if (searching || !inRail) revealMemo(id)
    else selectMemo(id)
  }

  const removeAndSelectNeighbor = async (id: number, action: (id: number) => Promise<void>, leaves: boolean): Promise<void> => {
    const next = leaves && selectedMemoId === id ? neighborAfterRemoval(visibleIds, id) : null
    await action(id)
    if (leaves && selectedMemoId === id) selectMemo(next)
  }

  const handleArchive = (id: number): void => {
    const leaves = !(rail === 'recent' || (searching && searchArchivedToo))
    void removeAndSelectNeighbor(id, archiveMemo, leaves)
  }
  const handleRestore = (id: number): void => {
    void removeAndSelectNeighbor(id, restoreMemo, rail === 'archived')
  }
  const handleDelete = (id: number): void => {
    void removeAndSelectNeighbor(id, deleteMemo, true)
  }

  // 분류를 바꾸면, 특정 분류 레일을 보던 중이면 새 분류 레일로 따라가 메모가 목록에서 사라지지 않게 한다
  const handleChangeCategory = (id: number, categoryId: number | null): void => {
    void updateMemo(id, { category_id: categoryId }).then(() => {
      if (!searching && (typeof rail === 'number' || rail === 'uncategorized')) {
        setRail(categoryId ?? 'uncategorized')
        selectMemo(id)
      }
    })
  }

  const handleRailSelect = (key: RailKey): void => {
    if (searching) setQuery('')
    setRail(key)
    setPane('list')
  }

  const modalOpen = showForm || showCategoryManager || expandedId !== null

  // 전역 단축키: '/' 또는 ⌘F 로 검색. 입력 중인 칸과 모달 위에서는 가로채지 않는다
  useEffect(() => {
    if (modalOpen) return
    const onKey = (e: KeyboardEvent): void => {
      const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)
      const findKey = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f'
      if (!slash && !findKey) return
      e.preventDefault()
      focusSearch()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalOpen, focusSearch])

  const move = (key: MoveKey): void => {
    const next = moveSelection(visibleIds, selectedMemoId, key)
    if (next !== null) selectMemo(next)
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (modalOpen || e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      move(ARROW_KEYS[e.key])
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openReader()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (query) changeQuery('')
      else inputRef.current?.blur()
    }
  }

  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (modalOpen || (e.target !== e.currentTarget && isTypingTarget(e.target))) return
    const k = ARROW_KEYS[e.key]
    if (k) {
      e.preventDefault()
      move(k)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openReader()
    } else if (e.key === 'e' && !e.metaKey && !e.ctrlKey && !e.altKey && selectedMemo) {
      e.preventDefault()
      handleEdit(selectedMemo)
    } else if (e.key === 'Escape' && query) {
      e.preventDefault()
      changeQuery('')
    }
  }

  const handleBodyKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (modalOpen) return
    if (e.key === 'Escape') {
      e.preventDefault()
      setPane('list')
      setTimeout(() => listRef.current?.focus(), 0)
    } else if (e.key === 'e' && !e.metaKey && !e.ctrlKey && !e.altKey && selectedMemo) {
      e.preventDefault()
      handleEdit(selectedMemo)
    }
  }

  // ---------- 그리기 ----------
  const currentRailItem = railItems.find((it) => it.key === rail)
  const searchWhere =
    rail === 'archived' ? '보관함에서' : searchArchivedToo ? '전체·보관함에서' : '전체에서'

  const sortItems = (Object.keys(SORT_LABELS) as MemoSortOrder[]).map((key) => ({
    key,
    label: SORT_LABELS[key],
    selected: key === sortOrder,
    onSelect: () => setSortOrder(key)
  }))

  const emptyContent = !loaded && memos.length === 0 ? (
    <EmptyState>메모를 불러오는 중…</EmptyState>
  ) : searching ? (
    <EmptyState>
      <p className="text-sm text-gray-500 break-all">‘{query.trim()}’와 일치하는 메모가 없어요</p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {rail !== 'archived' && !searchArchivedToo && archivedMemos.length > 0 ? (
          <button
            type="button"
            onClick={() => setSearchArchivedToo(true)}
            className={`px-3 py-1.5 text-xs ${button.subtle}`}
          >
            보관함에서도 찾기
          </button>
        ) : null}
        {scope !== null ? (
          <button type="button" onClick={() => setScope(null)} className={`px-3 py-1.5 text-xs ${button.subtle}`}>
            분류 좁히기 풀기
          </button>
        ) : null}
        <button type="button" onClick={() => changeQuery('')} className={`px-3 py-1.5 text-xs ${button.subtle}`}>
          검색어 지우기
        </button>
      </div>
    </EmptyState>
  ) : (
    <EmptyState>
      <p className="text-sm">{EMPTY_TEXT[typeof rail === 'number' ? 'category' : rail]}</p>
    </EmptyState>
  )

  const recentStrip =
    searchFocused && !searching && rail !== 'recent' && recentList.length > 0 ? (
      <div className="px-3 pb-2">
        <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-1">최근 본</p>
        <ul className="space-y-0.5">
          {recentList.slice(0, 5).map((r) => (
            <li key={r.id}>
              <button
                type="button"
                // 입력창 blur 로 목록이 사라지기 전에 누름을 받는다
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (visibleIds.includes(r.id)) selectMemo(r.id)
                  else revealMemo(r.id)
                  if (mode === 'one') setPane('reader')
                }}
                className="w-full truncate text-left text-xs text-gray-600 px-1.5 py-1 rounded hover:bg-gray-100"
              >
                {r.title}
              </button>
            </li>
          ))}
        </ul>
      </div>
    ) : null

  const listColumn = (
    <Card
      padding="none"
      className={`flex flex-col min-h-0 overflow-hidden ${
        mode === 'one' ? 'flex-1 min-w-0' : mode === 'two' ? 'w-64 flex-shrink-0' : 'w-72 flex-shrink-0'
      }`}
    >
      <div className="p-3 pb-2 space-y-2 border-b border-gray-100">
        <MemoSearchInput
          value={query}
          onChange={changeQuery}
          onKeyDown={handleInputKeyDown}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          listboxId={listboxId}
          activeOptionId={
            selectedMemoId !== null && visibleIds.includes(selectedMemoId) ? focusDomId('memo', selectedMemoId) : null
          }
          inputRef={inputRef}
        />
        <div className="flex items-center gap-1.5">
          {!showRail ? (
            <>
              {mode === 'three' ? (
                <button
                  type="button"
                  onClick={() => setRailCollapsed(false)}
                  title="분류 레일 펼치기"
                  aria-label="분류 레일 펼치기"
                  className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <ChevronRightIcon size={14} />
                </button>
              ) : null}
              <MemoRailDropdown
                items={railItems}
                selected={rail}
                onSelect={handleRailSelect}
                onManageCategories={() => setShowCategoryManager(true)}
              />
            </>
          ) : null}
          <span role="status" className="flex-1 min-w-0 truncate text-xs text-gray-500">
            {searching ? (
              <>
                {searchWhere} <span className="font-semibold text-gray-800 tabular-nums">{allResults.length}</span>건
              </>
            ) : showRail && currentRailItem ? (
              <>
                <span className="font-semibold text-gray-800">{currentRailItem.label}</span>{' '}
                <span className="tabular-nums">{visibleIds.length}</span>
              </>
            ) : null}
          </span>
          {!searching && rail !== 'recent' ? (
            <DropdownMenu
              align="right"
              width="w-36"
              items={sortItems}
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  title={`정렬: ${SORT_LABELS[sortOrder]}`}
                  className="flex items-center gap-0.5 px-1.5 py-1 rounded-md text-xs text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <SortIcon size={13} />
                  <span className="sr-only">정렬: </span>
                  <span className={mode === 'two' ? 'sr-only' : ''}>{SORT_LABELS[sortOrder]}</span>
                  <ChevronDownIcon size={11} />
                </button>
              )}
            />
          ) : null}
          {rail !== 'archived' ? (
            <button
              type="button"
              onClick={handleNew}
              className={`flex-shrink-0 px-2.5 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${button.primary}`}
            >
              + 새 메모
            </button>
          ) : null}
        </div>
        {searching ? <MemoScopeChips chips={chips} selected={scope} onToggle={setScope} /> : null}
      </div>
      {recentStrip}
      <MemoList
        listboxId={listboxId}
        listRef={listRef}
        sections={sections}
        selectedId={selectedMemoId}
        flashId={flashId}
        categoryOf={categoryOf}
        showCategory={showCategory}
        now={now}
        onSelect={handleSelect}
        onToggleImportant={(id) => void toggleImportant(id)}
        onKeyDown={handleListKeyDown}
        empty={emptyContent}
      />
    </Card>
  )

  const expandedMemo = expandedId !== null ? (memoById.get(expandedId) ?? null) : null

  return (
    <div ref={rootRef} className="h-full min-h-[420px] flex gap-3">
      {showRail ? (
        <Card padding="none" className="w-44 flex-shrink-0 flex flex-col min-h-0 overflow-hidden">
          <MemoRail
            items={railItems}
            selected={rail}
            dimmed={searching}
            onSelect={handleRailSelect}
            onManageCategories={() => setShowCategoryManager(true)}
            onCollapse={() => setRailCollapsed(true)}
          />
        </Card>
      ) : null}

      {mode !== 'one' || pane === 'list' ? listColumn : null}

      {mode !== 'one' || pane === 'reader' ? (
        <Card padding="none" className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden">
          <MemoReader
            memo={selectedMemo}
            category={selectedMemo ? categoryOf(selectedMemo.category_id) : null}
            categories={categories}
            query={searching ? query : ''}
            matchCount={searching && selectedMemo ? countMatches(selectedMemo.content, query) : 0}
            onEdit={handleEdit}
            onToggleImportant={(id) => void toggleImportant(id)}
            onArchive={handleArchive}
            onRestore={handleRestore}
            onDelete={handleDelete}
            onChangeCategory={handleChangeCategory}
            onExpand={(m) => setExpandedId(m.id)}
            onBack={mode === 'one' ? () => setPane('list') : undefined}
            recent={recentList}
            onOpenRecent={(id) => {
              if (visibleIds.includes(id)) selectMemo(id)
              else revealMemo(id)
            }}
            bodyRef={bodyRef}
            onBodyKeyDown={handleBodyKeyDown}
          />
        </Card>
      ) : null}

      {showForm && (
        <MemoForm
          onClose={handleCloseForm}
          editingMemo={editingMemo}
          defaultCategoryId={typeof rail === 'number' ? rail : null}
        />
      )}

      {showCategoryManager && <CategoryManager onClose={() => setShowCategoryManager(false)} />}

      {expandedMemo && (
        <MemoViewer
          memo={expandedMemo}
          onClose={() => setExpandedId(null)}
          onEdit={expandedMemo.is_archived === 1 ? undefined : handleEdit}
        />
      )}
    </div>
  )
}
