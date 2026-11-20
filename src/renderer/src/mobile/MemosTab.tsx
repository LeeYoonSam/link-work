// 모바일 '메모' 탭. 둥근 검색 필드 + 카테고리 칩 줄(전체·중요·카테고리, 가로 스크롤) + 카드형 미리보기 목록.
// 카드를 누르면 전체 화면 상세(뒤로 버튼·마크다운), '새 메모' FAB 는 전체 화면 작성(큰 입력·하단 고정 저장 바)으로 간다.
// 상세·작성 중에는 탭바를 숨긴다(html[data-m-full]). 본문은 MobileMarkdown(살균)으로만 그린다.
// 시각은 SQLite UTC 문자열일 수 있어 데스크톱과 같은 parseDbTime 으로 읽는다(9시간 이르게 보이던 버그 방지).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Memo, MemoCategory } from '../types'
import { formatDbTime, formatRelative, isValidDate, parseDbTime, parseMemoTitle } from '../components/memo/memoText'
import type { MemoListItem } from '../components/memo/memoSearch'
import { errorText, isNetworkError } from './api'
import MobileMarkdown from './MobileMarkdown'
import { MEMO_MAX_LENGTH, buildMemoBody, createRequestGate, localMemo, visibleMemos, type MemoDraft, type MemoFilter } from './mobileModel'
import type { TabProps } from './TodayTab'
import { Empty, ErrorNote, PageHeader, RefreshButton, Skeleton } from './ui'

function StarMark(): React.ReactNode {
  return (
    <span className="m-star inline-flex shrink-0" title="중요">
      <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden>
        <path d="M10 1.8l2.5 5.2 5.7.8-4.1 4 1 5.7L10 14.8l-5.1 2.7 1-5.7-4.1-4 5.7-.8z" fill="currentColor" />
      </svg>
      <span className="m-sr">중요</span>
    </span>
  )
}

function CategoryChip({ category }: { category: MemoCategory | null }): React.ReactNode {
  return (
    <span className="m-chip max-w-[12rem]">
      <span aria-hidden className="m-dot" style={category ? { backgroundColor: category.color } : { border: '1.5px solid currentColor' }} />
      <span className="m-ellipsis">{category ? category.name : '미분류'}</span>
    </span>
  )
}

function SearchIcon(): React.ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

export interface MemoListViewProps {
  memos: Memo[] | null
  categories: MemoCategory[]
  filter: MemoFilter
  query: string
  now: Date
  error: string | null
  refreshing: boolean
  onFilter: (f: MemoFilter) => void
  onQuery: (q: string) => void
  onOpen: (id: number) => void
  onNew: () => void
  onRefresh: () => void
}

