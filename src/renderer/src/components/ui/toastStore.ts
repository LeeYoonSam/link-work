// 화면 아래 토스트(실행 취소 등) 상태. 앱 어디서든 showToast 로 띄운다. 화면은 ToastHost(Toast.tsx)가 그린다.
// 규칙
// - 기본 5초 뒤 만료된다. 만료되거나 닫히면 onExpire, 동작 버튼을 누르면 onAction 만 부른다(둘 중 하나만).
// - flushToasts 는 떠 있는 토스트를 모두 즉시 만료 처리한다. 메뉴 전환·창 닫기 때 보류 중인 삭제를 확정하는 데 쓴다.
// - 콜백의 오류는 삼킨다. 토스트를 닫다가 화면이 멈추면 안 된다.
import { create } from 'zustand'

export interface ToastInput {
  message: string
  actionLabel?: string
  onAction?: () => void | Promise<void>
  onExpire?: () => void | Promise<void>
  durationMs?: number
}

export interface ToastItem {
  id: number
  message: string
  actionLabel?: string
}

interface ToastEntry {
  input: ToastInput
  timer: ReturnType<typeof setTimeout> | null
}

export const TOAST_DEFAULT_MS = 5000
// 한 번에 보이는 최대 개수. 넘치면 가장 오래된 것을 만료 처리한다
const MAX_TOASTS = 3

interface ToastState {
  toasts: ToastItem[]
}

export const useToastStore = create<ToastState>(() => ({ toasts: [] }))

const entries = new Map<number, ToastEntry>()
let nextId = 1

function runSafely(fn: (() => void | Promise<void>) | undefined): void {
  if (!fn) return
  try {
    void Promise.resolve(fn()).catch(() => undefined)
  } catch {
    // 콜백 오류는 삼킨다
  }
}

export function showToast(input: ToastInput): number {
  const id = nextId++
  const duration = input.durationMs ?? TOAST_DEFAULT_MS
  const timer = duration > 0 && Number.isFinite(duration) ? setTimeout(() => dismissToast(id, 'expire'), duration) : null
  entries.set(id, { input, timer })
  useToastStore.setState((s) => ({
    toasts: [...s.toasts, { id, message: input.message, actionLabel: input.actionLabel }]
  }))
  const overflow = useToastStore.getState().toasts.length - MAX_TOASTS
  if (overflow > 0) {
    for (const t of useToastStore.getState().toasts.slice(0, overflow)) dismissToast(t.id, 'expire')
  }
  return id
}

export function dismissToast(id: number, reason: 'expire' | 'action' = 'expire'): void {
  const entry = entries.get(id)
  if (!entry) return
  entries.delete(id)
  if (entry.timer) clearTimeout(entry.timer)
  useToastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  runSafely(reason === 'action' ? entry.input.onAction : entry.input.onExpire)
}

export function flushToasts(): void {
  for (const id of [...entries.keys()]) dismissToast(id, 'expire')
}
