import { ChevronDownIcon } from '../ui'

// 오늘 화면의 '더 보기' 영역 (부록 J.8). 기본은 접힘이다.
// 조작 UI 를 여기에 둔다. 이유: 자동 위주 사용자는 읽을 것만 위에서 본다.
// 열렸을 때만 children 을 그린다
export default function MoreSection({
  open,
  onToggle,
  children
}: {
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.ReactNode {
  return (
    <section>
      <button
        id="today-more"
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="w-full flex items-center justify-center gap-1.5 py-2.5 text-sm text-gray-500 rounded-lg hover:bg-gray-100 transition-colors"
      >
        더 보기
        <ChevronDownIcon size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? <div className="mt-3 space-y-5">{children}</div> : null}
    </section>
  )
}
