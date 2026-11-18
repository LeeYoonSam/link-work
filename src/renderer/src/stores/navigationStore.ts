import { create } from 'zustand'
import type { ViewId } from '../components/layout/navConfig'

// 사이드바 메뉴 단위의 현재 화면. 화면 안의 세부 상태는 각 화면 store가 가진다
interface NavigationStore {
  view: ViewId
  setView: (view: ViewId) => void
}

export const useNavigationStore = create<NavigationStore>((set) => ({
  view: 'today',
  setView: (view) => set({ view })
}))
