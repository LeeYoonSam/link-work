import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openInternalLink } from './openInternalLink'
import { useNavigationStore } from '../stores/navigationStore'
import { useTodoStore } from '../stores/todoStore'
import { useRecordingStore } from '../stores/recordingStore'
import { useMeetingNotesStore } from '../stores/meetingNotesStore'
import { useAssistantStore } from '../stores/assistantStore'
import { useFocusStore } from '../stores/focusStore'

function stubApi(): Record<string, ReturnType<typeof vi.fn>> {
  const fns = {
    recordingGet: vi.fn(async (id: number) => ({ id })),
    notesList: vi.fn(async () => [])
  }
  vi.stubGlobal('window', {
    api: {
      recording: { get: fns.recordingGet },
      meetingNotes: { list: fns.notesList }
    }
  })
  return fns
}

describe('openInternalLink', () => {
  let api: ReturnType<typeof stubApi>

  beforeEach(() => {
    vi.useFakeTimers()
    api = stubApi()
    useNavigationStore.setState({ view: 'ai', projectsTab: 'tickets' })
    useTodoStore.setState({ filterTagId: 5, selectedTodoId: null })
    useRecordingStore.setState({ kindFilter: 'meeting' as never, current: null })
    useMeetingNotesStore.setState({
      filter: { q: 'abc', kind: 'meeting' as never },
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
    expect(useNavigationStore.getState().view).toBe('memos')
  })

  it('todo: 태그 필터를 풀고 선택한 뒤 할 일 화면으로 간다', async () => {
    await openInternalLink('linkwork://todo/3')
    expect(useTodoStore.getState().filterTagId).toBeNull()
    expect(useTodoStore.getState().selectedTodoId).toBe(3)
    expect(useNavigationStore.getState().view).toBe('todos')
    expect(useFocusStore.getState().request).toBeNull()
  })

  it('project/1/task/9: 포커스 요청 없이 프로젝트 페이지 티켓 탭으로 간다', async () => {
    useNavigationStore.setState({ projectsTab: 'releases' })
    await openInternalLink('linkwork://project/1/task/9')
    expect(useFocusStore.getState().request).toBeNull()
    expect(useNavigationStore.getState()).toMatchObject({ view: 'projects', projectsTab: 'tickets' })
  })

  it('project/1: 포커스 요청 없이 프로젝트 페이지 티켓 탭으로 간다', async () => {
    await openInternalLink('linkwork://project/1')
    expect(useFocusStore.getState().request).toBeNull()
    expect(useNavigationStore.getState()).toMatchObject({ view: 'projects', projectsTab: 'tickets' })
  })

  it('release/7: 포커스를 요청하고 프로젝트 페이지 릴리스 탭을 연다', async () => {
    await openInternalLink('linkwork://release/7')
    expect(useFocusStore.getState().request).toMatchObject({ entity: 'release', id: 7 })
    expect(useNavigationStore.getState()).toMatchObject({ view: 'projects', projectsTab: 'releases' })
  })

  it('view/releases: 프로젝트 페이지 릴리스 탭을 연다', async () => {
    await openInternalLink('linkwork://view/releases')
    expect(useNavigationStore.getState()).toMatchObject({ view: 'projects', projectsTab: 'releases' })
  })

  it('view/documents 와 document/2: 프로젝트 페이지 문서 탭을 연다', async () => {
    await openInternalLink('linkwork://view/documents')
    expect(useNavigationStore.getState()).toMatchObject({ view: 'projects', projectsTab: 'docs' })
    useNavigationStore.setState({ view: 'ai', projectsTab: 'tickets' })
    await openInternalLink('linkwork://document/2')
    expect(useNavigationStore.getState()).toMatchObject({ view: 'projects', projectsTab: 'docs' })
  })

  it('view/projects: 마지막으로 본 탭과 무관하게 티켓 탭을 연다', async () => {
    useNavigationStore.setState({ projectsTab: 'releases' })
    await openInternalLink('linkwork://view/projects')
    expect(useNavigationStore.getState()).toMatchObject({ view: 'projects', projectsTab: 'tickets' })
  })

  it('recording: 종류 필터를 풀고 회의를 열고 포커스를 요청한다', async () => {
    await openInternalLink('linkwork://recording/3')
    expect(useRecordingStore.getState().kindFilter).toBe('all')
    expect(api.recordingGet).toHaveBeenCalledWith(3)
    expect(useFocusStore.getState().request).toMatchObject({ entity: 'recording', id: 3 })
    expect(useNavigationStore.getState().view).toBe('recordings')
  })

  it('note: 필터를 비우고 회의록을 선택하고 포커스를 요청한다', async () => {
    await openInternalLink('linkwork://note/3')
    expect(useMeetingNotesStore.getState().filter).toEqual({ q: '', kind: 'all' })
    expect(useMeetingNotesStore.getState().selectedId).toBe(3)
    expect(api.recordingGet).toHaveBeenCalledWith(3)
    expect(useFocusStore.getState().request).toMatchObject({ entity: 'note', id: 3 })
    expect(useNavigationStore.getState().view).toBe('notes')
  })

  it('today/meeting/42: 회의 포커스를 정하고 오늘 화면으로 간다', async () => {
    await openInternalLink('linkwork://today/meeting/42')
    expect(useAssistantStore.getState().focus).toEqual({ kind: 'meeting', id: '42' })
    expect(useNavigationStore.getState().view).toBe('today')
  })

  it('옛 today/item/7: 포커스를 비우고 오늘 화면으로 간다', async () => {
    useAssistantStore.getState().setFocus({ kind: 'meeting', id: '1' })
    await openInternalLink('linkwork://today/item/7')
    expect(useAssistantStore.getState().focus).toBeNull()
    expect(useNavigationStore.getState().view).toBe('today')
  })

  it('view/dashboard: 오늘 화면으로 간다', async () => {
    await openInternalLink('linkwork://view/dashboard')
    expect(useNavigationStore.getState().view).toBe('today')
  })

  it('view/reports(없앤 주간 보고): 오늘 화면으로 간다', async () => {
    useNavigationStore.setState({ view: 'todos' })
    await openInternalLink('linkwork://view/reports')
    expect(useNavigationStore.getState().view).toBe('today')
  })

  it('calendar: 날짜·이벤트 포커스를 요청한다', async () => {
    await openInternalLink('linkwork://calendar/2026-11-05/abc')
    expect(useFocusStore.getState().request).toMatchObject({
      entity: 'calendar',
      date: '2026-11-05',
      eventId: 'abc'
    })
    expect(useNavigationStore.getState().view).toBe('calendar')
  })

  it.each(['linkwork://unknown/1', 'linkwork://memo/abc', 'https://example.com', 'linkwork://view/x'])(
    '모르는 링크 %s 는 상태를 바꾸지 않는다',
    async (href) => {
      await openInternalLink(href)
      expect(useNavigationStore.getState().view).toBe('ai')
      expect(useFocusStore.getState().request).toBeNull()
      expect(useTodoStore.getState().filterTagId).toBe(5)
      expect(useAssistantStore.getState().focus).toBeNull()
      expect(Object.values(api).every((fn) => fn.mock.calls.length === 0)).toBe(true)
    }
  )
})
