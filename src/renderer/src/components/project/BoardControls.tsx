// 프로젝트 페이지 툴바 조각: 다중 선택 팝오버, 동기화 표시·버튼
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDownIcon, DropdownMenu, Tooltip, button, typo } from '../ui'
import { RefreshIcon } from './BoardBits'
import { clockTime, shortDateTime, syncResultText } from './boardModel'

// 여러 값을 고르는 작은 팝오버. 공용 DropdownMenu 는 고르면 닫혀 다중 선택에 맞지 않는다
export function FilterPopover({
  label,
  count,
  children
}: {
  label: string
  count: number
  children: ReactNode
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-sm ${
          count > 0 ? 'bg-blue-50 text-blue-700 rounded-md' : button.subtle
        }`}
      >
        {label}
        {count > 0 ? <span className="tabular-nums">{count}</span> : null}
        <ChevronDownIcon size={14} />
      </button>
      {open ? (
        <div className="absolute left-0 z-20 mt-1 w-56 max-h-80 overflow-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg">
          {children}
        </div>
      ) : null}
    </div>
  )
}

export function CheckItem({
  checked,
  onChange,
  children
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children: ReactNode
}): React.ReactNode {
  return (
    <label className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 truncate">{children}</span>
    </label>
  )
}

export const toggleIn = <T,>(list: T[], v: T, on: boolean): T[] =>
  on ? (list.includes(v) ? list : [...list, v]) : list.filter((x) => x !== v)


/** 마지막 동기화 시각·결과 한 줄 + 새로고침(증분)·전체 다시 받기. 티켓 탭과 문서 탭이 같이 쓴다 */
export function SyncControls(p: {
  loading: boolean
  fetchedAt: string | null
  lastFullSyncAt: string | null
  lastSync: { mode: 'full' | 'incremental' | 'cache'; changed: number } | null
  /** lastSync 를 받은 요청의 방식 */
  lastSyncRequested?: 'auto' | 'incremental' | 'full' | null
  onRefresh: () => void
  onFullSync: () => void
}): ReactNode {
  const resultText = syncResultText(p.lastSync, p.lastSyncRequested ?? null)
  return (
    <>
      <span className={typo.metaFaint} aria-live="polite">
        {p.loading ? (
          '갱신 중…'
        ) : p.fetchedAt ? (
          <>
            <Tooltip
              content={
                p.lastFullSyncAt
                  ? `마지막 전체 동기화 ${shortDateTime(p.lastFullSyncAt)}`
                  : '전체 동기화 기록이 없어요'
              }
              className="inline"
            >
              마지막 동기화 {clockTime(p.fetchedAt)}
            </Tooltip>
            {resultText ? <span data-sync-result> · {resultText}</span> : null}
          </>
        ) : null}
      </span>
      <div className="inline-flex">
        <button
          type="button"
          onClick={p.onRefresh}
          disabled={p.loading}
          title="마지막 동기화 이후 바뀐 티켓만 가져와요"
          className={`inline-flex items-center gap-1 px-2.5 py-1 text-sm ${button.subtle} rounded-r-none disabled:opacity-50`}
        >
          <RefreshIcon size={14} />
          새로고침
        </button>
        <DropdownMenu
          width="w-56"
          trigger={({ open, toggle }) => (
            <button
              type="button"
              aria-label="동기화 옵션"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={toggle}
              className={`inline-flex items-center px-1.5 py-1 ${button.subtle} rounded-l-none border-l border-gray-200 h-full`}
            >
              <ChevronDownIcon size={14} />
            </button>
          )}
          items={[
            {
              key: 'full',
              label: '전체 다시 받기',
              // 동기화 중에도 고를 수 있다. main 이 진행 중 동기화 뒤에 전체를 이어 돌리고, 끝날 때까지 "갱신 중…"이 남는다
              description: p.loading
                ? '지금 동기화가 끝나면 이어서 모두 다시 받아요'
                : '저장본을 Jira 기준으로 모두 다시 받아요. 오래 걸릴 수 있어요',
              onSelect: p.onFullSync
            }
          ]}
        />
      </div>
    </>
  )
}
