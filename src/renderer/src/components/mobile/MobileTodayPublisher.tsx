import { useEffect } from 'react'
import { useMobileStore } from '../../stores/mobileStore'
import { useAssistantStore } from '../../stores/assistantStore'
import { useTodayStore } from '../../stores/todayStore'
import { useTodoStore } from '../../stores/todoStore'
import { useJiraBoardStore } from '../../stores/jiraBoardStore'
import { useReleaseNoteStore } from '../../stores/releaseNoteStore'
import { startMobilePublisher, type MobilePublisher, type MobileTodayInputs } from './mobilePublish'

// 휴대폰 열람이 켜져 있는 동안 오늘 대시보드 스냅샷을 메인에 올린다 (docs/MOBILE_VIEW.md).
// 화면을 그리지 않는다. App 메인 창에 1번 마운트한다(트레이 패널 창에는 두지 않는다).

/** 오늘 화면(TodayView)과 같은 입력을 스토어에서 읽는다 */
export function readTodayInputs(): MobileTodayInputs {
  const today = useTodayStore.getState()
  const todo = useTodoStore.getState()
  const board = useJiraBoardStore.getState()
  const assistantToday = useAssistantStore.getState().today
  return {
    events: today.events,
    calendarConnected: assistantToday ? assistantToday.calendarConnected : today.eventsError === null,
    snapshot: board.snapshot,
    boardErrorCode: board.errorCode,
    boardLoading: board.loading,
    boardError: board.error,
    notes: useReleaseNoteStore.getState().allNotes,
    activeTodos: todo.activeTodos,
    completedTodos: todo.completedTodos,
    loading: today.loading,
    synced: today.lastSyncedAt !== null
  }
}

function subscribeTodayStores(cb: () => void): () => void {
  const unsubs = [
    useTodayStore.subscribe(cb),
    useTodoStore.subscribe(cb),
    useJiraBoardStore.subscribe(cb),
    useReleaseNoteStore.subscribe(cb),
    useAssistantStore.subscribe(cb)
  ]
  return () => unsubs.forEach((u) => u())
}

/**
 * 휴대폰 열람 상태를 읽고, 켜져 있는 동안만 발행기를 돌린다. 설정 섹션에서 켜고 끄면 즉시 따라간다.
 * 해제 함수를 돌려준다(발행기·구독을 모두 멈춘다)
 */
export function installMobileTodayPublisher(): () => void {
  let publisher: MobilePublisher | null = null

  const sync = (enabled: boolean): void => {
    const api = typeof window === 'undefined' ? undefined : window.api?.mobile
    if (enabled && api && !publisher) {
      publisher = startMobilePublisher({
        readInputs: readTodayInputs,
        publish: (snapshot) => api.publishToday(snapshot),
        onPublishRequested: (cb) => api.onPublishRequested(cb),
        subscribeStores: subscribeTodayStores,
        // 캐시 허용 불러오기다(refresh 가 아니다). 할 일 목록(진행·완료)도 함께 다시 읽는다
        reload: () => useTodayStore.getState().load()
      })
    } else if (!enabled && publisher) {
      publisher.stop()
      publisher = null
    }
  }

  const unsubscribe = useMobileStore.subscribe((s, prev) => {
    const enabled = s.status?.enabled ?? false
    if (enabled !== (prev.status?.enabled ?? false)) sync(enabled)
  })
  sync(useMobileStore.getState().status?.enabled ?? false)
  void useMobileStore.getState().load()

  return () => {
    unsubscribe()
    publisher?.stop()
    publisher = null
  }
}

export default function MobileTodayPublisher(): null {
  useEffect(() => installMobileTodayPublisher(), [])
  return null
}
