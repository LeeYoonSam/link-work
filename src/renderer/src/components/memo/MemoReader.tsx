import { useEffect, useState } from 'react'
import type { Memo, MemoCategory } from '../../types'
import {
  ArchiveIcon,
  ChevronDownIcon,
  DropdownMenu,
  EmptyState,
  FileTextIcon,
  PencilIcon,
  StarIcon,
  TrashIcon,
  UndoIcon,
  type DropdownItem
} from '../ui'
import MarkdownContent from './MarkdownContent'
import CategoryBadge from './CategoryBadge'
import { ChevronLeftIcon, CopyIcon, ExpandIcon } from './memoIcons'
import { formatDbTime, parseMemoTitle } from './memoText'

const TOOL_TONES = {
  default: 'text-gray-400 hover:text-gray-700 hover:bg-gray-100',
  danger: 'text-gray-400 hover:text-red-600 hover:bg-red-50',
  primary: 'text-gray-400 hover:text-blue-600 hover:bg-blue-50',
  starOn: 'text-amber-400 hover:text-amber-500 hover:bg-amber-50',
  starOff: 'text-gray-400 hover:text-amber-400 hover:bg-amber-50'
}

function ToolButton({
  label,
  onClick,
  tone = 'default',
  pressed,
  children
}: {
  label: string
  onClick: () => void
  tone?: keyof typeof TOOL_TONES
  pressed?: boolean
  children: React.ReactNode
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={`p-1.5 rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${TOOL_TONES[tone]}`}
    >
      {children}
    </button>
  )
}

export function memoTimeLine(memo: Memo): string {
  const created = formatDbTime(memo.created_at, 'yyyy-MM-dd HH:mm')
  if (memo.updated_at === memo.created_at) return `작성 ${created}`
  return `수정 ${formatDbTime(memo.updated_at, 'yyyy-MM-dd HH:mm')} · 작성 ${created}`
}

export interface MemoReaderProps {
  memo: Memo | null
  category: MemoCategory | null
  categories: MemoCategory[]
  // 현재 검색어가 이 메모에서 나온 곳 수. 0 이거나 검색 중이 아니면 표시하지 않는다
  matchCount?: number
  query?: string
  onEdit: (memo: Memo) => void
  onToggleImportant: (id: number) => void
  onArchive: (id: number) => void
  onRestore: (id: number) => void
  onDelete: (id: number) => void
  onChangeCategory: (id: number, categoryId: number | null) => void
  onExpand: (memo: Memo) => void
  // 1단 레이아웃에서 목록으로 돌아가기
  onBack?: () => void
  recent?: { id: number; title: string }[]
  onOpenRecent?: (id: number) => void
  bodyRef?: React.Ref<HTMLDivElement>
  onBodyKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
}

