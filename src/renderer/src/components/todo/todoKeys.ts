// 할 일 화면 키보드 조작 매핑. 순수 함수다. 화면이 window keydown 1개에서 이 결과로 분기한다.
// 입력 중(typing)·떠 있는 층(overlayOpen)·한글 조합 중이면 아무것도 하지 않는다.
// 수식키(meta/ctrl/alt) 조합은 삭제(Meta+Backspace) 하나만 받는다. 앱 단축키·편집 단축키와 겹치지 않게 하려는 것이다.

export type TodoKeyAction =
  | 'focusAdd'
  | 'focusSearch'
  | 'next'
  | 'prev'
  | 'toggleComplete'
  | 'expand'
  | 'collapse'
  | 'toToday'
  | 'priorityHigh'
  | 'priorityMedium'
  | 'priorityLow'
  | 'delete'

const PLAIN_KEYS: Record<string, TodoKeyAction> = {
  n: 'focusAdd',
  '/': 'focusSearch',
  ArrowDown: 'next',
  j: 'next',
  ArrowUp: 'prev',
  k: 'prev',
  ' ': 'toggleComplete',
  Enter: 'expand',
  Escape: 'collapse',
  t: 'toToday',
  '1': 'priorityHigh',
  '2': 'priorityMedium',
  '3': 'priorityLow'
}

export function todoKeyAction(
  e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; isComposing?: boolean },
  ctx: { typing: boolean; overlayOpen: boolean }
): TodoKeyAction | null {
  if (e.isComposing || ctx.typing || ctx.overlayOpen) return null
  if (e.metaKey || e.ctrlKey || e.altKey) {
    if (e.key === 'Backspace' && e.metaKey && !e.ctrlKey && !e.altKey) return 'delete'
    return null
  }
  // CapsLock 이 켜져 있어도 글자 키는 같은 동작이다
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  return PLAIN_KEYS[key] ?? null
}
