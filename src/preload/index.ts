import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { CommandOp } from '../main/services/assistant-types'

const api = {
  project: {
    create: (input: Record<string, unknown>) => ipcRenderer.invoke('project:create', input),
    list: (status?: string) => ipcRenderer.invoke('project:list', status),
    get: (id: number) => ipcRenderer.invoke('project:get', id),
    update: (id: number, input: Record<string, unknown>) => ipcRenderer.invoke('project:update', id, input),
    delete: (id: number) => ipcRenderer.invoke('project:delete', id),
    calculateDates: (devEndDate: string) => ipcRenderer.invoke('project:calculateDates', devEndDate),
    lastDates: () => ipcRenderer.invoke('project:lastDates'),
    reorder: (items: { id: number; sort_order: number }[]) =>
      ipcRenderer.invoke('project:reorder', items)
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
    openToday: () => ipcRenderer.invoke('tray:openToday'),
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
    approve: (requestId: string, approved: boolean, options?: { mode?: 'auto' | 'ask' }) =>
      ipcRenderer.invoke('ai:approve', requestId, approved, options),
    setChatWriteMode: (chatId: number, mode: string) =>
      ipcRenderer.invoke('ai:setChatWriteMode', chatId, mode),
    getModel: () => ipcRenderer.invoke('ai:getModel'),
    setModel: (model: string) => ipcRenderer.invoke('ai:setModel', model),
    getModelOptions: () => ipcRenderer.invoke('ai:getModelOptions'),
    bitbucketStatus: () => ipcRenderer.invoke('ai:bitbucketStatus'),
    bitbucketSaveToken: (email: string, token: string) =>
      ipcRenderer.invoke('ai:bitbucketSaveToken', email, token),
    bitbucketDisconnect: () => ipcRenderer.invoke('ai:bitbucketDisconnect'),
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
      // 회의 참석자로 지정할 구성원 id (전사 힌트/요약 담당자 매칭에 쓰인다)
      attendee_ids?: number[]
      // 처리 시 무음 구간을 잘라낼지 (기본 true)
      compact_audio?: boolean
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
    setAttendees: (meetingId: number, memberIds: number[]) =>
      ipcRenderer.invoke('recording:setAttendees', meetingId, memberIds),
    discardDraft: (id: number) => ipcRenderer.invoke('recording:discardDraft', id),
    onStream: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
      ipcRenderer.on('recording:stream', handler)
      return () => ipcRenderer.removeListener('recording:stream', handler)
    }
  },
  // 회의록 — 요약 완료된 회의 목록·검색·Markdown (docs/MEETING_NOTES.md)
  meetingNotes: {
    list: (filter?: { q?: string; kind?: string; projectId?: number | null }) =>
      ipcRenderer.invoke('meetingNotes:list', filter),
    markdown: (id: number) => ipcRenderer.invoke('meetingNotes:markdown', id)
  },
  // 녹음기 ↔ main 가드 브리지 — 창 닫기/앱 종료 시 녹음 중 여부 확인과 저장 요청에 쓰인다
  recorder: {
    reportState: (s: { active: boolean; draftId: number | null }) =>
      ipcRenderer.send('recorder:state', s),
    onCommand: (
      handler: (cmd: { type: 'stop-and-save'; requestId: string; process: boolean }) => void
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        cmd: { type: 'stop-and-save'; requestId: string; process: boolean }
      ): void => handler(cmd)
      ipcRenderer.on('recorder:command', listener)
      return () => ipcRenderer.removeListener('recorder:command', listener)
    },
    commandDone: (r: { requestId: string; success: boolean; error?: string }) =>
      ipcRenderer.send('recorder:command-done', r)
  },
  // 인식 보조 장치(용어집·구성원) — 로컬 DB에만 저장되며 전사 힌트/후보정/요약 프롬프트에 쓰인다
  recognitionAids: {
    listGlossary: () => ipcRenderer.invoke('recognitionAids:listGlossary'),
    upsertGlossary: (input: {
      id?: number
      term: string
      aliases?: string[]
      note?: string | null
      priority?: number
      enabled?: boolean
      project_id?: number | null
    }) => ipcRenderer.invoke('recognitionAids:upsertGlossary', input),
    removeGlossary: (id: number) => ipcRenderer.invoke('recognitionAids:removeGlossary', id),
    importGlossaryText: (text: string) =>
      ipcRenderer.invoke('recognitionAids:importGlossaryText', text),
    listMembers: () => ipcRenderer.invoke('recognitionAids:listMembers'),
    upsertMember: (input: {
      id?: number
      name: string
      aliases?: string[]
      role?: string | null
      enabled?: boolean
      sort_order?: number
    }) => ipcRenderer.invoke('recognitionAids:upsertMember', input),
    removeMember: (id: number) => ipcRenderer.invoke('recognitionAids:removeMember', id)
  },
  export: {
    saveMarkdown: (content: string, defaultFileName: string) =>
      ipcRenderer.invoke('export:saveMarkdown', content, defaultFileName)
  },
  releaseNote: {
    // deployVersion을 주면 그 배포 버전과 이름이 같은 릴리스만 (프로젝트 상세용)
    list: (deployVersion?: string) => ipcRenderer.invoke('releaseNote:list', deployVersion),
    get: (id: number) => ipcRenderer.invoke('releaseNote:get', id),
    sync: (id: number) => ipcRenderer.invoke('releaseNote:sync', id),
    syncAll: () => ipcRenderer.invoke('releaseNote:syncAll')
  },
  jira: {
    status: () => ipcRenderer.invoke('jira:status'),
    saveCredentials: (input: unknown) => ipcRenderer.invoke('jira:saveCredentials', input),
    disconnect: () => ipcRenderer.invoke('jira:disconnect'),
    listProjects: () => ipcRenderer.invoke('jira:listProjects'),
    setDefaultProject: (projectKey: string | null) =>
      ipcRenderer.invoke('jira:setDefaultProject', projectKey),
    openIssue: (issueKey: string) => ipcRenderer.invoke('jira:openIssue', issueKey)
  },
  // Jira 할 일 이슈 → 프로젝트/작업/문서. Jira는 읽기만 하고 LinkWork DB에만 쓴다
  projectSync: {
    preview: () => ipcRenderer.invoke('projectSync:preview'),
    apply: (selection: { jiraKey: string; force: boolean; projectId: number | null }[]) =>
      ipcRenderer.invoke('projectSync:apply', selection),
    // 아침 자동 동기화(R11·A54) 상태. 읽기 전용이다
    morningStatus: () => ipcRenderer.invoke('projectSync:morningStatus')
  },
  backup: {
    // 저장 위치를 고르면 LinkWork-backup-<시각>.zip 파일 하나를 만든다
    exportToFile: () => ipcRenderer.invoke('backup:export'),
    // 백업 .zip을 골라 manifest만 확인한다 (복원은 별도 확인 후)
    pickBackup: () => ipcRenderer.invoke('backup:pick'),
    // 성공하면 main이 1초 뒤 앱을 재시작한다 — 이 promise 이후 렌더러 상태는 의미가 없다
    importBackup: (path: string) => ipcRenderer.invoke('backup:import', path),
    onProgress: (callback: (p: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, p: unknown): void => callback(p)
      ipcRenderer.on('backup:progress', handler)
      return () => ipcRenderer.removeListener('backup:progress', handler)
    }
  },
  // 개인 비서 — 오늘 계획·브리핑·최신화. 응답은 { success, error } 로 감싼다(getSettings 제외)
  assistant: {
    getToday: () => ipcRenderer.invoke('assistant:getToday'),
    startDay: () => ipcRenderer.invoke('assistant:startDay'),
    closeDay: (note?: string) => ipcRenderer.invoke('assistant:closeDay', note),
    reopenDay: () => ipcRenderer.invoke('assistant:reopenDay'),
    saveWrapup: (note: string, date: string) => ipcRenderer.invoke('assistant:saveWrapup', note, date),
    refresh: () => ipcRenderer.invoke('assistant:refresh'),
    refreshBriefing: () => ipcRenderer.invoke('assistant:refreshBriefing'),
    generateRecovery: () => ipcRenderer.invoke('assistant:generateRecovery'),
    listCandidates: () => ipcRenderer.invoke('assistant:listCandidates'),
    addItem: (candidateId: string) => ipcRenderer.invoke('assistant:addItem', candidateId),
    acceptSuggestion: (itemId: number) => ipcRenderer.invoke('assistant:acceptSuggestion', itemId),
    dismissSuggestion: (itemId: number) => ipcRenderer.invoke('assistant:dismissSuggestion', itemId),
    setItemStatus: (itemId: number, status: string, note?: string) =>
      ipcRenderer.invoke('assistant:setItemStatus', itemId, status, note),
    focusItem: (itemId: number) => ipcRenderer.invoke('assistant:focusItem', itemId),
    // 계속 제외 (부록 M.5.6)
    excludeItem: (itemId: number) => ipcRenderer.invoke('assistant:excludeItem', itemId),
    removeExclusion: (candidateId: string) => ipcRenderer.invoke('assistant:removeExclusion', candidateId),
    // 명령 입력 (부록 G.9). 조작 형식 검증은 서비스가 한다
    interpretCommand: (text: string, scopeItemId?: number) =>
      ipcRenderer.invoke('assistant:interpretCommand', text, scopeItemId),
    applyCommand: (ops: CommandOp[], text: string) => ipcRenderer.invoke('assistant:applyCommand', ops, text),
    // 회의 브리핑 AI 본문 다시 만들기 (부록 I.11.10)
    regenerateMeetingBriefing: (eventId: number) => ipcRenderer.invoke('assistant:regenerateMeetingBriefing', eventId),
    getSettings: () => ipcRenderer.invoke('assistant:getSettings'),
    saveSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke('assistant:saveSettings', patch),
    takePendingNavigate: () => ipcRenderer.invoke('assistant:takePendingNavigate'),
    onNavigate: (callback: (p: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, p: unknown): void => callback(p)
      ipcRenderer.on('assistant:navigate', handler)
      return () => ipcRenderer.removeListener('assistant:navigate', handler)
    },
    onChanged: (callback: (p: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, p: unknown): void => callback(p)
      ipcRenderer.on('assistant:changed', handler)
      return () => ipcRenderer.removeListener('assistant:changed', handler)
    }
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
