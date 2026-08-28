import { create } from 'zustand'
import type { Project, Task, ProjectInput, TaskInput } from '../types'

interface ProjectStore {
  projects: Project[]
  currentProject: Project | null
  tasks: Task[]
  loading: boolean
  view: 'dashboard' | 'projects' | 'todos' | 'calendar' | 'documents' | 'variables' | 'memos' | 'reports' | 'ai' | 'recordings' | 'releases'
  projectView: 'list' | 'form' | 'detail'
  editingProject: Project | null

  setView: (view: ProjectStore['view']) => void
  setProjectView: (view: ProjectStore['projectView']) => void
  setEditingProject: (project: Project | null) => void

  fetchProjects: (status?: string) => Promise<void>
  fetchProject: (id: number) => Promise<void>
  createProject: (input: ProjectInput) => Promise<void>
  updateProject: (id: number, input: Partial<ProjectInput>) => Promise<void>
  deleteProject: (id: number) => Promise<void>
  reorderProjects: (items: { id: number; sort_order: number }[]) => Promise<void>

  fetchTasks: (projectId: number) => Promise<void>
  createTask: (input: TaskInput) => Promise<void>
  updateTask: (id: number, input: Partial<TaskInput>) => Promise<void>
  deleteTask: (id: number, projectId: number) => Promise<void>
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  currentProject: null,
  tasks: [],
  loading: false,
  view: 'dashboard',
  projectView: 'list',
  editingProject: null,

  setView: (view) => set({ view }),
  setProjectView: (projectView) => set({ projectView, editingProject: null }),
  setEditingProject: (project) => set({ editingProject: project, projectView: 'form' }),

  fetchProjects: async (status?) => {
    set({ loading: true })
    const projects = await window.api.project.list(status)
    set({ projects, loading: false })
  },

  fetchProject: async (id) => {
    const project = await window.api.project.get(id)
    set({ currentProject: project })
    await get().fetchTasks(id)
  },

  createProject: async (input) => {
    await window.api.project.create(input)
    await get().fetchProjects()
    set({ projectView: 'list' })
  },

  updateProject: async (id, input) => {
    await window.api.project.update(id, input)
    await get().fetchProjects()
    set({ projectView: 'list', editingProject: null })
  },

  deleteProject: async (id) => {
    await window.api.project.delete(id)
    await get().fetchProjects()
    set({ currentProject: null, projectView: 'list' })
  },

  // 드래그로 정한 우선순위 그룹 내 순서를 저장한다. 정렬은 서버가 준 목록 순서가 아니라
  // sort_order로 결정되므로, 저장 후 재조회로 모든 화면이 같은 순서를 보게 한다.
  reorderProjects: async (items) => {
    await window.api.project.reorder(items)
    await get().fetchProjects()
  },

  fetchTasks: async (projectId) => {
    const tasks = await window.api.task.list(projectId)
    set({ tasks })
  },

  createTask: async (input) => {
    await window.api.task.create(input)
    await get().fetchTasks(input.project_id)
  },

  updateTask: async (id, input) => {
    const task = await window.api.task.update(id, input)
    await get().fetchTasks(task.project_id)
  },

  deleteTask: async (id, projectId) => {
    await window.api.task.delete(id)
    await get().fetchTasks(projectId)
  }
}))
