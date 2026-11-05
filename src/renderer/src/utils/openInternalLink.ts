// linkwork:// 링크를 앱 안에서 연다. AI 대화·오늘 화면이 같은 함수를 쓴다.
// 순서: 필터·탭 고침 → 조회 시작 → 포커스 요청(또는 기존 선택 상태) → 화면 이동.
// 이유: 화면이 열리는 첫 렌더에 이미 요청이 있어야 대상 항목을 바로 찾는다
import { parseInternalLink } from './internalLink'
import { normalizeView } from '../components/layout/navConfig'
import { useProjectStore } from '../stores/projectStore'
import { useTodoStore } from '../stores/todoStore'
import { useRecordingStore } from '../stores/recordingStore'
import { useMeetingNotesStore } from '../stores/meetingNotesStore'
import { useAssistantStore } from '../stores/assistantStore'
import { useFocusStore } from '../stores/focusStore'

export async function openInternalLink(href: string): Promise<void> {
  const target = parseInternalLink(href)
  if (!target) return
  const { fetchProject, setProjectView, setView } = useProjectStore.getState()
  const { requestFocus } = useFocusStore.getState()

  switch (target.kind) {
    case 'project':
      await fetchProject(target.id)
      if (target.taskId !== null) requestFocus({ entity: 'task', id: target.taskId })
      setProjectView('detail')
      setView('projects')
      return
    case 'document': {
      const docs = await window.api.document.listAll()
      const doc = docs.find((d) => d.id === target.id)
      if (doc) await window.api.document.open(doc.url, doc.type)
      else setView('documents')
      return
    }
    case 'memo':
      requestFocus({ entity: 'memo', id: target.id })
      setView('memos')
      return
    case 'todo': {
      // 태그 필터가 대상을 숨기지 않도록 먼저 푼다
      const todo = useTodoStore.getState()
      todo.setFilterTagId(null)
      todo.setSelectedTodoId(target.id)
      setView('todos')
      return
    }
    case 'variable':
      requestFocus({ entity: 'variable', id: target.id })
      setView('variables')
      return
    case 'calendar':
      requestFocus({ entity: 'calendar', date: target.date, eventId: target.eventId })
      setView('calendar')
      return
    case 'release':
      requestFocus({ entity: 'release', id: target.id })
      setView('releases')
      return
    case 'recording': {
      const recording = useRecordingStore.getState()
      recording.setKindFilter('all')
      void recording.openMeeting(target.id)
      requestFocus({ entity: 'recording', id: target.id })
      setView('recordings')
      return
    }
    case 'note': {
      const notes = useMeetingNotesStore.getState()
      notes.setFilter({ q: '', kind: 'all', projectId: null })
      void notes.select(target.id)
      requestFocus({ entity: 'note', id: target.id })
      setView('notes')
      return
    }
    case 'today':
      useAssistantStore.getState().setFocus(target.focus)
      setView('today')
      return
    case 'view': {
      // parseInternalLink 가 이미 별칭을 옮겼다. 한 번 더 걸러 화면 ID 만 넘긴다
      const view = normalizeView(target.view)
      if (view) setView(view)
      return
    }
  }
}
