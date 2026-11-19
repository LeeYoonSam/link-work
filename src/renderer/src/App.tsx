import { useEffect, useRef } from 'react'
import Sidebar from './components/layout/Sidebar'
import Header from './components/layout/Header'
import ProjectsPage from './components/project/ProjectsPage'
import CalendarView from './components/calendar/CalendarView'
import VariableList from './components/variable/VariableList'
import MemoView from './components/memo/MemoView'
import TodoView from './components/todo/TodoView'
import TrayPanel from './components/tray/TrayPanel'
import AiChatView from './components/ai/AiChatView'
import RecordingView from './components/recording/RecordingView'
import MeetingNotesView from './components/notes/MeetingNotesView'
import TodayView from './components/today/TodayView'
import SettingsView from './components/settings/SettingsView'
import MobileTodayPublisher from './components/mobile/MobileTodayPublisher'
import { useNavigationStore } from './stores/navigationStore'
import { useAssistantStore } from './stores/assistantStore'
import { installRecorderBridge } from './stores/recorderSession'
import { installDataSync } from './stores/dataSync'
import { installAiStreamSync } from './stores/aiChatStore'
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

  const view = useNavigationStore((s) => s.view)
  // 첫 화면 판정을 창마다 1번만 적용한다 (StrictMode 이중 마운트 방지)
  const startViewDecided = useRef(false)

  // 녹음 상태를 main의 창 닫기/앱 종료 가드에 알리고 저장 명령을 받는다(메인 창에서 1회).
  useEffect(() => installRecorderBridge(), [])

  // 다른 경로의 변경(ai:dataChanged, assistant:changed, 창 focus)을 열린 화면에 반영한다(메인 창에서 1회).
  useEffect(() => installDataSync(), [])

  // AI 응답 스트림을 화면과 무관하게 받는다. 다른 화면에서 시작한 대화의 초기 이벤트를 놓치지 않는다(메인 창에서 1회).
  useEffect(() => installAiStreamSync(), [])

  // 비서 알림 클릭 → 오늘 화면으로 이동한다(assistant:navigate)
  useEffect(() => {
    const api = window.api?.assistant
    if (!api) return
    const goToday = (p: AssistantNavigateEvent): void => {
      useNavigationStore.getState().setView('today')
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

  // 첫 화면 선택 (docs/ASSISTANT.md 부록 C.1, A24). 기본 첫 화면은 today 다.
  // 설정이 projects·calendar 이면 그 화면으로 옮긴다.
  // 판정 중 사용자 이동이나 assistant:navigate 로 화면이 바뀌면 결과를 버린다.
  // 실패하면 아무것도 하지 않는다. 첫 화면은 today 로 남는다.
  useEffect(() => {
    if (startViewDecided.current) return
    startViewDecided.current = true
    const api = window.api?.assistant
    if (!api || typeof api.getSettings !== 'function') return
    const viewAtStart = useNavigationStore.getState().view
    let moved = false
    // A→B→A 이동도 '이동함'으로 본다. StrictMode cleanup 에 묶지 않고 판정 끝에 해제한다
    const unsubscribe = useNavigationStore.subscribe((s, prev) => {
      if (s.view !== prev.view) moved = true
    })
    api
      .getSettings()
      .then((settings) => {
        const target = resolveStartView(settings?.startView)
        if (target === 'today') return
        const store = useNavigationStore.getState()
        if (moved || store.view !== viewAtStart) return
        store.setView(target)
      })
      .catch(() => undefined)
      .finally(unsubscribe)
  }, [])

  const renderContent = (): React.ReactNode => {
    switch (view) {
      case 'today':
        return <TodayView />
      case 'projects':
        return <ProjectsPage />
      case 'todos':
        return <TodoView />
      case 'variables':
        return <VariableList />
      case 'memos':
        return <MemoView />
      case 'calendar':
        return <CalendarView />
      case 'ai':
        return <AiChatView />
      case 'recordings':
        return <RecordingView />
      case 'notes':
        return <MeetingNotesView />
      case 'settings':
        return <SettingsView />
      default:
        return <TodayView />
    }
  }

  return (
    <div className="flex h-screen bg-gray-50">
      <MobileTodayPublisher />
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-6">{renderContent()}</main>
      </div>
    </div>
  )
}

export default App
