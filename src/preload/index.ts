import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  project: {
    create: (input: Record<string, unknown>) => ipcRenderer.invoke('project:create', input),
    list: (status?: string) => ipcRenderer.invoke('project:list', status),
    get: (id: number) => ipcRenderer.invoke('project:get', id),
    update: (id: number, input: Record<string, unknown>) => ipcRenderer.invoke('project:update', id, input),
    delete: (id: number) => ipcRenderer.invoke('project:delete', id),
    calculateDates: (devEndDate: string) => ipcRenderer.invoke('project:calculateDates', devEndDate)
  },
  task: {
    create: (input: Record<string, unknown>) => ipcRenderer.invoke('task:create', input),
    list: (projectId: number) => ipcRenderer.invoke('task:list', projectId),
    update: (id: number, input: Record<string, unknown>) => ipcRenderer.invoke('task:update', id, input),
    delete: (id: number) => ipcRenderer.invoke('task:delete', id)
  },
  tray: {
    getData: () => ipcRenderer.invoke('tray:getData'),
    openApp: () => ipcRenderer.invoke('tray:openApp')
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
    open: (url: string, type: string) => ipcRenderer.invoke('document:open', url, type)
  },
  variable: {
    create: (input: Record<string, unknown>) => ipcRenderer.invoke('variable:create', input),
    list: () => ipcRenderer.invoke('variable:list'),
    update: (id: number, input: Record<string, unknown>) =>
      ipcRenderer.invoke('variable:update', id, input),
    delete: (id: number) => ipcRenderer.invoke('variable:delete', id)
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
