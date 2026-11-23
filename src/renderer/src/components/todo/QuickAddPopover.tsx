// 앱 어디서든 Cmd+Shift+A 로 여는 할 일 빠른 추가 팝오버. 열림 상태와 미리 채울 값은 quickAddStore 가 가진다.
// - Enter: 저장하고 닫는다. Shift+Enter: 저장하고 계속 입력한다. Cmd+Enter: 저장하고 그 할 일로 이동한다.
// - 저장하면 '추가했어요' 토스트를 띄운다. '열기' 는 linkwork://todo/{id} 링크와 같은 동작으로 그 할 일로 이동한다.
// - 배경 클릭·Esc 로 닫는다.
// - 메모·회의록·Jira 티켓의 '할 일로 만들기' 로 열리면 입력을 미리 채우고, 출처 칩을 보인다.
//   저장하면 출처를 source_link 로 넣는다. 칩의 x 는 출처를 뺀다
import { useEffect, useRef } from 'react'
import QuickAddInput from './QuickAddInput'
import { useTodoStore } from '../../stores/todoStore'
import { useQuickAddStore } from '../../stores/quickAddStore'
import { showToast } from '../ui/toastStore'
import { openInternalLink } from '../../utils/openInternalLink'
import { isSafeSourceLink, sourceLinkLabel } from './sourceLink'
import type { TodoInput } from '../../types'

/** Cmd+Shift+A (대소문자 무시). Ctrl·Alt 가 함께 눌렸으면 아니다 */
export function isQuickAddShortcut(e: {
  key: string
  metaKey?: boolean
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}): boolean {
  return e.metaKey === true && e.shiftKey === true && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'a'
}

const openTodo = (id: number): void => {
  void openInternalLink(`linkwork://todo/${id}`)
}

const closeQuickAdd = (): void => useQuickAddStore.getState().close()

export default function QuickAddPopover(): React.ReactNode {
  const tags = useTodoStore((s) => s.tags)
  const open = useQuickAddStore((s) => s.isOpen)
  const initialText = useQuickAddStore((s) => s.initialText)
  const rawSourceLink = useQuickAddStore((s) => s.sourceLink)
  const seq = useQuickAddStore((s) => s.seq)
  // 마지막 Enter 에 Shift 가 눌렸는가. QuickAddInput 의 keydown 보다 먼저(capture) 기록한다
  const keepOpenRef = useRef(false)

  // 열릴 때 태그가 비어 있으면 읽어 둔다(#태그 인식용)
  useEffect(() => {
    if (!open) return
    const store = useTodoStore.getState()
    if (store.tags.length === 0) void store.fetchTags().catch(() => undefined)
  }, [open])

  // 입력 밖에 포커스가 있어도 Esc 로 닫는다
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing) closeQuickAdd()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  const sourceLink = rawSourceLink && isSafeSourceLink(rawSourceLink) ? rawSourceLink : null

  const submit = async (input: TodoInput, opts: { openAfter: boolean }): Promise<void> => {
    const keepOpen = keepOpenRef.current
    // 저장하는 순간의 출처를 읽는다(칩 x 를 반영)
    const current = useQuickAddStore.getState().sourceLink
    const link = current && isSafeSourceLink(current) ? current : null
    const id = await useTodoStore.getState().createTodo(link ? { ...input, source_link: link } : input)
    if (opts.openAfter) {
      closeQuickAdd()
      openTodo(id)
      return
    }
    showToast({ message: '추가했어요', actionLabel: '열기', onAction: () => openTodo(id) })
    if (!keepOpen) closeQuickAdd()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 px-4 pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeQuickAdd()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="할 일 빠른 추가"
        className="w-full max-w-[560px] rounded-lg border border-gray-200 bg-white p-3 shadow-xl"
        onKeyDownCapture={(e) => {
          if (e.key === 'Enter') keepOpenRef.current = e.shiftKey
        }}
      >
        <QuickAddInput
          key={seq}
          tags={tags}
          onSubmit={submit}
          autoFocus
          keepOpenKey="shiftEnter"
          onEscape={closeQuickAdd}
          ariaLabel="할 일 빠른 추가"
          initialValue={initialText}
        />
        {sourceLink ? (
          <div className="mt-2 flex items-center gap-1.5">
            <span
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700"
              title={sourceLink}
            >
              <span className="truncate">출처: {sourceLinkLabel(sourceLink)}</span>
              <button
                type="button"
                aria-label="출처 빼기"
                title="출처 없이 저장"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => useQuickAddStore.getState().clearSourceLink()}
                className="leading-none opacity-60 hover:opacity-100"
              >
                ×
              </button>
            </span>
          </div>
        ) : null}
        <p className="mt-2 text-[11px] text-gray-400">Enter 저장 후 닫기 · Shift+Enter 계속 입력 · Cmd+Enter 저장 후 열기 · Esc 닫기</p>
      </div>
    </div>
  )
}
