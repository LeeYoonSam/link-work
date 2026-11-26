// linkwork:// 링크를 앱 안에서 연다. AI 대화·오늘 화면이 같은 함수를 쓴다.
// 순서: 필터·탭 고침 → 조회 시작 → 포커스 요청(또는 기존 선택 상태) → 화면 이동.
// 이유: 화면이 열리는 첫 렌더에 이미 요청이 있어야 대상 항목을 바로 찾는다
import { parseInternalLink } from './internalLink'
import { normalizeView } from '../components/layout/navConfig'
import { useNavigationStore } from '../stores/navigationStore'
import { useTodoStore } from '../stores/todoStore'
import { useRecordingStore } from '../stores/recordingStore'
import { useMeetingNotesStore } from '../stores/meetingNotesStore'
import { useAssistantStore } from '../stores/assistantStore'
import { useFocusStore } from '../stores/focusStore'

export async function openInternalLink(href: string): Promise<void> {
  const target = parseInternalLink(href)
  if (!target) return
  const { setView, openProjectsTab } = useNavigationStore.getState()
  const { requestFocus } = useFocusStore.getState()

  switch (target.kind) {
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
      // 포커스 요청을 먼저 두고 탭을 연다. 릴리스 탭이 마운트되며 요청을 소비한다
      requestFocus({ entity: 'release', id: target.id })
      openProjectsTab('releases')
      return
    case 'recording': {
      const recording = useRecordingStore.getState()
      recording.setKindFilter('all')
      // 시각 링크면 회의를 열기 전에 재생 위치를 예약한다. 회의 상세가 열리며 소비한다
      if (target.atMs !== undefined) {
        recording.setPendingSeek({ meetingId: target.id, ms: target.atMs })
      }
      void recording.openMeeting(target.id)
      requestFocus({ entity: 'recording', id: target.id })
      setView('recordings')
      return
    }
    case 'note': {
      const notes = useMeetingNotesStore.getState()
      notes.setFilter({ q: '', kind: 'all' })
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
      // parseInternalLink 가 이미 별칭을 옮겼다. 탭이 있으면 화면과 탭을 한 번에 바꾼다
      if (target.view === 'projects' && target.tab) {
        openProjectsTab(target.tab)
        return
      }
      // 한 번 더 걸러 화면 ID 만 넘긴다
      const view = normalizeView(target.view)
      if (view) setView(view)
      return
    }
  }
}
