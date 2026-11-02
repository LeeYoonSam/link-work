import { useEffect, useRef } from 'react'
import Sidebar from './components/layout/Sidebar'
import Header from './components/layout/Header'
import ProjectList from './components/project/ProjectList'
import ProjectForm from './components/project/ProjectForm'
import ProjectDetail from './components/project/ProjectDetail'
import Dashboard from './components/dashboard/Dashboard'
import CalendarView from './components/calendar/CalendarView'
import DocumentList from './components/document/DocumentList'
import VariableList from './components/variable/VariableList'
import MemoView from './components/memo/MemoView'
import TodoView from './components/todo/TodoView'
import WeeklyReport from './components/report/WeeklyReport'
import TrayPanel from './components/tray/TrayPanel'
import AiChatView from './components/ai/AiChatView'
import RecordingView from './components/recording/RecordingView'
import MeetingNotesView from './components/notes/MeetingNotesView'
import ReleasesView from './components/project/ReleasesView'
import TodayView from './components/today/TodayView'
import { useProjectStore } from './stores/projectStore'
import { useAssistantStore } from './stores/assistantStore'
import { installRecorderBridge } from './stores/recorderSession'
import { resolveStartView } from './utils/startView'
import type { AssistantNavigateEvent } from './types'

function App(): React.ReactNode {
  // Check if this is the tray panel window
  if (window.location.hash === '#tray-panel') {
    return (
      <div className="h-screen bg-transparent">
        <TrayPanel />
      </div>
    )
  }

  const { view, projectView } = useProjectStore()
  // 첫 화면 판정을 창마다 1번만 적용한다 (StrictMode 이중 마운트 방지)
  const startViewDecided = useRef(false)

  // 녹음 상태를 main의 창 닫기/앱 종료 가드에 알리고 저장 명령을 받는다(메인 창에서 1회).
  useEffect(() => installRecorderBridge(), [])

  // 비서 알림 클릭 → 오늘 화면으로 이동한다(assistant:navigate)
  useEffect(() => {
    const api = window.api?.assistant
    if (!api) return
    const goToday = (p: AssistantNavigateEvent): void => {
      useProjectStore.getState().setView('today')
      useAssistantStore.getState().setFocus(p.focus ?? null)
    }
    const unsubscribe = api.onNavigate(goToday)
    // 구독 전에 도착한 이동 신호를 가져간다 (§12.1).
    // cleanup 후 결과도 적용한다. StrictMode 재마운트 때 신호를 잃지 않기 위해서다
    if (typeof api.takePendingNavigate === 'function') {
      api
        .takePendingNavigate()
        .then((res) => {
          if (res?.success && res.pending) goToday(res.pending)
        })
        .catch(() => undefined)
    }
    return unsubscribe
  }, [])

  // 첫 화면 자동 선택 (docs/ASSISTANT.md 부록 C.1, A24).
  // 판정 중 사용자 이동이나 assistant:navigate 로 화면이 바뀌면 결과를 버린다.
  // 실패하면 아무것도 하지 않는다. 첫 화면은 dashboard 로 남는다.
  useEffect(() => {
    if (startViewDecided.current) return
    startViewDecided.current = true
    const api = window.api?.assistant
    if (!api) return
    const viewAtStart = useProjectStore.getState().view
    let moved = false
    // A→B→A 이동도 '이동함'으로 본다. StrictMode cleanup 에 묶지 않고 판정 끝에 해제한다
    const unsubscribe = useProjectStore.subscribe((s, prev) => {
      if (s.view !== prev.view) moved = true
    })
    api
      .getToday()
      .then((res) => {
        if (!res.success) return
        const t = res.today
        const target = resolveStartView({
          startView: t.settings.startView ?? 'auto',
          enabled: t.settings.enabled,
          planStatus: t.plan ? t.plan.status : 'none',
          logicalDate: t.logicalDate
        })
        if (target !== 'today') return
        const store = useProjectStore.getState()
        if (moved || store.view !== viewAtStart) return
        store.setView('today')
      })
      .catch(() => undefined)
      .finally(unsubscribe)
  }, [])

  const renderContent = (): React.ReactNode => {
    switch (view) {
      case 'dashboard':
        return <Dashboard />
      case 'today':
        return <TodayView />
      case 'projects':
        switch (projectView) {
          case 'list':
            return <ProjectList />
          case 'form':
            return <ProjectForm />
          case 'detail':
            return <ProjectDetail />
          default:
            return <ProjectList />
        }
      case 'todos':
        return <TodoView />
      case 'documents':
        return <DocumentList />
      case 'variables':
        return <VariableList />
      case 'memos':
        return <MemoView />
      case 'calendar':
        return <CalendarView />
      case 'reports':
        return <WeeklyReport />
      case 'ai':
        return <AiChatView />
      case 'recordings':
        return <RecordingView />
      case 'notes':
        return <MeetingNotesView />
      case 'releases':
        return <ReleasesView />
      default:
        return <Dashboard />
    }
  }

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-6">{renderContent()}</main>
      </div>
    </div>
  )
}

export default App
