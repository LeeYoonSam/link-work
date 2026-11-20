// 오늘 대시보드 (docs/ASSISTANT.md §11).
// 오늘 챙겨야 할 것을 한눈에 읽는 화면이다. 직접 하는 동작은 할 일 체크·빠른 추가, 이동 링크,
// 회의 브리핑 펼침, 새로고침뿐이다. 조립은 todayModel(순수 함수)이 하고 이 파일은 데이터 연결과 배치만 한다.
//
// 배치: DOM 순서는 좁은 창 순서(헤더·신호 → 배포 → Jira → 할 일 → 일정 → 메모)다.
// 컨테이너 폭이 1000px 이상이면 격자로 일정을 왼쪽 좁은 열에 두고 오른쪽에 배포 → [Jira | 할 일] 을 둔다.
import { useEffect, useMemo, useState } from 'react'
import type { AssistantNavigateEvent } from '../../types'
import { useAssistantStore } from '../../stores/assistantStore'
import { useTodayStore } from '../../stores/todayStore'
import { useTodoStore } from '../../stores/todoStore'
import { useJiraBoardStore } from '../../stores/jiraBoardStore'
import { useReleaseNoteStore } from '../../stores/releaseNoteStore'
import { useNavigationStore } from '../../stores/navigationStore'
import { useFocusStore } from '../../stores/focusStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { openReleaseForVersion, revealInTickets } from '../project/projectNav'
import { RefreshIcon } from '../project/BoardBits'
import { HomeMemos } from '../dashboard/HomeOverview'
import {
  buildTodayDashboard,
  type NextRelease,
  type SignalRef,
  type TodayDashboard
} from './todayModel'
import { meetingBriefings } from './MeetingBriefingCard'
import SignalPanel from './SignalPanel'
import ReleaseCard from './ReleaseCard'
import JiraWorkCard from './JiraWorkCard'
import TodoCard from './TodoCard'
import ScheduleCard, { localClock } from './ScheduleCard'

// 화면의 '지금' 을 다시 읽는 간격
const NOW_TICK_MS = 60_000

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

/** '11월 19일 (목)' */
export function dateHeading(now: Date): string {
  return `${now.getMonth() + 1}월 ${now.getDate()}일 (${WEEKDAYS[now.getDay()]})`
}

/** ISO → 로컬 'HH:mm'. 없거나 깨졌으면 null */
export function syncedClock(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : localClock(d)
}

const scrollToId = (id: string): boolean => {
  if (typeof document === 'undefined') return false
  const el = document.getElementById(id)
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return el !== null
}

// ── 이동 ──

/** 이슈 → 프로젝트 화면의 그 이슈. 보드에 없으면 티켓 탭만 연다 */
export function openIssue(key: string): void {
  if (!revealInTickets(key)) useNavigationStore.getState().openProjectsTab('tickets')
}

/** 할 일 → 할 일 화면에서 그 항목을 선택한다. 태그 필터가 숨기지 않도록 먼저 푼다 */
export function openTodo(id: number): void {
  const todo = useTodoStore.getState()
  todo.setFilterTagId(null)
  todo.setSelectedTodoId(id)
  useNavigationStore.getState().setView('todos')
}

/** 다음 배포 → 릴리스 탭의 그 릴리스. 대응 릴리스를 모르면 릴리스 탭만 연다 */
export async function openRelease(release: Pick<NextRelease, 'jiraVersionId' | 'noteId'> | null): Promise<void> {
  if (release?.jiraVersionId) {
    await openReleaseForVersion(release.jiraVersionId)
    return
  }
  if (release && release.noteId !== null) {
    useFocusStore.getState().requestFocus({ entity: 'release', id: release.noteId })
  }
  useNavigationStore.getState().openProjectsTab('releases')
}

/** 신호의 근거 칩 이동 */
export function openSignalRef(ref: SignalRef, release: NextRelease | null): void {
  switch (ref.type) {
    case 'issue':
      openIssue(ref.id)
      return
    case 'todo': {
      const id = Number(ref.id)
      if (Number.isInteger(id) && id > 0) openTodo(id)
      else useNavigationStore.getState().setView('todos')
      return
    }
    case 'meeting':
      scrollToId(`schedule-row-${ref.id}`)
      return
    case 'release':
      void openRelease(release)
      return
  }
}

/**
 * 알림 클릭 focus 를 대시보드 동작으로 바꾼다. focus 는 'meeting' 하나다 — 그 브리핑을 펼치고 스크롤한다.
 * focus 가 없으면(옛 linkwork://today/... 링크 포함) 오늘 화면만 연다.
 */
