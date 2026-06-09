import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  project: {
    create: (input: Record<string, unknown>) => ipcRenderer.invoke('project:create', input),
    list: (status?: string) => ipcRenderer.invoke('project:list', status),
    get: (id: number) => ipcRenderer.invoke('project:get', id),
    update: (id: number, input: Record<string, unknown>) => ipcRenderer.invoke('project:update', id, input),
    delete: (id: number) => ipcRenderer.invoke('project:delete', id),
    calculateDates: (devEndDate: string) => ipcRenderer.invoke('project:calculateDates', devEndDate),
    lastDates: () => ipcRenderer.invoke('project:lastDates')
  },
  task: {
    create: (input: Record<string, unknown>) => ipcRenderer.invoke('task:create', input),
    list: (projectId: number) => ipcRenderer.invoke('task:list', projectId),
    listByProjectIds: (projectIds: number[]) =>
      ipcRenderer.invoke('task:listByProjectIds', projectIds),
    update: (id: number, input: Record<string, unknown>) => ipcRenderer.invoke('task:update', id, input),
    delete: (id: number) => ipcRenderer.invoke('task:delete', id)
  },
  tray: {
    getData: () => ipcRenderer.invoke('tray:getData'),
    openApp: () => ipcRenderer.invoke('tray:openApp'),
    onData: (callback: (data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
      ipcRenderer.on('tray:data', handler)
      return () => ipcRenderer.removeListener('tray:data', handler)
    }
  },
  calendar: {
    auth: () => ipcRenderer.invoke('calendar:auth'),
    getEvents: () => ipcRenderer.invoke('calendar:events'),
    refresh: () => ipcRenderer.invoke('calendar:refresh'),
    disconnect: () => ipcRenderer.invoke('calendar:disconnect'),
    status: () => ipcRenderer.invoke('calendar:status'),
    saveSettings: (clientId: string, clientSecret: string) =>
      ipcRenderer.invoke('calendar:saveSettings', clientId, clientSecret)
  },
  document: {
    create: (input: Record<string, unknown>) => ipcRenderer.invoke('document:create', input),
    list: (projectId?: number | null) => ipcRenderer.invoke('document:list', projectId),
    listAll: () => ipcRenderer.invoke('document:listAll'),
    update: (id: number, input: Record<string, unknown>) =>
      ipcRenderer.invoke('document:update', id, input),
    delete: (id: number) => ipcRenderer.invoke('document:delete', id),
    reorder: (items: { id: number; sort_order: number }[]) =>
      ipcRenderer.invoke('document:reorder', items),
    open: (url: string, type: string) => ipcRenderer.invoke('document:open', url, type)
  },
  variable: {
    create: (input: Record<string, unknown>) => ipcRenderer.invoke('variable:create', input),
    list: () => ipcRenderer.invoke('variable:list'),
    update: (id: number, input: Record<string, unknown>) =>
      ipcRenderer.invoke('variable:update', id, input),
    delete: (id: number) => ipcRenderer.invoke('variable:delete', id),
    reorder: (items: { id: number; sort_order: number }[]) =>
      ipcRenderer.invoke('variable:reorder', items)
  },
  memo: {
    create: (input: Record<string, unknown>) => ipcRenderer.invoke('memo:create', input),
    list: (archived?: boolean) => ipcRenderer.invoke('memo:list', archived),
    listImportant: () => ipcRenderer.invoke('memo:listImportant'),
    update: (id: number, input: Record<string, unknown>) =>
      ipcRenderer.invoke('memo:update', id, input),
    archive: (id: number) => ipcRenderer.invoke('memo:archive', id),
    restore: (id: number) => ipcRenderer.invoke('memo:restore', id),
    toggleImportant: (id: number) => ipcRenderer.invoke('memo:toggleImportant', id),
    delete: (id: number) => ipcRenderer.invoke('memo:delete', id)
  },
  memoCategory: {
    create: (input: Record<string, unknown>) => ipcRenderer.invoke('memoCategory:create', input),
    list: () => ipcRenderer.invoke('memoCategory:list'),
    update: (id: number, input: Record<string, unknown>) =>
      ipcRenderer.invoke('memoCategory:update', id, input),
    delete: (id: number) => ipcRenderer.invoke('memoCategory:delete', id)
  },
  report: {
    weeklyActivities: (weekStart: string, weekEnd: string) =>
      ipcRenderer.invoke('report:weeklyActivities', weekStart, weekEnd),
    weeklySummary: (weekStart: string, weekEnd: string) =>
      ipcRenderer.invoke('report:weeklySummary', weekStart, weekEnd),
    dailyStats: (weekStart: string, weekEnd: string) =>
      ipcRenderer.invoke('report:dailyStats', weekStart, weekEnd),
    weeklyTrend: (weeks: number) => ipcRenderer.invoke('report:weeklyTrend', weeks)
  },
  todo: {
    create: (input: Record<string, unknown>) => ipcRenderer.invoke('todo:create', input),
    list: (completed?: boolean) => ipcRenderer.invoke('todo:list', completed),
    listByTag: (tagId: number, completed?: boolean) =>
      ipcRenderer.invoke('todo:listByTag', tagId, completed),
    update: (id: number, input: Record<string, unknown>) =>
      ipcRenderer.invoke('todo:update', id, input),
    complete: (id: number) => ipcRenderer.invoke('todo:complete', id),
    setCompletedAt: (id: number, completedAt: string) =>
      ipcRenderer.invoke('todo:setCompletedAt', id, completedAt),
    restore: (id: number) => ipcRenderer.invoke('todo:restore', id),
    delete: (id: number) => ipcRenderer.invoke('todo:delete', id),
    history: (todoId: number) => ipcRenderer.invoke('todo:history', todoId),
    listActive: () => ipcRenderer.invoke('todo:listActive')
  },
  todoTag: {
    create: (input: Record<string, unknown>) => ipcRenderer.invoke('todoTag:create', input),
    list: () => ipcRenderer.invoke('todoTag:list'),
    update: (id: number, input: Record<string, unknown>) =>
      ipcRenderer.invoke('todoTag:update', id, input),
    delete: (id: number) => ipcRenderer.invoke('todoTag:delete', id)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
