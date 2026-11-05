import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openInternalLink } from './openInternalLink'
import { useProjectStore } from '../stores/projectStore'
import { useTodoStore } from '../stores/todoStore'
import { useRecordingStore } from '../stores/recordingStore'
import { useMeetingNotesStore } from '../stores/meetingNotesStore'
import { useAssistantStore } from '../stores/assistantStore'
import { useFocusStore } from '../stores/focusStore'

function stubApi(): Record<string, ReturnType<typeof vi.fn>> {
  const fns = {
    projectGet: vi.fn(async (id: number) => ({ id, name: `p${id}` })),
    taskList: vi.fn(async () => []),
    recordingGet: vi.fn(async (id: number) => ({ id })),
    notesList: vi.fn(async () => []),
    documentListAll: vi.fn(async () => [{ id: 2, url: '/tmp/a.pdf', type: 'file' }]),
    documentOpen: vi.fn(async () => undefined)
  }
  vi.stubGlobal('window', {
    api: {
      project: { get: fns.projectGet },
      task: { list: fns.taskList },
      recording: { get: fns.recordingGet },
      meetingNotes: { list: fns.notesList },
      document: { listAll: fns.documentListAll, open: fns.documentOpen }
    }
  })
  return fns
}

describe('openInternalLink', () => {
  let api: ReturnType<typeof stubApi>

  beforeEach(() => {
    vi.useFakeTimers()
    api = stubApi()
    useProjectStore.setState({ view: 'ai', projectView: 'list', currentProject: null, tasks: [] })
    useTodoStore.setState({ filterTagId: 5, selectedTodoId: null })
    useRecordingStore.setState({ kindFilter: 'meeting' as never, current: null })
    useMeetingNotesStore.setState({
      filter: { q: 'abc', kind: 'meeting' as never, projectId: 3 },
      selectedId: null,
      detail: null
    })
    useAssistantStore.setState({ focus: null })
    useFocusStore.setState({ request: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('memo: 메모 포커스를 요청하고 메모 화면으로 간다', async () => {
    await openInternalLink('linkwork://memo/12')
    expect(useFocusStore.getState().request).toMatchObject({ entity: 'memo', id: 12 })
    expect(useProjectStore.getState().view).toBe('memos')
  })

  it('todo: 태그 필터를 풀고 선택한 뒤 할 일 화면으로 간다', async () => {
    await openInternalLink('linkwork://todo/3')
    expect(useTodoStore.getState().filterTagId).toBeNull()
    expect(useTodoStore.getState().selectedTodoId).toBe(3)
    expect(useProjectStore.getState().view).toBe('todos')
    expect(useFocusStore.getState().request).toBeNull()
  })

  it('project/1/task/9: 프로젝트를 불러오고 작업 포커스를 요청한다', async () => {
    await openInternalLink('linkwork://project/1/task/9')
    expect(api.projectGet).toHaveBeenCalledWith(1)
    expect(api.taskList).toHaveBeenCalledWith(1)
    expect(useFocusStore.getState().request).toMatchObject({ entity: 'task', id: 9 })
    expect(useProjectStore.getState().projectView).toBe('detail')
    expect(useProjectStore.getState().view).toBe('projects')
  })

  it('project/1: 작업 포커스를 요청하지 않는다', async () => {
    await openInternalLink('linkwork://project/1')
    expect(useFocusStore.getState().request).toBeNull()
    expect(useProjectStore.getState().view).toBe('projects')
  })

  it('recording: 종류 필터를 풀고 회의를 열고 포커스를 요청한다', async () => {
    await openInternalLink('linkwork://recording/3')
    expect(useRecordingStore.getState().kindFilter).toBe('all')
    expect(api.recordingGet).toHaveBeenCalledWith(3)
    expect(useFocusStore.getState().request).toMatchObject({ entity: 'recording', id: 3 })
    expect(useProjectStore.getState().view).toBe('recordings')
  })

  it('note: 필터를 비우고 회의록을 선택하고 포커스를 요청한다', async () => {
    await openInternalLink('linkwork://note/3')
    expect(useMeetingNotesStore.getState().filter).toEqual({ q: '', kind: 'all', projectId: null })
    expect(useMeetingNotesStore.getState().selectedId).toBe(3)
    expect(api.recordingGet).toHaveBeenCalledWith(3)
    expect(useFocusStore.getState().request).toMatchObject({ entity: 'note', id: 3 })
    expect(useProjectStore.getState().view).toBe('notes')
  })

  it('today/item/7: 오늘 화면 포커스를 정하고 오늘 화면으로 간다', async () => {
    await openInternalLink('linkwork://today/item/7')
    expect(useAssistantStore.getState().focus).toEqual({ kind: 'item', id: '7' })
    expect(useProjectStore.getState().view).toBe('today')
  })

  it('view/dashboard: 오늘 화면으로 간다', async () => {
    await openInternalLink('linkwork://view/dashboard')
    expect(useProjectStore.getState().view).toBe('today')
  })

  it('calendar: 날짜·이벤트 포커스를 요청한다', async () => {
    await openInternalLink('linkwork://calendar/2026-11-05/abc')
    expect(useFocusStore.getState().request).toMatchObject({
      entity: 'calendar',
      date: '2026-11-05',
      eventId: 'abc'
    })
    expect(useProjectStore.getState().view).toBe('calendar')
  })

  it('document: 문서를 바로 연다', async () => {
    await openInternalLink('linkwork://document/2')
    expect(api.documentOpen).toHaveBeenCalledWith('/tmp/a.pdf', 'file')
    expect(useProjectStore.getState().view).toBe('ai')
  })

  it.each(['linkwork://unknown/1', 'linkwork://memo/abc', 'https://example.com', 'linkwork://view/x'])(
    '모르는 링크 %s 는 상태를 바꾸지 않는다',
    async (href) => {
      await openInternalLink(href)
      expect(useProjectStore.getState().view).toBe('ai')
      expect(useFocusStore.getState().request).toBeNull()
      expect(useTodoStore.getState().filterTagId).toBe(5)
      expect(useAssistantStore.getState().focus).toBeNull()
      expect(Object.values(api).every((fn) => fn.mock.calls.length === 0)).toBe(true)
    }
  )
})
