import { create } from 'zustand'

// 앱 내 링크가 화면에 넘기는 포커스 요청이다.
// 할 일은 todoStore.selectedTodoId, 오늘은 assistantStore.setFocus 를 쓴다
export type FocusEntity = 'memo' | 'task' | 'variable' | 'release' | 'recording' | 'note' | 'calendar'

export type FocusRequest =
  | { entity: Exclude<FocusEntity, 'calendar'>; id: number; nonce: number }
  | { entity: 'calendar'; date: string; eventId: string | null; nonce: number }

// 화면이 이 시간 안에 요청을 소비하지 않으면 요청을 지운다.
// 이유: 삭제된 항목의 요청이 남으면 나중에 다른 화면 진입에서 엉뚱하게 강조한다
export const FOCUS_REQUEST_TTL_MS = 10_000

// Omit 을 유니언 각 멤버에 따로 적용한다. 이유: 유니언에 바로 Omit 을 쓰면 판별 필드가 사라진다
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type FocusRequestInput = DistributiveOmit<FocusRequest, 'nonce'>

interface FocusStore {
  request: FocusRequest | null
  requestFocus: (input: FocusRequestInput) => void
  consume: (nonce: number) => void
}

let nextNonce = 0
let ttlTimer: ReturnType<typeof setTimeout> | null = null

export const useFocusStore = create<FocusStore>((set, get) => ({
  request: null,

  requestFocus: (input) => {
    nextNonce += 1
    const nonce = nextNonce
    set({ request: { ...input, nonce } as FocusRequest })
    if (ttlTimer) clearTimeout(ttlTimer)
    ttlTimer = setTimeout(() => {
      ttlTimer = null
      if (get().request?.nonce === nonce) set({ request: null })
    }, FOCUS_REQUEST_TTL_MS)
  },

  consume: (nonce) => {
    if (get().request?.nonce !== nonce) return
    if (ttlTimer) clearTimeout(ttlTimer)
    ttlTimer = null
    set({ request: null })
  }
}))

// 엔터티 하나의 요청 타입. 예: FocusRequestOf<'memo'> → { entity: 'memo'; id; nonce }.
// Extract 를 쓰지 않는다. 이유: entity 가 유니언인 멤버는 Extract 에서 never 가 된다
export type FocusRequestOf<E extends FocusEntity> = E extends 'calendar'
  ? Extract<FocusRequest, { entity: 'calendar' }>
  : { entity: E; id: number; nonce: number }

// 이 엔터티의 요청만 돌려준다. 다른 엔터티 요청이면 null 이다
export function useFocusRequest<E extends FocusEntity>(entity: E): FocusRequestOf<E> | null {
  return useFocusStore((s) =>
    s.request?.entity === entity ? (s.request as FocusRequestOf<E>) : null
  )
}
