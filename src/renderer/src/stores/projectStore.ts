import { create } from 'zustand'
import type { Project, Task, ProjectInput, TaskInput } from '../types'

interface ProjectStore {
  projects: Project[]
  currentProject: Project | null
  tasks: Task[]
  loading: boolean
  view: 'dashboard' | 'projects' | 'calendar' | 'documents' | 'variables'
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
