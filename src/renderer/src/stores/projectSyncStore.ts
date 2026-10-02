import { create } from 'zustand'
import type {
  ProjectSyncPlan,
  ProjectSyncPlanItem,
  ProjectSyncResult,
  ProjectSyncSelection
} from '../types'
import { useProjectStore } from './projectStore'

/**
 * 싱크업 모달의 단계. 미리보기 없이 바로 적용하는 경로는 두지 않는다 —
 * 무엇이 만들어지고 바뀌는지 먼저 보여준 뒤에만 DB에 쓴다.
 */
export type ProjectSyncPhase = 'idle' | 'loading' | 'preview' | 'applying' | 'done' | 'error'

/** 이미 LinkWork에 있는 프로젝트에 붙은 항목. 고르면 Jira 내용으로 덮어쓰게 된다 */
export const isExistingItem = (item: ProjectSyncPlanItem): boolean => item.projectId !== null

/** 미리보기 직후의 기본 선택 — 새 프로젝트만 고른다. 기존 프로젝트는 사용자가 확인을 거쳐야 한다 */
export const defaultSelectedKeys = (plan: ProjectSyncPlan): string[] =>
  plan.items.filter((i) => !isExistingItem(i)).map((i) => i.jiraKey)

/**
 * 고른 키를 main에 넘길 selection으로 바꾼다. 기존 프로젝트는 강제 업데이트(force)다.
 * projectId는 미리보기 값 그대로 넘긴다 — 그 사이 매칭이 바뀌면 main이 엉뚱한 프로젝트를 덮어쓰지 않고 거부한다
 */
export const buildSelection = (
  plan: ProjectSyncPlan,
  selectedKeys: string[]
): ProjectSyncSelection[] =>
  plan.items
    .filter((i) => selectedKeys.includes(i.jiraKey))
    .map((i) => ({ jiraKey: i.jiraKey, force: isExistingItem(i), projectId: i.projectId }))

interface ProjectSyncStore {
  phase: ProjectSyncPhase
  plan: ProjectSyncPlan | null
  result: ProjectSyncResult | null
  error: string
  /** 적용할 항목의 Jira 키 */
  selectedKeys: string[]
  /** 덮어쓰기 확인을 기다리는 기존 프로젝트 항목의 키. null이면 확인 팝업이 닫혀 있다 */
  pendingForceKey: string | null

  /** Jira를 조회해 계획만 세운다. DB에는 아무것도 쓰지 않는다. 선택은 기본값으로 돌아간다 */
  preview: () => Promise<void>
  /** 새 프로젝트는 바로 토글하고, 기존 프로젝트를 켜려 할 때만 확인을 요청한다. 해제는 확인 없이 */
  toggle: (jiraKey: string) => void
  confirmForce: () => void
  cancelForce: () => void
  /** 새 프로젝트 항목만 한꺼번에 고르거나 푼다. 기존 프로젝트 선택은 건드리지 않는다 */
  setAllNew: (selected: boolean) => void
  /** main이 preview 때 캐시한 스냅샷으로 다시 계획해 고른 항목만 적용한다 */
  apply: () => Promise<void>
  reset: () => void
}

const INITIAL = {
  phase: 'idle' as ProjectSyncPhase,
  plan: null,
  result: null,
  error: '',
  selectedKeys: [] as string[],
  pendingForceKey: null
}

export const useProjectSyncStore = create<ProjectSyncStore>((set, get) => ({
  ...INITIAL,

  preview: async () => {
    // 직전 결과·선택을 먼저 지운다 — 새로 도는 동안 옛 미리보기가 남아 있으면 방금 것으로 오해한다
    set({
      phase: 'loading',
      plan: null,
      result: null,
      error: '',
      selectedKeys: [],
      pendingForceKey: null
    })
    try {
      const res = await window.api.projectSync.preview()
      if (res.success) {
        set({ phase: 'preview', plan: res.plan, selectedKeys: defaultSelectedKeys(res.plan) })
      } else {
        set({ phase: 'error', error: res.error || 'Jira 싱크업 미리보기에 실패했습니다' })
      }
    } catch (e) {
      set({
        phase: 'error',
        error: e instanceof Error ? e.message : 'Jira 싱크업 미리보기에 실패했습니다'
      })
    }
  },

  toggle: (jiraKey) => {
    const { plan, selectedKeys } = get()
    const item = plan?.items.find((i) => i.jiraKey === jiraKey)
    if (!item) return
    if (selectedKeys.includes(jiraKey)) {
      set({ selectedKeys: selectedKeys.filter((k) => k !== jiraKey) })
    } else if (isExistingItem(item)) {
      set({ pendingForceKey: jiraKey })
    } else {
      set({ selectedKeys: [...selectedKeys, jiraKey] })
    }
  },

  confirmForce: () => {
    const { pendingForceKey, selectedKeys } = get()
    if (pendingForceKey === null) return
    set({
      pendingForceKey: null,
      selectedKeys: selectedKeys.includes(pendingForceKey)
        ? selectedKeys
        : [...selectedKeys, pendingForceKey]
    })
  },

  cancelForce: () => set({ pendingForceKey: null }),

  setAllNew: (selected) => {
    const { plan, selectedKeys } = get()
    if (!plan) return
    const newKeys = defaultSelectedKeys(plan)
    const kept = selectedKeys.filter((k) => !newKeys.includes(k))
    set({ selectedKeys: selected ? [...kept, ...newKeys] : kept })
  },

  apply: async () => {
    const { plan, selectedKeys } = get()
    if (!plan) return
    const selection = buildSelection(plan, selectedKeys)
    if (selection.length === 0) return
    set({ phase: 'applying', error: '' })
    try {
      const res = await window.api.projectSync.apply(selection)
      if (res.success) {
        set({ phase: 'done', result: res.result })
        // 목록 화면이 새 프로젝트를 바로 보여야 한다
        await useProjectStore.getState().fetchProjects()
      } else {
        set({ phase: 'error', error: res.error || 'Jira 싱크업 적용에 실패했습니다' })
      }
    } catch (e) {
      set({
        phase: 'error',
        error: e instanceof Error ? e.message : 'Jira 싱크업 적용에 실패했습니다'
      })
    }
  },

  reset: () => set(INITIAL)
}))
