import { create } from 'zustand'
import type { ViewId } from '../components/layout/navConfig'

/** 프로젝트 페이지의 탭. 사이드바 메뉴의 연장이라 화면 store가 아니라 여기에 둔다 */
export type ProjectsTab = 'tickets' | 'releases' | 'docs'

// 사이드바 메뉴 단위의 현재 화면과 프로젝트 페이지 탭.
// 그 밖의 화면 안 세부 상태(필터·선택 등)는 각 화면 store가 가진다
interface NavigationStore {
  view: ViewId
  projectsTab: ProjectsTab
  /** 탭은 건드리지 않는다. 프로젝트 메뉴로 돌아오면 마지막 탭을 그대로 보인다 */
  setView: (view: ViewId) => void
  setProjectsTab: (tab: ProjectsTab) => void
  /** 화면과 탭을 한 번의 set 으로 바꾼다. 이유: 두 번 나누면 사이에 다른 탭이 잠깐 마운트되고,
   *  링크 포커스 요청(TTL)이 엉뚱한 탭에서 버려질 수 있다 */
  openProjectsTab: (tab: ProjectsTab) => void
}

export const useNavigationStore = create<NavigationStore>((set) => ({
  view: 'today',
  projectsTab: 'tickets',
  setView: (view) => set({ view }),
  setProjectsTab: (projectsTab) => set({ projectsTab }),
  openProjectsTab: (projectsTab) => set({ view: 'projects', projectsTab })
}))