export function meetingFocusEventId(focus: AssistantNavigateEvent['focus'] | null): number | null {
  if (!focus || focus.kind !== 'meeting') return null
  const id = Number(focus.id)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * 다음 배포가 없는 까닭이 Jira 를 몰라서인지(TodayDashboard.releaseUnknown). 미연결·기본 프로젝트 없음이면
 * 'not_connected', 그 밖(불러오기 실패·불러오는 중)이면 'load_failed'. 정말 없으면 null
 */
export function releaseUnknownReason(
  d: Pick<TodayDashboard, 'jira' | 'releaseUnknown'>
): 'not_connected' | 'load_failed' | null {
  if (!d.releaseUnknown) return null
  return d.jira.state === 'not_connected' || d.jira.state === 'no_project' ? 'not_connected' : 'load_failed'
}

/**
 * 헤더의 오류 줄. 캘린더 미연결은 일정 카드가 안내하므로 여기서 다시 말하지 않는다 — 실제 오류만 보인다
 */
export function headerErrorText(eventsError: string | null, calendarConnected: boolean, assistantError: string): string {
  const parts: string[] = []
  if (eventsError && calendarConnected) parts.push(`일정: ${eventsError}`)
  if (assistantError) parts.push(assistantError)
  return parts.join(' · ')
}

/** 일정 id → 시작 ISO. 신호의 'n분 뒤' 에 쓴다 */
function meetingStartMap(d: Pick<TodayDashboard, 'schedule'>): Record<string, string> {
  const map: Record<string, string> = {}
  for (const r of d.schedule.rows) map[r.id] = r.startISO
  return map
}

export default function TodayView({
  now: nowProp
}: {
  // 테스트가 시각을 고정할 때 쓴다. 앱은 넘기지 않는다
  now?: Date
} = {}): React.ReactNode {
  const [tick, setTick] = useState<Date>(() => nowProp ?? new Date())
  const now = nowProp ?? tick

  const assistantToday = useAssistantStore((s) => s.today)
  const assistantError = useAssistantStore((s) => s.error)
  const focus = useAssistantStore((s) => s.focus)
  const regeneratingIds = useAssistantStore((s) => s.meetingRegeneratingIds)
  const events = useTodayStore((s) => s.events)
  const eventsError = useTodayStore((s) => s.eventsError)
  const loading = useTodayStore((s) => s.loading)
  const lastSyncedAt = useTodayStore((s) => s.lastSyncedAt)
  const activeTodos = useTodoStore((s) => s.activeTodos)
  const completedTodos = useTodoStore((s) => s.completedTodos)
  const snapshot = useJiraBoardStore((s) => s.snapshot)
  const boardErrorCode = useJiraBoardStore((s) => s.errorCode)
  const boardLoading = useJiraBoardStore((s) => s.loading)
  const boardError = useJiraBoardStore((s) => s.error)
  const notes = useReleaseNoteStore((s) => s.allNotes)

  const [forceOpenEventId, setForceOpenEventId] = useState<number | null>(null)

  // 진입 때 1번 불러온다. assistant:changed·창 focus 재로드는 stores/dataSync.ts 가 맡는다
  useEffect(() => {
    void useTodayStore.getState().load()
  }, [])

  useEffect(() => {
    if (nowProp) return
    const t = setInterval(() => setTick(new Date()), NOW_TICK_MS)
    return () => clearInterval(t)
  }, [nowProp])

  const calendarConnected = assistantToday ? assistantToday.calendarConnected : eventsError === null

  const dashboard = useMemo(
    () =>
      buildTodayDashboard({
        now,
        events,
        calendarConnected,
        snapshot,
        boardErrorCode,
        boardLoading,
        boardError,
        notes,
        activeTodos,
        completedTodos
      }),
    [now, events, calendarConnected, snapshot, boardErrorCode, boardLoading, boardError, notes, activeTodos, completedTodos]
  )

  // 알림 클릭(회의 브리핑)으로 열리면 그 브리핑을 펼치고 스크롤한다
  useEffect(() => {
    if (!focus) return
    const id = meetingFocusEventId(focus)
    if (id !== null) {
      setForceOpenEventId(id)
      setTimeout(() => scrollToId(`meeting-briefing-${id}`), 0)
    }
    useAssistantStore.getState().setFocus(null)
  }, [focus])

  const onRefresh = (): void => {
    if (loading) return
    void useTodayStore.getState().refresh()
  }

  const briefingRows = useMemo(() => meetingBriefings(assistantToday?.events ?? []), [assistantToday])
  const canRegenerateMeeting = !!assistantToday && assistantToday.aiAvailable && assistantToday.settings.llmEnabled
  const synced = syncedClock(lastSyncedAt)
  const headerError = headerErrorText(eventsError, dashboard.schedule.connected, assistantError)
  const openSettings = (): void => useSettingsStore.getState().open('integrations')

  return (
    <div className="@container mx-auto w-full max-w-6xl">
      <div className="grid grid-cols-1 gap-4 @min-[1000px]:grid-cols-[minmax(0,18.5rem)_minmax(0,1fr)_minmax(0,1fr)]">
        {/* 헤더: 날짜·동기화 시각·새로고침, 헤드라인 1줄 */}
        <header className="col-span-full min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="text-sm font-semibold text-gray-500 tabular-nums">{dateHeading(now)}</p>
            <div className="flex items-center gap-2 text-xs text-gray-400 tabular-nums">
              {synced ? <span>동기화 {synced}</span> : loading ? <span>불러오는 중…</span> : null}
              <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                aria-label="새로고침"
                title="일정·Jira·릴리스를 다시 받아요"
                className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshIcon size={14} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
          <h2 data-testid="today-headline" className="mt-1 break-words text-xl font-semibold text-gray-900">
            {dashboard.headline}
          </h2>
          {headerError ? <p className="mt-1 break-words text-xs text-amber-700">{headerError}</p> : null}
        </header>

        <div className="col-span-full min-w-0">
          <SignalPanel
            signals={dashboard.signals}
            hiddenSignals={dashboard.hiddenSignals ?? []}
            hiddenCount={dashboard.hiddenSignalCount}
            summaryLine={dashboard.summaryLine}
            now={now}
            meetingStarts={meetingStartMap(dashboard)}
            onOpenRef={(ref) => openSignalRef(ref, dashboard.release)}
          />
        </div>

        <div className="min-w-0 @min-[1000px]:col-span-2 @min-[1000px]:col-start-2 @min-[1000px]:row-start-3">
          <ReleaseCard
            release={dashboard.release}
            onOpenIssue={(row) => openIssue(row.key)}
            onOpenRelease={() => void openRelease(dashboard.release)}
            unknownReason={releaseUnknownReason(dashboard)}
          />
        </div>

        <div className="min-w-0 self-start @min-[1000px]:col-start-2 @min-[1000px]:row-start-4">
          <JiraWorkCard
            jira={dashboard.jira}
            onOpenIssue={(row) => openIssue(row.key)}
            onOpenBoard={() => useNavigationStore.getState().openProjectsTab('tickets')}
            onOpenSettings={openSettings}
            errorText={boardError}
            onRetry={onRefresh}
            retrying={loading}
          />
        </div>

        <div className="min-w-0 self-start @min-[1000px]:col-start-3 @min-[1000px]:row-start-4">
          <TodoCard
            todos={dashboard.todos}
            onComplete={(id) => useTodoStore.getState().completeTodo(id)}
            onAdd={(title) => useTodoStore.getState().createTodo({ title })}
            onOpenTodo={openTodo}
            onOpenTodos={() => useNavigationStore.getState().setView('todos')}
          />
        </div>

        {/* 넓은 창: 일정 열을 sticky 로 두어 오른쪽 카드가 길어도 아래에 빈 칸이 남지 않게 보인다.
            창보다 길면 열 안에서 스크롤한다 */}
        <div className="min-w-0 self-start @min-[1000px]:sticky @min-[1000px]:top-4 @min-[1000px]:col-start-1 @min-[1000px]:row-span-2 @min-[1000px]:row-start-3 @min-[1000px]:max-h-[calc(100vh-7.5rem)] @min-[1000px]:overflow-y-auto @min-[1000px]:rounded-lg">
          <ScheduleCard
            schedule={dashboard.schedule}
            now={now}
            briefings={briefingRows}
            regeneratingIds={regeneratingIds}
            canRegenerate={canRegenerateMeeting}
            onRegenerate={(eventId) => void useAssistantStore.getState().regenerateMeetingBriefing(eventId)}
            forceOpenEventId={forceOpenEventId}
            onOpenCalendar={() => useNavigationStore.getState().setView('calendar')}
            onOpenSettings={openSettings}
          />
        </div>

        {/* 중요 메모. 0건이면 그리지 않는다 */}
        <div className="col-span-full min-w-0">
          <HomeMemos />
        </div>
      </div>
    </div>
  )
}
