// 할 일 빠른 추가 팝오버(Cmd+Shift+A)의 열림 상태와 미리 채울 값.
// 메모·회의록·Jira 티켓 화면의 '할 일로 만들기' 가 open(prefill) 로 팝오버를 연다.
// 열림 여부 필드는 isOpen 이다. 이유: open 은 여는 동작의 이름이다
import { create } from 'zustand'

export interface QuickAddPrefill {
  text?: string
  sourceLink?: string | null
}

interface QuickAddState {
  isOpen: boolean
  initialText: string
  sourceLink: string | null
  /** 열 때마다 1씩 는다. 이미 열린 팝오버를 새 값으로 다시 채우는 key 로 쓴다 */
  seq: number
  open: (prefill?: QuickAddPrefill) => void
  close: () => void
  toggle: () => void
  /** 출처 칩의 x. 열린 채로 출처만 지운다 */
  clearSourceLink: () => void
}

export const useQuickAddStore = create<QuickAddState>((set, get) => ({
  isOpen: false,
  initialText: '',
  sourceLink: null,
  seq: 0,

  open: (prefill) =>
    set((s) => ({
      isOpen: true,
      initialText: prefill?.text ?? '',
      sourceLink: prefill?.sourceLink ?? null,
      seq: s.seq + 1
    })),

  close: () => set({ isOpen: false, initialText: '', sourceLink: null }),

  // 단축키는 빈 팝오버를 열거나 닫는다
  toggle: () => (get().isOpen ? get().close() : get().open()),

  clearSourceLink: () => set({ sourceLink: null })
}))