/** 메모 목록 본문. 훅을 쓰지 않는다 */
export function MemoListView(p: MemoListViewProps): React.ReactNode {
  const items: MemoListItem[] | null = p.memos ? visibleMemos(p.memos, p.categories, p.filter, p.query) : null
  const catById = new Map(p.categories.map((c) => [c.id, c]))
  const filters: { key: MemoFilter; label: string }[] = [
    { key: 'all', label: '전체' },
    { key: 'important', label: '중요' },
    ...[...p.categories].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map((c) => ({ key: c.id as MemoFilter, label: c.name }))
  ]
  return (
    <>
      <PageHeader title="메모" actions={<RefreshButton busy={p.refreshing} onClick={p.onRefresh} />} />
      <div className="m-stack">
        <label className="m-search">
          <SearchIcon />
          <input
            type="search"
            value={p.query}
            onChange={(e) => p.onQuery(e.currentTarget.value)}
            placeholder="제목·본문·분류 검색"
            aria-label="메모 검색"
            enterKeyHint="search"
          />
          {p.query ? (
            <button type="button" aria-label="검색어 지우기" onClick={() => p.onQuery('')} className="m-icon-btn">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="m7 7 10 10M17 7 7 17" />
              </svg>
            </button>
          ) : null}
        </label>
        <div role="group" aria-label="분류" className="m-chips">
          {filters.map((f) => {
            const cat = typeof f.key === 'number' ? catById.get(f.key) : undefined
            return (
              <button
                key={String(f.key)}
                type="button"
                aria-pressed={p.filter === f.key}
                data-filter={String(f.key)}
                onClick={() => p.onFilter(f.key)}
                className="m-filter"
              >
                {cat ? <span aria-hidden className="m-dot" style={{ backgroundColor: cat.color }} /> : null}
                {f.key === 'important' ? <StarMark /> : null}
                {f.label}
              </button>
            )
          })}
        </div>
        <ErrorNote text={p.error} />
        {items === null ? (
          <Skeleton />
        ) : items.length === 0 ? (
          <div className="m-card">
            <Empty>{p.query.trim() ? '검색 결과가 없어요.' : '메모가 없어요.'}</Empty>
          </div>
        ) : (
          <ul className="m-stack" aria-label="메모 목록">
            {items.map(({ memo, title, excerpt }) => {
              const updated = parseDbTime(memo.updated_at)
              const category = memo.category_id !== null ? (catById.get(memo.category_id) ?? null) : null
              return (
                <li key={memo.id} data-memo={memo.id}>
                  <button type="button" onClick={() => p.onOpen(memo.id)} className="m-card m-memo-card">
                    <span className="flex items-start gap-2">
                      {memo.is_important === 1 ? (
                        <span className="pt-0.5">
                          <StarMark />
                        </span>
                      ) : null}
                      <span data-primary className="m-body-strong m-clamp-2 min-w-0 flex-1 m-t17">
                        {title}
                      </span>
                    </span>
                    {excerpt.text ? <span className="m-sub m-clamp-3 mt-1">{excerpt.text}</span> : null}
                    <span className="m-row-meta m-mt-10">
                      <CategoryChip category={category} />
                      <time dateTime={isValidDate(updated) ? updated.toISOString() : undefined} className="m-meta">
                        {formatRelative(updated, p.now)}
                      </time>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <button type="button" onClick={p.onNew} className="m-fab">
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        새 메모
      </button>
    </>
  )
}

/** 전체 화면 상단 바: 왼쪽 동작 · 가운데 작은 제목 · 오른쪽 동작 */
function TopBar({ left, title, right }: { left: React.ReactNode; title: React.ReactNode; right?: React.ReactNode }): React.ReactNode {
  return (
    <header className="m-header">
      <div className="flex w-[76px] shrink-0 justify-start">{left}</div>
      <h1 className="m-title-sm">{title}</h1>
      <div className="flex w-[76px] shrink-0 justify-end">{right}</div>
    </header>
  )
}

/** 메모 전체 보기 */
export function MemoDetailView({
  memo,
  category,
  onBack
}: {
  memo: Memo
  category: MemoCategory | null
  onBack: () => void
}): React.ReactNode {
  const created = formatDbTime(memo.created_at, 'yyyy-MM-dd HH:mm')
  const meta = memo.updated_at === memo.created_at ? `작성 ${created}` : `수정 ${formatDbTime(memo.updated_at, 'yyyy-MM-dd HH:mm')} · 작성 ${created}`
  return (
    <article>
      <TopBar
        left={
          <button type="button" onClick={onBack} className="m-text-btn -ml-2">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 5-7 7 7 7" />
            </svg>
            목록
          </button>
        }
        title={parseMemoTitle(memo.content).title}
      />
      <div className="m-stack">
        <div className="flex flex-wrap items-center gap-2 px-1">
          {memo.is_important === 1 ? <StarMark /> : null}
          <CategoryChip category={category} />
          <span className="m-meta">{meta}</span>
        </div>
        <div className="m-card m-card-roomy">
          <MobileMarkdown content={memo.content} />
        </div>
      </div>
    </article>
  )
}

/** 새 메모 작성(전체 화면). 훅을 쓰지 않는다(초안은 부모가 갖는다) */
export function MemoComposer({
  draft,
  categories,
  saving,
  error,
  onChange,
  onCancel,
  onSave
}: {
  draft: MemoDraft
  categories: MemoCategory[]
  saving: boolean
  error: string | null
  onChange: (d: MemoDraft) => void
  onCancel: () => void
  onSave: () => void
}): React.ReactNode {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave()
      }}
    >
      <TopBar
        left={
          <button type="button" onClick={onCancel} disabled={saving} className="m-text-btn -ml-2">
            취소
          </button>
        }
        title="새 메모"
      />
      <div className="m-stack">
        <ErrorNote text={error} />
        <div className="m-card m-card-flush">
          <label className="m-field">
            <span className="m-body">카테고리</span>
            <select
              value={draft.categoryId === null ? '' : String(draft.categoryId)}
              disabled={saving}
              onChange={(e) => onChange({ ...draft, categoryId: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
            >
              <option value="">미분류</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="m-field m-divide-top">
            <span id="m-important-label" className="m-body">
              중요 메모
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={draft.important}
              aria-labelledby="m-important-label"
              disabled={saving}
              onClick={() => onChange({ ...draft, important: !draft.important })}
              className="m-switch"
            />
          </div>
        </div>
        <textarea
          value={draft.content}
          onChange={(e) => {
            if (!saving) onChange({ ...draft, content: e.currentTarget.value })
          }}
          placeholder="첫 줄이 제목이 돼요. 마크다운을 쓸 수 있어요."
          aria-label="메모 내용"
          rows={10}
          readOnly={saving}
          aria-busy={saving}
          className="m-textarea"
        />
        <div aria-hidden className="m-compose-space" />
      </div>
      <div className="m-savebar">
        <span className="m-meta shrink-0">
          {draft.content.length.toLocaleString()} / {MEMO_MAX_LENGTH.toLocaleString()}
        </span>
        <button type="submit" disabled={saving || !draft.content.trim()} className="m-btn">
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </form>
  )
}

const EMPTY_DRAFT: MemoDraft = { content: '', categoryId: null, important: false }

interface MemosTabProps extends TabProps {
  /** 작성 중 초안. 탭을 바꿔도(이 컴포넌트가 내려가도) 남도록 MobileApp 이 갖는다. null = 작성 중 아님 */
  draft: MemoDraft | null
  onDraft: (d: MemoDraft | null) => void
}

export default function MemosTab({ api, reloadKey, onOk, onFail, draft, onDraft: setDraft }: MemosTabProps): React.ReactNode {
  const [memos, setMemos] = useState<Memo[] | null>(null)
  const [categories, setCategories] = useState<MemoCategory[]>([])
  const [filter, setFilter] = useState<MemoFilter>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // 새로고침·작성 뒤 다시 읽기가 겹칠 수 있다. 마지막으로 시작한 읽기의 응답만 적용한다
  // (작성 전에 시작한 읽기가 늦게 와서 방금 넣은 메모를 지우지 않게)
  const gate = useRef(createRequestGate()).current

  const load = useCallback(async (): Promise<void> => {
    const seq = gate.begin()
    setRefreshing(true)
    try {
      const res = await api.getMemos()
      if (!gate.isLatest(seq)) return
      setMemos(res.memos)
      setCategories(res.categories)
      setError(null)
      onOk()
    } catch (e) {
      if (!gate.isLatest(seq)) return
      onFail(e)
      setError(isNetworkError(e) ? null : errorText(e))
    } finally {
      if (gate.isLatest(seq)) setRefreshing(false)
    }
  }, [api, onOk, onFail, gate])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  // 지운 카테고리를 고르고 있었다면 전체로 돌린다
  useEffect(() => {
    if (typeof filter === 'number' && memos && !categories.some((c) => c.id === filter)) setFilter('all')
  }, [filter, categories, memos])

  // 보관했다 되살린 초안의 카테고리가 지워졌으면 미분류로 돌린다
  useEffect(() => {
    if (draft && draft.categoryId !== null && memos && !categories.some((c) => c.id === draft.categoryId)) {
      setDraft({ ...draft, categoryId: null })
    }
  }, [draft, categories, memos, setDraft])

  const save = async (): Promise<void> => {
    if (!draft || saving) return
    const built = buildMemoBody(draft)
    if (!built.ok) {
      setSaveError(built.error)
      return
    }
    setSaving(true)
    setSaveError(null)
    try {
      const { id } = await api.createMemo(built.body)
      onOk()
      gate.invalidate()
      setMemos((cur) => [localMemo(id, draft, new Date()), ...(cur ?? []).filter((m) => m.id !== id)])
      setDraft(null)
      setFilter('all')
      setQuery('')
      void load()
    } catch (e) {
      onFail(e)
      setSaveError(isNetworkError(e) ? 'Mac 에 연결할 수 없어 저장하지 못했어요. 작성한 내용은 그대로 있어요.' : `저장하지 못했어요: ${errorText(e)}`)
    } finally {
      setSaving(false)
    }
  }

  // 상세·작성은 전체 화면이다: 탭바를 숨긴다
  const composing = !!draft
  const fullScreen = composing || (openId !== null && !!memos?.some((m) => m.id === openId))
  useEffect(() => {
    const root = document.documentElement
    if (fullScreen) root.setAttribute('data-m-full', '')
    else root.removeAttribute('data-m-full')
    return () => root.removeAttribute('data-m-full')
  }, [fullScreen])

  // 작성 중에는 키보드 높이(--m-kb)를 따라 하단 저장 바를 키보드 위로 올린다(iOS 는 fixed 가 키보드에 가린다)
  useEffect(() => {
    if (!composing) return
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const update = (): void => {
      root.style.setProperty('--m-kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      root.style.removeProperty('--m-kb')
    }
  }, [composing])

  if (draft) {
    return (
      <MemoComposer
        draft={draft}
        categories={categories}
        saving={saving}
        error={saveError}
        onChange={setDraft}
        onCancel={() => {
          if (draft.content.trim() && !window.confirm('작성 중인 메모를 버릴까요?')) return
          setDraft(null)
          setSaveError(null)
        }}
        onSave={() => void save()}
      />
    )
  }

  const opened = openId !== null ? memos?.find((m) => m.id === openId) : undefined
  if (opened) {
    return (
      <MemoDetailView
        memo={opened}
        category={opened.category_id !== null ? (categories.find((c) => c.id === opened.category_id) ?? null) : null}
        onBack={() => {
          setOpenId(null)
          window.scrollTo(0, 0)
        }}
      />
    )
  }

  return (
    <MemoListView
      memos={memos}
      categories={categories}
      filter={filter}
      query={query}
      now={new Date()}
      error={error}
      refreshing={refreshing}
      onFilter={setFilter}
      onQuery={setQuery}
      onOpen={(id) => {
        setOpenId(id)
        window.scrollTo(0, 0)
      }}
      onNew={() => {
        setSaveError(null)
        setDraft({ ...EMPTY_DRAFT, categoryId: typeof filter === 'number' ? filter : null, important: filter === 'important' })
      }}
      onRefresh={() => void load()}
    />
  )
}
