import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

// 메뉴 한 줄. label만 필수고 나머지는 필요할 때만 채운다.
export interface DropdownItem {
  key: string
  label: string
  /** 라벨 아래 회색 보조 설명. 액션의 결과를 한 줄로 알려줄 때 쓴다. */
  description?: string
  /** 라벨 왼쪽 요소(도트·아이콘 등) */
  leading?: ReactNode
  tone?: 'default' | 'danger'
  /** 값을 고르는 메뉴에서 현재 선택된 항목. 주면 라디오 시맨틱이 붙는다. */
  selected?: boolean
  /** 이 항목 위에 구분선을 그린다. 파괴적 액션을 떼어놓을 때. */
  separatorBefore?: boolean
  onSelect: () => void
}

/**
 * 트리거 아래에 붙는 드롭다운 메뉴.
 *
 * 트리거는 render prop이다 — 호출부가 자기 요소(뱃지·아이콘 버튼)를 직접 그린다.
 * 여기서 버튼으로 감싸면 Badge처럼 이미 button인 트리거와 중첩돼 잘못된 마크업이 된다.
 *
 * 카드 위에 얹히는 경우가 많아 클릭이 부모(카드 상세 열기 등)로 새지 않게 래퍼에서 끊는다.
 */
export function DropdownMenu({
  trigger,
  items,
  width = 'w-44',
  align = 'right'
}: {
  trigger: (props: { open: boolean; toggle: (e: React.MouseEvent) => void }) => ReactNode
  items: DropdownItem[]
  width?: string
  align?: 'left' | 'right'
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  // 바깥 클릭과 Escape로 닫는다. 같은 화면에 메뉴가 여럿이면 다른 것을 눌렀을 때도 이 경로로 닫힌다.
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const toggle = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setOpen((v) => !v)
  }

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      {trigger({ open, toggle })}
      {open && (
        <div
          role="menu"
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} z-20 mt-1 ${width} rounded-md border border-gray-200 bg-white py-1 shadow-lg`}
        >
          {items.map((item) => (
            <div key={item.key}>
              {item.separatorBefore && <div className="my-1 border-t border-gray-100" />}
              <button
                type="button"
                role={item.selected === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.selected}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  item.onSelect()
                }}
                // 한글 라벨은 글자 단위로 개행돼 좁은 폭에서 두 글자도 세로로 깨진다. nowrap이 필수다.
                className={`flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-left text-xs hover:bg-gray-50 ${
                  item.tone === 'danger'
                    ? 'text-red-600 hover:bg-red-50'
                    : item.selected
                      ? 'font-semibold text-gray-900'
                      : 'text-gray-600'
                }`}
              >
                {item.leading}
                <span className="min-w-0">
                  <span className="block">{item.label}</span>
                  {item.description && (
                    <span className="block text-[10px] text-gray-400">{item.description}</span>
                  )}
                </span>
                {item.selected && <span className="ml-auto text-blue-600">✓</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
