// 할 일 빠른 입력 한 줄. 할 일 화면 상단·Cmd+Shift+A 팝오버가 같이 쓴다.
// - 입력하는 동안 자연어 인식 결과(날짜·시각·우선순위·태그)를 입력 아래 칩으로 보여 준다. 칩의 x 는 그 토큰을 일반 글자로 되돌린다.
// - Enter(한글 조합 중 제외)로 저장한다. Cmd+Enter 는 저장 뒤 그 항목을 연다(openAfter).
// - 저장에 성공하면 입력을 비우고 포커스를 입력에 둔다(연속 입력). 실패하면 입력을 그대로 두고 오류 문구를 보인다.
// - 비어 있지 않은 줄이 2개 이상인 붙여넣기는 onBulkPaste 로 넘긴다(있을 때만).
import { useEffect, useRef, useState } from 'react'
import type { TodoInput, TodoTag } from '../../types'
import { parseTodoInput, splitPastedLines, toTodoInput, type ParsedToken } from './todoParse'

export interface QuickAddInputProps {
  tags: TodoTag[]
  onSubmit: (input: TodoInput, opts: { openAfter: boolean }) => Promise<void>
  onBulkPaste?: (lines: string[]) => void
  placeholder?: string
  autoFocus?: boolean
  /** 계속 입력하는 키의 안내 문구. 'shiftEnter' 면 'Shift+Enter 계속 입력' 을 보인다. 닫기 동작은 쓰는 쪽이 정한다 */
  keepOpenKey?: 'enter' | 'shiftEnter'
  onEscape?: () => void
  inputRef?: React.Ref<HTMLInputElement>
  now?: () => Date
  ariaLabel?: string
  /** 처음 마운트할 때 입력에 넣어 둘 글자. 다시 채우려면 쓰는 쪽이 key 를 바꿔 새로 마운트한다 */
  initialValue?: string
}

const TOKEN_CHIP: Record<ParsedToken['kind'], string> = {
  date: 'bg-amber-50 text-amber-700',
  time: 'bg-amber-50 text-amber-700',
  priority: 'bg-red-50 text-red-600',
  tag: 'bg-slate-100 text-slate-600'
}

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : '알 수 없는 오류')

/** 비어 있지 않은 줄이 2개 이상이면 여러 줄 붙여넣기로 본다 */
export function isMultiLinePaste(text: string): boolean {
  return text.split(/\r\n|\r|\n/).filter((l) => l.trim()).length >= 2
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (!ref) return
  if (typeof ref === 'function') ref(value)
  else (ref as { current: T | null }).current = value
}

export default function QuickAddInput({
  tags,
  onSubmit,
  onBulkPaste,
  placeholder = '+ 할 일 추가 (예: 내일 3시 회의 준비 !높음)',
  autoFocus = false,
  keepOpenKey = 'enter',
  onEscape,
  inputRef,
  now = () => new Date(),
  ariaLabel = '할 일 빠른 추가',
  initialValue = ''
}: QuickAddInputProps): React.ReactNode {
  const [value, setValue] = useState(initialValue)
  // 일반 글자로 되돌린 토큰의 시작 위치
  const [ignore, setIgnore] = useState<number[]>([])
  const [error, setError] = useState('')
  const elRef = useRef<HTMLInputElement | null>(null)
  // 저장을 기다리는 동안 입력이 바뀌었는지 보려고 최신 값을 둔다
  const valueRef = useRef(value)
  valueRef.current = value
  const busyRef = useRef(false)

  // 미리 채운 글자 뒤에 날짜·우선순위를 덧붙이기 쉽게 커서를 끝에 둔다(마운트 때 1번)
  useEffect(() => {
    const el = elRef.current
    if (!initialValue || !el) return
    el.setSelectionRange(el.value.length, el.value.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const parsed = value.trim() ? parseTodoInput(value, { now: now(), tags, ignore }) : null

  const setRefs = (el: HTMLInputElement | null): void => {
    elRef.current = el
    assignRef(inputRef, el)
  }

  const submit = async (openAfter: boolean): Promise<void> => {
    if (busyRef.current) return
    const raw = value
    if (!raw.trim()) return
    const input = toTodoInput(parseTodoInput(raw, { now: now(), tags, ignore }))
    busyRef.current = true
    try {
      await onSubmit(input, { openAfter })
      setError('')
      if (valueRef.current === raw) {
        setValue('')
        setIgnore([])
      }
      elRef.current?.focus()
    } catch (e) {
      setError(`할 일을 추가하지 못했어요. ${errText(e)}`)
    } finally {
      busyRef.current = false
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      if (e.nativeEvent?.isComposing) return
      if (onEscape) {
        e.preventDefault()
        onEscape()
      }
      return
    }
    if (e.key !== 'Enter') return
    // 한글 조합을 끝내는 Enter 는 저장하지 않는다
    if (e.nativeEvent?.isComposing || e.keyCode === 229) return
    e.preventDefault()
    void submit(e.metaKey === true)
  }

  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>): void => {
    if (!onBulkPaste) return
    const text = e.clipboardData?.getData('text') ?? ''
    if (!isMultiLinePaste(text)) return
    e.preventDefault()
    onBulkPaste(splitPastedLines(text))
  }

  const tokens = parsed?.tokens ?? []
  const hint = keepOpenKey === 'shiftEnter' ? 'Enter 저장 · Shift+Enter 계속 입력' : 'Enter 저장'

  return (
    <div className="min-w-0">
      <input
        ref={setRefs}
        type="text"
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          setValue(e.target.value)
          if (!e.target.value) setIgnore([])
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="w-full min-w-0 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
      />
      {tokens.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5" aria-label="인식한 항목">
          {tokens.map((t) => (
            <span
              key={`${t.kind}:${t.start}`}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${TOKEN_CHIP[t.kind]}`}
              title={`'${t.text}' 을(를) 인식했어요`}
            >
              {t.label}
              <button
                type="button"
                aria-label={`${t.label} 인식 취소`}
                title="일반 글자로 되돌리기"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setIgnore((xs) => (xs.includes(t.start) ? xs : [...xs, t.start]))}
                className="leading-none opacity-60 hover:opacity-100"
              >
                ×
              </button>
            </span>
          ))}
          <span className="text-[11px] text-gray-400">{hint}</span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1.5 break-words rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}
