export interface Project {
  id: number
  name: string
  description: string | null
  dev_start_date: string
  dev_end_date: string
  qa_start_date: string
  qa_end_date: string
  deploy_date: string
  deploy_version: string | null
  status: 'scheduled' | 'development' | 'qa' | 'deploy' | 'completed' | 'cancelled'
  status_manual: number
  created_at: string
  updated_at: string
}

export interface Task {
  id: number
  project_id: number
  name: string
  start_date: string | null
  end_date: string | null
  status: 'pending' | 'in_progress' | 'done'
  sort_order: number
  created_at: string
}

export interface ProjectInput {
  name: string
  description?: string
  dev_start_date: string
  dev_end_date: string
  qa_start_date?: string
  qa_end_date?: string
  deploy_date?: string
  deploy_version?: string
  status?: string
  status_manual?: number
}

export interface TaskInput {
  project_id: number
  name: string
  start_date?: string
  end_date?: string
  status?: string
  sort_order?: number
}

export interface CalculatedDates {
  qaStart: string
  qaEnd: string
  deployDate: string
}

export interface ProjectAPI {
  create: (input: ProjectInput) => Promise<{ id: number }>
  list: (status?: string) => Promise<Project[]>
  get: (id: number) => Promise<Project>
  update: (id: number, input: Partial<ProjectInput>) => Promise<Project>
  delete: (id: number) => Promise<{ success: boolean }>
  calculateDates: (devEndDate: string) => Promise<CalculatedDates>
  lastDates: () => Promise<{ devStartDate: string; devEndDate: string } | null>
}

export interface TaskAPI {
  create: (input: TaskInput) => Promise<{ id: number }>
  list: (projectId: number) => Promise<Task[]>
  update: (id: number, input: Partial<TaskInput>) => Promise<Task>
  delete: (id: number) => Promise<{ success: boolean }>
}

export interface TrayAPI {
  getData: () => Promise<unknown>
  openApp: () => Promise<void>
  onData: (callback: (data: unknown) => void) => () => void
}

export interface CalendarEvent {
  id: string
  summary: string
  description?: string
  start: string
  end: string
  allDay: boolean
  location?: string
  htmlLink?: string
}

export interface CalendarStatus {
  connected: boolean
  hasCredentials: boolean
}

export interface CalendarAPI {
  auth: () => Promise<{ success: boolean; error?: string }>
  getEvents: () => Promise<CalendarEvent[]>
  refresh: () => Promise<CalendarEvent[]>
  disconnect: () => Promise<{ success: boolean }>
  status: () => Promise<CalendarStatus>
  saveSettings: (clientId: string, clientSecret: string) => Promise<{ success: boolean }>
}

export interface Document {
  id: number
  name: string
  url: string
  type: 'link' | 'file'
  description: string | null
  project_id: number | null
  project_name?: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface DocumentInput {
  name: string
  url: string
  type: 'link' | 'file'
  description?: string
  project_id?: number | null
  sort_order?: number
}

export interface DocumentAPI {
  create: (input: DocumentInput) => Promise<{ id: number }>
  list: (projectId?: number | null) => Promise<Document[]>
  listAll: () => Promise<Document[]>
  update: (id: number, input: Partial<DocumentInput>) => Promise<Document>
  delete: (id: number) => Promise<{ success: boolean }>
  reorder: (items: { id: number; sort_order: number }[]) => Promise<{ success: boolean }>
  open: (url: string, type: 'link' | 'file') => Promise<{ success: boolean }>
}

export type VariableViewType = 'general' | 'secret'

export interface Variable {
  id: number
  key: string
  value: string
  description: string | null
  view_type: VariableViewType
  sort_order: number
  created_at: string
  updated_at: string
}

export interface VariableInput {
  key: string
  value: string
  description?: string
  view_type?: VariableViewType
  sort_order?: number
}

export interface VariableAPI {
  create: (input: VariableInput) => Promise<{ id: number }>
  list: () => Promise<Variable[]>
  update: (id: number, input: Partial<VariableInput>) => Promise<Variable>
  delete: (id: number) => Promise<{ success: boolean }>
  reorder: (items: { id: number; sort_order: number }[]) => Promise<{ success: boolean }>
}

export interface Memo {
  id: number
  content: string
  is_archived: number
  is_important: number
  color: string
  created_at: string
  updated_at: string
}

export interface MemoInput {
  content: string
  color?: string
  is_important?: number
}

export interface MemoAPI {
  create: (input: MemoInput) => Promise<{ id: number }>
  list: (archived?: boolean) => Promise<Memo[]>
  listImportant: () => Promise<Memo[]>
  update: (id: number, input: Partial<MemoInput>) => Promise<Memo>
  archive: (id: number) => Promise<{ success: boolean }>
  restore: (id: number) => Promise<{ success: boolean }>
  toggleImportant: (id: number) => Promise<{ success: boolean; is_important: number }>
  delete: (id: number) => Promise<{ success: boolean }>
}
