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
    getEvents: (weekStartISO?: string) => ipcRenderer.invoke('calendar:events', weekStartISO),
    refresh: (weekStartISO?: string) => ipcRenderer.invoke('calendar:refresh', weekStartISO),
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
  },
  ai: {
    chatList: () => ipcRenderer.invoke('ai:chatList'),
    chatCreate: () => ipcRenderer.invoke('ai:chatCreate'),
    chatDelete: (id: number) => ipcRenderer.invoke('ai:chatDelete', id),
    chatRename: (id: number, title: string) => ipcRenderer.invoke('ai:chatRename', id, title),
    messages: (chatId: number) => ipcRenderer.invoke('ai:messages', chatId),
    send: (
      chatId: number,
      text: string,
      attachments?: { name: string; type: string; bytes: ArrayBuffer }[]
    ) => ipcRenderer.invoke('ai:send', chatId, text, attachments),
    cancel: (chatId: number) => ipcRenderer.invoke('ai:cancel', chatId),
    progress: (chatId: number) => ipcRenderer.invoke('ai:progress', chatId),
    status: () => ipcRenderer.invoke('ai:status'),
    notionStatus: () => ipcRenderer.invoke('ai:notionStatus'),
    notionSaveToken: (token: string) => ipcRenderer.invoke('ai:notionSaveToken', token),
    notionDisconnect: () => ipcRenderer.invoke('ai:notionDisconnect'),
    approve: (requestId: string, approved: boolean) =>
      ipcRenderer.invoke('ai:approve', requestId, approved),
    setChatWriteMode: (chatId: number, mode: string) =>
      ipcRenderer.invoke('ai:setChatWriteMode', chatId, mode),
    onStream: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
      ipcRenderer.on('ai:stream', handler)
      return () => ipcRenderer.removeListener('ai:stream', handler)
    },
    onDataChanged: (callback: (data: { entity: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { entity: string }): void =>
        callback(data)
      ipcRenderer.on('ai:dataChanged', handler)
      return () => ipcRenderer.removeListener('ai:dataChanged', handler)
    }
  },
  recording: {
    list: () => ipcRenderer.invoke('recording:list'),
    get: (id: number) => ipcRenderer.invoke('recording:get', id),
    createDraft: (input: {
      title?: string
      source?: string
      kind?: string
      expected_speakers?: number | null
    }) => ipcRenderer.invoke('recording:createDraft', input),
    saveAudio: (
      id: number,
      bytes: ArrayBuffer,
      meta: { mime: string; durationMs: number },
      channelEnergy?: { hopMs: number; left: number[]; right: number[] } | null
    ) => ipcRenderer.invoke('recording:saveAudio', id, bytes, meta, channelEnergy),
    process: (id: number, opts?: { skipTranscribe?: boolean }) =>
      ipcRenderer.invoke('recording:process', id, opts),
    cancel: (id: number) => ipcRenderer.invoke('recording:cancel', id),
    summarize: (id: number) => ipcRenderer.invoke('recording:summarize', id),
    rename: (id: number, title: string) => ipcRenderer.invoke('recording:rename', id, title),
    remove: (id: number) => ipcRenderer.invoke('recording:remove', id),
    updateSpeaker: (
      speakerId: number,
      input: { display_name?: string | null; color?: string; label?: string }
    ) => ipcRenderer.invoke('recording:updateSpeaker', speakerId, input),
    reassignSegment: (segmentId: number, speakerId: number | null) =>
      ipcRenderer.invoke('recording:reassignSegment', segmentId, speakerId),
    updateSegmentText: (segmentId: number, text: string) =>
      ipcRenderer.invoke('recording:updateSegmentText', segmentId, text),
    addSpeaker: (meetingId: number, name: string) =>
      ipcRenderer.invoke('recording:addSpeaker', meetingId, name),
    mergeSpeakers: (meetingId: number, fromSpeakerId: number, intoSpeakerId: number) =>
      ipcRenderer.invoke('recording:mergeSpeakers', meetingId, fromSpeakerId, intoSpeakerId),
    toggleCut: (cutId: number, enabled: boolean) =>
      ipcRenderer.invoke('recording:toggleCut', cutId, enabled),
    actionItemToTodo: (meetingId: number, index: number) =>
      ipcRenderer.invoke('recording:actionItemToTodo', meetingId, index),
    linkProject: (id: number, projectId: number | null) =>
      ipcRenderer.invoke('recording:linkProject', id, projectId),
    setExpectedSpeakers: (id: number, n: number | null) =>
      ipcRenderer.invoke('recording:setExpectedSpeakers', id, n),
    onStream: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
      ipcRenderer.on('recording:stream', handler)
      return () => ipcRenderer.removeListener('recording:stream', handler)
    }
  },
  export: {
    saveMarkdown: (content: string, defaultFileName: string) =>
      ipcRenderer.invoke('export:saveMarkdown', content, defaultFileName)
  },
  releaseNote: {
    list: (projectId?: number) => ipcRenderer.invoke('releaseNote:list', projectId),
    get: (id: number) => ipcRenderer.invoke('releaseNote:get', id),
    link: (projectId: number, jiraProjectKey: string, version: unknown) =>
      ipcRenderer.invoke('releaseNote:link', projectId, jiraProjectKey, version),
    unlink: (id: number) => ipcRenderer.invoke('releaseNote:unlink', id),
    sync: (id: number) => ipcRenderer.invoke('releaseNote:sync', id),
    syncAll: () => ipcRenderer.invoke('releaseNote:syncAll')
  },
  jira: {
    status: () => ipcRenderer.invoke('jira:status'),
    saveCredentials: (input: unknown) => ipcRenderer.invoke('jira:saveCredentials', input),
    disconnect: () => ipcRenderer.invoke('jira:disconnect'),
    listProjects: () => ipcRenderer.invoke('jira:listProjects'),
    listVersions: (projectKey: string) => ipcRenderer.invoke('jira:listVersions', projectKey),
    setDefaultProject: (projectKey: string | null) =>
      ipcRenderer.invoke('jira:setDefaultProject', projectKey),
    openIssue: (issueKey: string) => ipcRenderer.invoke('jira:openIssue', issueKey)
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
