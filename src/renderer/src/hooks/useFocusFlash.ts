import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEntity } from '../stores/focusStore'

// 링크로 찾아간 항목을 강조하는 시간
export const FOCUS_FLASH_MS = 2500

// 강조 스타일. 리터럴 문자열로 둔다. 이유: Tailwind 는 소스의 리터럴만 스캔한다
export const FOCUS_RING_CLASS = 'ring-2 ring-blue-400 ring-offset-1 bg-blue-50/60'

// 포커스 대상의 DOM id. 예: focusDomId('memo', 12) → 'memo-12'
export const focusDomId = (
  entity: FocusEntity | 'calendar-day' | 'calendar-event',
  id: number | string
): string => `${entity}-${id}`

// 강조할 id 를 잠시 들고 있는다.
// FOCUS_FLASH_MS 가 지나거나 사용자가 처음 누르거나 키를 치면 null 로 돌아간다
export function useFlash<T extends number | string>(
  initial: T | null = null
): [T | null, (id: T) => void] {
  const [flashId, setFlashId] = useState<T | null>(initial)
  // 같은 id 를 다시 강조해도 타이머를 새로 건다
  const [seq, setSeq] = useState(0)

  const flash = useCallback((id: T) => {
    setFlashId(id)
    setSeq((n) => n + 1)
  }, [])

  useEffect(() => {
    if (flashId === null) return
    const clear = (): void => setFlashId(null)
    const timer = setTimeout(clear, FOCUS_FLASH_MS)
    // 강조를 만든 클릭·키 입력이 바로 지우지 않도록 다음 틱부터 듣는다
    const listen = setTimeout(() => {
      window.addEventListener('pointerdown', clear, { once: true })
      window.addEventListener('keydown', clear, { once: true })
    }, 0)
    return () => {
      clearTimeout(timer)
      clearTimeout(listen)
      window.removeEventListener('pointerdown', clear)
      window.removeEventListener('keydown', clear)
    }
  }, [flashId, seq])

  return [flashId, flash]
}

// active 가 true 가 되면 요소를 화면 가운데로 스크롤한다
export function useFocusScroll<T extends HTMLElement>(active: boolean): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    if (!active) return
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [active])
  return ref
}
