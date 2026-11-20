import { useId } from 'react'
import { SearchIcon, XIcon } from '../ui'

interface MemoSearchInputProps {
  value: string
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onFocus?: () => void
  onBlur?: () => void
  listboxId: string
  activeOptionId: string | null
  inputRef: React.Ref<HTMLInputElement>
}

// 메모 검색 입력. 목록 listbox 를 조종하는 combobox 다(↑↓로 선택 이동, aria-activedescendant)
export default function MemoSearchInput({
  value,
  onChange,
  onKeyDown,
  onFocus,
  onBlur,
  listboxId,
  activeOptionId,
  inputRef
}: MemoSearchInputProps): React.ReactNode {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        메모 검색 (제목·본문·분류)
      </label>
      <SearchIcon
        size={14}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
      />
      <input
        id={id}
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId ?? undefined}
        aria-describedby={hintId}
        autoComplete="off"
        spellCheck={false}
        placeholder="메모 검색"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        className="w-full pl-8 pr-8 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-md placeholder:text-gray-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
      <span id={hintId} className="sr-only">
        / 또는 Command F 로 검색, 위아래 화살표로 메모 이동, Esc 로 지우기
      </span>
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="검색어 지우기"
          title="검색어 지우기 (Esc)"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <XIcon size={12} />
        </button>
      ) : (
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 px-1.5 text-[10px] font-mono text-gray-400 border border-gray-200 rounded bg-white"
        >
          /
        </kbd>
      )}
    </div>
  )
}
