import { contextBridge, ipcRenderer } from 'electron'

const api = {
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
      ipcRenderer.invoke('calendar:saveSettings', clientId, clientSecret),
    // 가져올 캘린더 목록과 현재 선택(app_settings 'google_calendar_ids')
    listCalendars: () => ipcRenderer.invoke('calendar:listCalendars'),
    setSelectedCalendars: (ids: string[]) => ipcRenderer.invoke('calendar:setSelectedCalendars', ids),
    // 임의 구간(최대 45일) 일정. force 면 5분 캐시를 무시한다
    range: (fromISO: string, toISO: string, force?: boolean) =>
      ipcRenderer.invoke('calendar:range', fromISO, toISO, force)
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
    chatDiscardIfEmpty: (id: number) => ipcRenderer.invoke('ai:chatDiscardIfEmpty', id),
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
    suggestions: (variant?: number) => ipcRenderer.invoke('ai:suggestions', variant),
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
    // 목소리 등록 — 화자 목소리를 구성원 표본으로 (docs/MEETING_RECORDING.md 목소리 등록)
    enrollSpeakerVoice: (speakerId: number) =>
      ipcRenderer.invoke('recording:enrollSpeakerVoice', speakerId),
    confirmSpeakerMatch: (speakerId: number) =>
      ipcRenderer.invoke('recording:confirmSpeakerMatch', speakerId),
    rejectSpeakerMatch: (speakerId: number) =>
      ipcRenderer.invoke('recording:rejectSpeakerMatch', speakerId),
    // scope: 'one'(기본) | 'forward' | 'all' — 반환 { success, changed, merged, error? }
    reassignSegment: (segmentId: number, speakerId: number | null, scope?: 'one' | 'forward' | 'all') =>
      ipcRenderer.invoke('recording:reassignSegment', segmentId, speakerId, scope),
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
    setExpectedSpeakers: (id: number, n: number | null) =>
      ipcRenderer.invoke('recording:setExpectedSpeakers', id, n),
    setAttendees: (meetingId: number, memberIds: number[]) =>
      ipcRenderer.invoke('recording:setAttendees', meetingId, memberIds),
    discardDraft: (id: number) => ipcRenderer.invoke('recording:discardDraft', id),
    // 요약 형식 고정 — 저장만 한다(재요약은 summarize로 따로). null=자동(내용으로 판단)
    setSummaryTemplate: (meetingId: number, templateId: string | null) =>
      ipcRenderer.invoke('recording:setSummaryTemplate', meetingId, templateId),
    listSummaryTemplates: () => ipcRenderer.invoke('recording:listSummaryTemplates'),
    // 메모·북마크(text=''이면 북마크)
    listMarks: (meetingId: number) => ipcRenderer.invoke('recording:listMarks', meetingId),
    addMark: (input: { meetingId: number; raw_ms: number; text?: string; origin?: 'live' | 'post' }) =>
      ipcRenderer.invoke('recording:addMark', input),
    updateMark: (input: { id: number; text: string }) => ipcRenderer.invoke('recording:updateMark', input),
    deleteMark: (id: number) => ipcRenderer.invoke('recording:deleteMark', id),
    onStream: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown): void => callback(data)
      ipcRenderer.on('recording:stream', handler)
      return () => ipcRenderer.removeListener('recording:stream', handler)
    }
  },
  // 회의록 — 요약 완료된 회의 목록·검색·Markdown (docs/MEETING_RECORDING.md §10)
  meetingNotes: {
    list: (filter?: { q?: string }) =>
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
    removeMember: (id: number) => ipcRenderer.invoke('recognitionAids:removeMember', id),
    // 구성원 목소리 표본 요약·삭제(임베딩은 오지 않는다)
    listVoiceprints: () => ipcRenderer.invoke('recognitionAids:listVoiceprints'),
    clearVoiceprint: (memberId: number) =>
      ipcRenderer.invoke('recognitionAids:clearVoiceprint', memberId),
    // 등록된 목소리로 지난 회의 화자 다시 맞추기 — 미리 보기와 적용
    previewRematch: (opts?: { meetingIds?: number[]; memberIds?: number[] }) =>
      ipcRenderer.invoke('recognitionAids:previewRematch', opts ?? {}),
    applyRematch: (opts?: { meetingIds?: number[]; memberIds?: number[] }) =>
      ipcRenderer.invoke('recognitionAids:applyRematch', opts ?? {})
  },
  export: {
    saveMarkdown: (content: string, defaultFileName: string) =>
      ipcRenderer.invoke('export:saveMarkdown', content, defaultFileName)
  },
  releaseNote: {
    list: () => ipcRenderer.invoke('releaseNote:list'),
    get: (id: number) => ipcRenderer.invoke('releaseNote:get', id),
    sync: (id: number) => ipcRenderer.invoke('releaseNote:sync', id),
    syncAll: () => ipcRenderer.invoke('releaseNote:syncAll'),
    // 바뀐 이슈만 반영한다. force=false 면 10분 안 재호출은 main 이 생략한다
    syncChanges: (force?: boolean) => ipcRenderer.invoke('releaseNote:syncChanges', force)
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
  // 설정 화면: 저장된 자격 증명으로 연결 테스트. throw 하지 않고 비밀값을 돌려주지 않는다
  settings: {
    verifyIntegration: (id: 'google' | 'jira' | 'bitbucket' | 'notion') =>
      ipcRenderer.invoke('settings:verifyIntegration', id)
  },
  // 휴대폰 열람 서버 — 켜기·QR·토큰 재발급, 오늘 대시보드 스냅샷 발행
  mobile: {
    getStatus: () => ipcRenderer.invoke('mobile:getStatus'),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke('mobile:setEnabled', enabled),
    regenerateToken: () => ipcRenderer.invoke('mobile:regenerateToken'),
    publishToday: (snapshot: unknown) => ipcRenderer.invoke('mobile:publishToday', snapshot),
    // 휴대폰이 오늘 화면을 열면 메인이 재발행을 요청한다. 구독 해제 함수를 돌려준다
    onPublishRequested: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('mobile:publishRequested', handler)
      return () => ipcRenderer.removeListener('mobile:publishRequested', handler)
    }
  },
  // Jira 티켓 계층 보드 (docs/PROJECT_BOARD.md). Jira는 GET만 하고 DB는 보드 캐시 테이블에만 쓴다
  jiraBoard: {
    // 로컬 DB 에 저장된 스냅샷만 읽는다. Jira 를 부르지 않는다
    cached: () => ipcRenderer.invoke('jiraBoard:cached'),
    // mode: 'auto'(기본) | 'incremental' | 'full'. 값 검증은 main 이 한다
    fetch: (mode?: 'auto' | 'incremental' | 'full') => ipcRenderer.invoke('jiraBoard:fetch', mode),
    // 에픽 AI 요약. 사용자가 버튼을 눌렀을 때만 부른다
    summarizeEpic: (epicKey: string) => ipcRenderer.invoke('jiraBoard:summarizeEpic', epicKey),
    // 저장된 스냅샷의 links 에 든 http(s) URL 만 연다. 검증은 main 이 한다
    openLink: (url: string) => ipcRenderer.invoke('jiraBoard:openLink', url)
  },
  // 아침 자동 동기화 상태(docs/ASSISTANT.md §8.3). 읽기 전용이다
  morningSync: {
    status: () => ipcRenderer.invoke('morningSync:status')
  },
  backup: {
    // 그룹별 현재 건수·파일 용량 (백업 화면 표시용)
    stats: () => ipcRenderer.invoke('backup:stats'),
    // 고른 그룹만 담아 LinkWork-backup-<시각>.zip 파일 하나를 만든다
    exportToFile: (groups: string[]) => ipcRenderer.invoke('backup:export', groups),
    // 백업 .zip을 골라 manifest만 확인한다 (복원은 별도 확인 후)
    pickBackup: () => ipcRenderer.invoke('backup:pick'),
    // 고른 그룹만 교체한다. 경고가 없으면 main이 1초 뒤 재시작하고, 있으면 restartPending: true로
    // 돌려주고 restart()를 기다린다. 어느 쪽이든 이 promise 이후 DB IPC는 실패한다
    importBackup: (path: string, groups: string[]) =>
      ipcRenderer.invoke('backup:import', path, groups),
    // 경고가 있는 복원(restartPending: true) 뒤 사용자가 확인하면 앱을 다시 띄운다
    restart: () => ipcRenderer.invoke('backup:restart'),
    onProgress: (callback: (p: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, p: unknown): void => callback(p)
      ipcRenderer.on('backup:progress', handler)
      return () => ipcRenderer.removeListener('backup:progress', handler)
    }
  },
  // 개인 비서 — 오늘 데이터·회의 브리핑·설정. 응답은 { success, error } 로 감싼다(getSettings 제외)
  assistant: {
    getToday: () => ipcRenderer.invoke('assistant:getToday'),
    // 회의 브리핑 AI 본문 다시 만들기 (docs/ASSISTANT.md §7.7)
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
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.api = api
}