// 고정 읽기 영역: 머리(★ 제목, 분류·시각) · 툴바 · 마크다운 전문(독립 스크롤)
export default function MemoReader({
  memo,
  category,
  categories,
  matchCount = 0,
  query = '',
  onEdit,
  onToggleImportant,
  onArchive,
  onRestore,
  onDelete,
  onChangeCategory,
  onExpand,
  onBack,
  recent = [],
  onOpenRecent,
  bodyRef,
  onBodyKeyDown
}: MemoReaderProps): React.ReactNode {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    setCopied(false)
  }, [memo?.id])

  const back = onBack ? (
    <button
      type="button"
      onClick={onBack}
      className="flex items-center gap-0.5 px-1.5 py-1 rounded-md text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      <ChevronLeftIcon size={14} />
      목록
    </button>
  ) : null

  if (!memo) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {back ? <div className="px-3 pt-3">{back}</div> : null}
        <div className="flex-1 flex items-center justify-center">
          <EmptyState>
            <div className="flex justify-center mb-3 text-gray-300">
              <FileTextIcon size={32} />
            </div>
            <p className="text-sm">왼쪽 목록에서 메모를 고르세요</p>
            {recent.length > 0 && onOpenRecent ? (
              <div className="mt-4">
                <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-1.5">최근 본 메모</p>
                <ul className="space-y-1">
                  {recent.slice(0, 3).map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => onOpenRecent(r.id)}
                        className="text-sm text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                      >
                        {r.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </EmptyState>
        </div>
      </div>
    )
  }

  const { title } = parseMemoTitle(memo.content)
  const isImportant = memo.is_important === 1
  const isArchived = memo.is_archived === 1

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(memo.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      console.warn('[MemoReader] 메모 복사 실패', e)
    }
  }

  const categoryItems: DropdownItem[] = [
    ...categories.map<DropdownItem>((c) => ({
      key: String(c.id),
      label: c.name,
      leading: (
        <span aria-hidden className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />
      ),
      selected: category?.id === c.id,
      onSelect: () => onChangeCategory(memo.id, c.id)
    })),
    {
      key: '__none',
      label: '미분류',
      leading: <span aria-hidden className="inline-block w-2 h-2 rounded-full border border-gray-400" />,
      selected: category === null,
      separatorBefore: categories.length > 0,
      onSelect: () => onChangeCategory(memo.id, null)
    }
  ]

  return (
    <article aria-label={title} className="flex flex-col h-full min-h-0">
      <header className="px-5 pt-3 pb-3 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="min-w-0">{back}</div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {isArchived ? (
              <>
                <ToolButton label="복원" tone="primary" onClick={() => onRestore(memo.id)}>
                  <UndoIcon size={15} />
                </ToolButton>
                <ToolButton
                  label="영구 삭제"
                  tone="danger"
                  onClick={() => {
                    if (confirm('이 메모를 영구 삭제할까요? 되돌릴 수 없습니다.')) onDelete(memo.id)
                  }}
                >
                  <TrashIcon size={15} />
                </ToolButton>
              </>
            ) : (
              <>
                <ToolButton
                  label={isImportant ? '중요 해제' : '중요 표시'}
                  tone={isImportant ? 'starOn' : 'starOff'}
                  pressed={isImportant}
                  onClick={() => onToggleImportant(memo.id)}
                >
                  <StarIcon size={15} filled={isImportant} />
                </ToolButton>
                <ToolButton label="편집 (e)" onClick={() => onEdit(memo)}>
                  <PencilIcon size={15} />
                </ToolButton>
              </>
            )}
            <ToolButton label={copied ? '복사됨' : '원문 복사'} onClick={() => void handleCopy()}>
              <CopyIcon size={15} />
            </ToolButton>
            <ToolButton label="크게 보기" onClick={() => onExpand(memo)}>
              <ExpandIcon size={15} />
            </ToolButton>
            {!isArchived ? (
              <ToolButton label="보관" tone="danger" onClick={() => onArchive(memo.id)}>
                <ArchiveIcon size={15} />
              </ToolButton>
            ) : null}
          </div>
        </div>
        <h2 className="flex items-start gap-1.5 text-base font-semibold text-gray-900 break-words">
          {isImportant ? (
            <span className="mt-1 flex-shrink-0 text-amber-400">
              <StarIcon size={14} filled />
              <span className="sr-only">중요</span>
            </span>
          ) : null}
          <span className="min-w-0">{title}</span>
        </h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
          {isArchived ? (
            <>
              <CategoryBadge category={category} />
              <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[11px]">보관됨</span>
            </>
          ) : (
            <DropdownMenu
              align="left"
              width="w-48"
              items={categoryItems}
              trigger={({ open, toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  title="분류 바꾸기"
                  className="inline-flex items-center gap-0.5 rounded-full hover:bg-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <CategoryBadge category={category} />
                  <ChevronDownIcon size={11} className="text-gray-400 mr-1" />
                  <span className="sr-only">분류 바꾸기</span>
                </button>
              )}
            />
          )}
          <span className="tabular-nums">{memoTimeLine(memo)}</span>
          {copied ? (
            <span role="status" className="text-blue-600">
              복사됨
            </span>
          ) : null}
          {query.trim() && matchCount > 0 ? (
            <span className="text-gray-500">
              ‘<mark className="bg-yellow-100 text-gray-900 rounded-sm px-0.5">{query.trim()}</mark>’ 일치 {matchCount}곳
            </span>
          ) : null}
        </div>
      </header>
      <div
        ref={bodyRef}
        tabIndex={0}
        aria-label="메모 본문"
        onKeyDown={onBodyKeyDown}
        className="flex-1 min-h-0 overflow-y-auto px-5 py-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
      >
        <MarkdownContent content={memo.content} />
      </div>
    </article>
  )
}
