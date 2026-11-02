import { useEffect, useRef, useState } from 'react'
import { Badge, StatusDot, projectStatus, button } from '../ui'
import PhaseHint from '../project/PhaseHint'

interface TrayProject {
  name: string
  status: string
  dev_start_date: string
  dev_end_date: string
  qa_start_date: string
  qa_end_date: string
  deploy_date: string
  daysLeft: number
}

interface TrayEvent {
  summary: string
  time: string
  allDay: boolean
  kind: 'event' | 'todo'
  isCompleted: boolean
}

interface TrayPlanItem {
  id: number
  title: string
  rank: number | null
  status: string
  isFocus: boolean
}

// 메인 assistant-types.ts 의 TrayAssistant 와 같은 모양 (부록 E.6.1)
interface TrayAssistant {
  logicalDate: string
  status: 'none' | 'active' | 'closed'
  startedAt: string | null
  items: TrayPlanItem[]
  activeCount: number
  doneCount: number
  suggestedCount: number
  urgentSuggestedCount: number
  freeMinutesLeft: number
}

interface TrayData {
  projects: TrayProject[]
  events: TrayEvent[]
  assistant: TrayAssistant | null
}

type ActionResult = { success: true } | { success: false; error: string } | void

export function trayStatusLine(a: TrayAssistant): string {
  if (a.status === 'none') return '오늘 계획이 없습니다'
  if (a.status === 'closed') return '오늘 마감'
  return `${a.startedAt ?? '--:--'} 시작 · 집중 가능 ${a.freeMinutesLeft}분`
}

const sectionButton = 'text-xs px-2.5 py-1 disabled:opacity-50 disabled:cursor-not-allowed'

/** 트레이 '오늘 계획' 섹션 (부록 E.4.2) */
export function TrayAssistantSection(props: {
  assistant: TrayAssistant
  busy: boolean
  error: string
  onStartDay: () => void
  onCloseDay: () => void
  onOpenToday: () => void
}): React.ReactNode {
  const { assistant: a, busy, error, onStartDay, onCloseDay, onOpenToday } = props
  return (
    <div className="px-4 py-3">
      <h3 className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">
        오늘 계획
      </h3>
      <p className={`text-xs ${a.status === 'active' ? 'text-gray-700 tabular-nums' : 'text-gray-400'}`}>
        {trayStatusLine(a)}
      </p>

      {a.status === 'active' && a.items.length > 0 ? (
        <div className="mt-2 space-y-1">
          {a.items.map((item) => (
            <div key={item.id} className="flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  item.status === 'in_progress' ? 'bg-blue-500' : 'bg-gray-300'
                }`}
              />
              <span className="text-xs text-gray-800 truncate flex-1 min-w-0">{item.title}</span>
              {item.isFocus ? (
                <Badge color="bg-blue-50 text-blue-600" size="xs">
                  집중
                </Badge>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {a.status === 'active' && a.suggestedCount > 0 ? (
        <p className="mt-2 text-[11px] text-amber-600">
          새로 들어온 일 {a.suggestedCount}건 · 긴급 {a.urgentSuggestedCount}건
        </p>
      ) : null}

      {error ? <p className="mt-2 text-[11px] text-red-500">{error}</p> : null}

      <div className="mt-2 flex items-center gap-2">
        {a.status === 'none' ? (
          <button
            type="button"
            disabled={busy}
            onClick={onStartDay}
            className={`${button.dark} ${sectionButton}`}
          >
            하루 시작
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onOpenToday}
            className={`${button.subtle} ${sectionButton}`}
          >
            오늘 보기
          </button>
        )}
        {a.status === 'active' ? (
          <button
            type="button"
            disabled={busy}
            onClick={onCloseDay}
            className={`${button.subtle} ${sectionButton}`}
          >
            퇴근
          </button>
        ) : null}
      </div>
    </div>
  )
}

// 'YYYY-MM-DD' → 'MM-DD' (좁은 위젯용 압축 표기)
function md(dateStr: string): string {
  return dateStr.slice(5)
}

export default function TrayPanel(): React.ReactNode {
  const [data, setData] = useState<TrayData>({ projects: [], events: [], assistant: null })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reload = (): Promise<void> =>
    window.api.tray.getData().then((d) => {
      setData(d as TrayData)
    }).catch(() => {
      // getData failed - keep previous data
    })

  // 버튼 처리: busy 로 막고, 실패 문구를 섹션에 보이고, 끝나면 데이터를 다시 받는다
  // 진행 중 플래그. busy state 는 다시 그리기 전까지 갱신되지 않아 연타를 못 막는다
  const inFlight = useRef(false)
  const runAction = async (fn: () => Promise<ActionResult>, failText: string): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      const res = await fn()
      if (res && !res.success) setError(res.error || failText)
    } catch {
      setError(failText)
    } finally {
      inFlight.current = false
      setBusy(false)
      await reload()
    }
  }

  useEffect(() => {
    window.api.tray.getData().then((d) => {
      setData(d as TrayData)
    }).catch(() => {
      // getData failed - show empty state instead of infinite loading
    }).finally(() => {
      setLoading(false)
    })

    // Listen for pushed data updates from main process (e.g. when panel is shown)
    const unsubscribe = window.api.tray.onData((d) => {
      setData(d as TrayData)
      setLoading(false)
      setError('')
    })
    return unsubscribe
  }, [])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-white rounded-xl">
        <span className="text-gray-400 text-sm">Loading...</span>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="bg-gray-900 text-white px-4 py-3 flex items-center justify-between">
        <span className="font-bold text-sm">LinkWork</span>
        <button
          onClick={() => window.api.tray.openApp()}
          className="text-xs text-gray-400 hover:text-white transition-colors"
        >
          Open App
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* 오늘 계획 Section. 하루의 첫 행동이라 맨 위에 둔다 */}
        {data.assistant ? (
          <>
            <TrayAssistantSection
              assistant={data.assistant}
              busy={busy}
              error={error}
              onStartDay={() =>
                void runAction(() => window.api.assistant.startDay(), '하루 시작에 실패했습니다')
              }
              onCloseDay={() =>
                void runAction(() => window.api.assistant.closeDay(), '퇴근 처리에 실패했습니다')
              }
              onOpenToday={() =>
                void runAction(() => window.api.tray.openToday(), '오늘 화면을 열지 못했습니다')
              }
            />
            <div className="border-t border-gray-100" />
          </>
        ) : null}

        {/* Projects Section */}
        <div className="px-4 py-3">
          <h3 className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">
            Active Projects
          </h3>
          {data.projects.length === 0 ? (
            <p className="text-xs text-gray-400">No active projects</p>
          ) : (
            <div className="space-y-2">
              {data.projects.map((project, i) => {
                const st = projectStatus[project.status]
                return (
                  <div
                    key={i}
                    className="rounded-lg bg-gray-50 border border-gray-100 px-2.5 py-2"
                  >
                    {/* Row 1: 이름 + 상태 배지 */}
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-gray-900 truncate flex-1 min-w-0">
                        {project.name}
                      </span>
                      {st ? (
                        <Badge color={st.badge} size="xs">
                          <StatusDot color={st.dot} size="sm" />
                          <span className="ml-1">{st.label}</span>
                        </Badge>
                      ) : (
                        <Badge color="bg-gray-100 text-gray-600" size="xs">
                          {project.status}
                        </Badge>
                      )}
                    </div>

                    {/* Row 2: 현재 상태 기준 진행 일차 / 다음 단계 D-day + 배포일 */}
                    <div className="flex items-center gap-2 mt-1">
                      <PhaseHint project={project} className="text-[11px]" />
                      <span className="text-[11px] text-gray-400 shrink-0 tabular-nums">
                        Deploy {md(project.deploy_date)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-gray-100" />

        {/* Events Section */}
        <div className="px-4 py-3">
          <h3 className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">
            Today&apos;s Schedule
          </h3>
          {data.events.length === 0 ? (
            <p className="text-xs text-gray-400">No events today</p>
          ) : (
            <div className="space-y-1.5">
              {data.events.map((event, i) => (
                <div key={i} className={`flex items-center gap-2 py-1 ${event.isCompleted ? 'opacity-60' : ''}`}>
                  <span className={`text-xs font-medium w-12 shrink-0 text-right ${
                    event.kind === 'todo' && event.isCompleted
                      ? 'text-green-500'
                      : event.kind === 'todo'
                        ? 'text-green-600'
                        : 'text-gray-500'
                  }`}>
                    {event.time}
                  </span>
                  <div className={`w-0.5 h-4 rounded-full shrink-0 ${
                    event.kind === 'todo' ? 'bg-green-400' : 'bg-blue-400'
                  }`} />
                  <span className={`text-xs truncate ${
                    event.isCompleted ? 'line-through text-gray-400' : 'text-gray-800'
                  }`}>
                    {event.summary}
                  </span>
                  {event.kind === 'todo' ? (
                    <Badge
                      color={event.isCompleted ? 'bg-green-100 text-green-700' : 'bg-green-50 text-green-600'}
                      size="xs"
                    >
                      {event.isCompleted ? '완료' : 'TODO'}
                    </Badge>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-gray-100 px-4 py-2 bg-gray-50 flex justify-between items-center">
        <span className="text-xs text-gray-400">
          {data.projects.length} projects / {data.events.length} schedules
        </span>
        <button
          onClick={() => {
            setLoading(true)
            setError('')
            reload().finally(() => {
              setLoading(false)
            })
          }}
          className={`text-xs ${button.ghost}`}
        >
          Refresh
        </button>
      </div>
    </div>
  )
}
