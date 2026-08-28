import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useCalendarStore, useWeekEvents } from '../../stores/calendarStore'
import { useMemoStore } from '../../stores/memoStore'
import { useTodoStore } from '../../stores/todoStore'
import ProjectProgress from './ProjectProgress'
import TodaySchedule from './TodaySchedule'
import MarkdownContent from '../memo/MarkdownContent'
import PriorityBadge from '../project/PriorityBadge'
import { selectFocus, sortActiveProjects, type FocusSelection } from './focusProject'
import { format } from 'date-fns'
import { formatDateSafe } from '../../utils/date'
import type { Project, Task, Todo } from '../../types'
import {
  Badge,
  Card,
  ClampedText,
  EmptyState,
  SectionTitle,
  StarIcon,
  projectStatus,
  todoPriority
} from '../ui'

function TodoRow({ todo }: { todo: Todo }): React.ReactNode {
  const { completeTodo, restoreTodo, setSelectedTodoId, setFilterTagId } = useTodoStore()
  const { setView } = useProjectStore()
  const isCompleted = todo.is_completed === 1

  const priorityDot = todoPriority[todo.priority].dot

  const isOverdue = Boolean(
    todo.due_date && !isCompleted && new Date(todo.due_date) < new Date()
  )

  // 행 클릭 시 TODO 메뉴로 전환하고 해당 항목을 선택해 강조한다.
  // 필터 태그가 걸려 있으면 선택 항목이 가려질 수 있어 함께 초기화한다.
  const handleSelect = (): void => {
    setFilterTagId(null)
    setSelectedTodoId(todo.id)
    setView('todos')
  }

  return (
    <div
      onClick={handleSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleSelect()
        }
      }}
      // 제목 툴팁이 포커스로 열리지 않으므로(아래 focusable={false}) 행 자체의 title로 전체 제목을 노출한다
      title={`${todo.title} — TODO 메뉴에서 보기`}
      className={`flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors hover:border-blue-300 hover:bg-blue-50/40 ${
        isCompleted
          ? 'bg-gray-50 border-gray-200'
          : isOverdue
            ? 'bg-red-50/50 border-red-200'
            : 'bg-white border-gray-200'
      }`}
    >
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (isCompleted) restoreTodo(todo.id)
          else completeTodo(todo.id)
        }}
        className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
          isCompleted
            ? 'bg-green-500 border-green-500 text-white'
            : 'border-gray-300 hover:border-green-400'
        }`}
      >
        {isCompleted ? (
          <svg
            className="w-2.5 h-2.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={3}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : null}
      </button>
      <span
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${priorityDot}`}
        title={todo.priority}
      />
      {/* 좁은 패널이라 1줄로는 제목 대부분이 잘린다. min-w-0이 없으면 태그·마감일을 밀어낸다 */}
      {/* 행 루트가 role="button"이라 포커스 가능한 자손을 둘 수 없다 — 툴팁 트리거를 탭 순서에서 뺀다 */}
      <div className="flex-1 min-w-0">
        <ClampedText
          text={todo.title}
          lines={2}
          focusable={false}
          className={`text-sm ${isCompleted ? 'line-through text-gray-400' : 'text-gray-900'}`}
        />
      </div>
      {todo.tags && todo.tags.length > 0
        ? todo.tags.map((tag) => (
            <span
              key={tag.id}
              className="px-1.5 py-0.5 text-[10px] rounded-full text-white flex-shrink-0"
              style={{ backgroundColor: tag.color }}
            >
              {tag.name}
            </span>
          ))
        : null}
      {todo.due_date ? (
        <span
          className={`text-[10px] flex-shrink-0 ${
            isOverdue ? 'text-red-500 font-medium' : 'text-gray-400'
          }`}
        >
          {formatDateSafe(todo.due_date, 'MM-dd HH:mm')}
        </span>
      ) : null}
    </div>
  )
}

// 대시보드 최상단의 "지금 할 일". 후보를 나열하면 매번 다시 고민하게 되므로
// 1등 하나만 크게 두고, 뒷순위는 이름 한 줄로만 흘린다.
function FocusCard({
  selection,
  onOpenProjects
}: {
  selection: FocusSelection<Project>
  onOpenProjects: () => void
}): React.ReactNode {
  const { focus, upNext, unprioritizedDevCount } = selection
  const status = focus ? (projectStatus[focus.status] ?? projectStatus.cancelled) : null

  return (
    <div className="flex-shrink-0 min-w-0">
      <div className="flex items-center justify-between gap-2 mb-4">
        <SectionTitle variant="page">지금 할 일</SectionTitle>
        {unprioritizedDevCount > 0 ? (
          <Badge
            color="bg-amber-100 text-amber-700"
            onClick={onOpenProjects}
            title="개발 중인데 우선순위가 지정되지 않은 프로젝트입니다. 프로젝트 목록에서 지정하세요."
          >
            우선순위 미지정 {unprioritizedDevCount}건
          </Badge>
        ) : null}
      </div>

      {focus && status ? (
        <Card
          hover
          onClick={onOpenProjects}
          className="cursor-pointer border-l-4 border-l-blue-500"
        >
          <div className="flex items-center gap-3 min-w-0">
            <PriorityBadge priority={focus.priority ?? null} />
            <h2 className="text-2xl font-bold text-gray-900 truncate min-w-0">{focus.name}</h2>
            <Badge color={status.badge}>{status.label}</Badge>
          </div>
          <div className="text-xs text-gray-500 mt-2">
            Dev {formatDateSafe(focus.dev_start_date, 'MM/dd')} ~{' '}
            {formatDateSafe(focus.dev_end_date, 'MM/dd')} · Deploy{' '}
            {formatDateSafe(focus.deploy_date, 'MM/dd')}
          </div>
          {upNext.length > 0 ? (
            <div className="text-xs text-gray-400 mt-3 truncate">
              다음: {upNext.map((p) => p.name).join(', ')}
            </div>
          ) : null}
        </Card>
      ) : (
        <Card>
          <EmptyState compact>
            우선순위를 지정하면 지금 할 일이 여기에 표시됩니다
          </EmptyState>
        </Card>
      )}
    </div>
  )
}

export default function Dashboard(): React.ReactNode {
  const { projects, fetchProjects, setView } = useProjectStore()
  const { status, fetchEvents, fetchStatus } = useCalendarStore()
  // 대시보드는 항상 이번 주(오늘) 일정만 본다. 캘린더 메뉴에서 다른 주로 이동해도 영향받지 않는다.
  const today = useMemo(() => new Date(), [])
  const events = useWeekEvents(today)
  const { importantMemos, fetchImportantMemos } = useMemoStore()
  const { activeTodos, fetchActiveTodos, setSelectedTodoId, setFilterTagId } = useTodoStore()

  // 오늘 일정 타임라인의 TODO 행에서 TODO 메뉴로 이동 (TodoRow와 동일 동작)
  const selectTodo = (todo: Todo): void => {
    setFilterTagId(null)
    setSelectedTodoId(todo.id)
    setView('todos')
  }

  const [showPending, setShowPending] = useState(true)
  const [showCompleted, setShowCompleted] = useState(true)
  const [todoPanelOpen, setTodoPanelOpen] = useState(true)
  const [tasksByProject, setTasksByProject] = useState<Record<number, Task[]>>({})
  const [todosFetched, setTodosFetched] = useState(false)
  const userToggledPanelRef = useRef(false)

  const toggleTodoPanel = (): void => {
    userToggledPanelRef.current = true
    setTodoPanelOpen((v) => !v)
  }
  const expandTodoPanel = (): void => {
    userToggledPanelRef.current = true
    setTodoPanelOpen(true)
  }

  useEffect(() => {
    fetchProjects()
    fetchStatus()
    fetchImportantMemos()
    fetchActiveTodos().then(() => setTodosFetched(true))
  }, [])

  // 최초 데이터 로드 후 미완료 TODO가 있을 때만 펼치고, 그 외(전부 완료/작업 없음)에는 접는다.
  // 사용자가 직접 토글한 뒤로는 건드리지 않음.
  const pendingTodoCount = activeTodos.filter((t) => t.is_completed === 0).length
  useEffect(() => {
    if (!todosFetched || userToggledPanelRef.current) return
    setTodoPanelOpen(pendingTodoCount > 0)
  }, [todosFetched, pendingTodoCount])

  useEffect(() => {
    if (status.connected) {
      fetchEvents()
    }
  }, [status.connected])

  const pendingTodos = activeTodos.filter((t) => t.is_completed === 0)
  const todayCompletedTodos = activeTodos.filter((t) => t.is_completed === 1)
  // 정렬·필터 규칙은 utils/projectOrder.ts 한 곳에만 둔다 (목록·트레이 위젯과 같은 순서)
  const activeProjects = useMemo(() => sortActiveProjects(projects), [projects])
  const focusSelection = useMemo(() => selectFocus(activeProjects), [activeProjects])

  // 프로젝트 id 집합이 실제로 바뀔 때만 배치 로드가 재실행되도록 문자열 키로 안정화
  const activeProjectIdsKey = useMemo(
    () => activeProjects.map((p) => p.id).join(','),
    [activeProjects]
  )

  // Active 프로젝트의 태스크를 1회 IPC로 일괄 로드 (N+1 방지)
  useEffect(() => {
    const ids = activeProjectIdsKey ? activeProjectIdsKey.split(',').map(Number) : []
    if (ids.length === 0) {
      setTasksByProject({})
      return
    }
    let cancelled = false
    window.api.task.listByProjectIds(ids).then((grouped) => {
      if (!cancelled) setTasksByProject(grouped)
    })
    return () => {
      cancelled = true
    }
  }, [activeProjectIdsKey])

  return (
    <div className="flex flex-col min-h-full">
      {importantMemos.length > 0 ? (
        <div className="mb-6 flex-shrink-0">
          <SectionTitle variant="page" className="mb-4"><span className="inline-flex items-center gap-1.5"><StarIcon size={16} filled className="text-amber-400" />Important Memos</span></SectionTitle>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {importantMemos.map((memo) => (
              <div
                key={memo.id}
                className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 overflow-hidden"
              >
                <div className="max-h-28 overflow-hidden relative">
                  <MarkdownContent content={memo.content} compact />
                  <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-yellow-50 to-transparent" />
                </div>
                <div className="text-xs text-gray-400 mt-2">
                  {format(new Date(memo.created_at), 'yyyy-MM-dd HH:mm:ss')}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0">
        {/* 좌측: Project + Schedule */}
        <div className="flex-1 flex flex-col min-h-0 space-y-6 min-w-0">
          <FocusCard selection={focusSelection} onOpenProjects={() => setView('projects')} />

          <div className="flex flex-col min-h-0 min-w-0">
            <SectionTitle variant="page" className="mb-4 flex-shrink-0">
              Active Projects
            </SectionTitle>
            {activeProjects.length === 0 ? (
              <Card>
                <EmptyState compact>No active projects</EmptyState>
              </Card>
            ) : (
              <div className="grid gap-4 min-w-0 [&>*]:min-w-0">
                {activeProjects.map((project) => (
                  <ProjectProgress
                    key={project.id}
                    project={project}
                    initialTasks={tasksByProject[project.id]}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="flex-shrink-0 min-w-0">
            <SectionTitle variant="page" className="mb-4">Today&apos;s Schedule</SectionTitle>
            <TodaySchedule
              events={events}
              connected={status.connected}
              todos={activeTodos}
              onSelectTodo={selectTodo}
            />
          </div>
        </div>

        {/* 우측: TODO (접힘/펼침 - 동일 DOM, width + 색상만 변경) */}
        <div
          className={`flex flex-col min-h-0 flex-shrink-0 overflow-hidden transition-all duration-200 ${
            todoPanelOpen ? 'lg:w-1/3' : 'lg:w-10 lg:-mr-6 lg:-my-6 border-l border-gray-200 items-center pt-6'
          }`}
        >
          <div
            className={`flex-shrink-0 ${
              todoPanelOpen
                ? 'flex items-center justify-between mb-4'
                : 'flex flex-col items-center gap-3'
            }`}
          >
            <div
              className={
                todoPanelOpen ? 'flex items-center gap-2' : 'flex flex-col items-center gap-3'
              }
            >
              <button
                onClick={toggleTodoPanel}
                className="text-gray-500 hover:text-gray-900 transition-colors flex-shrink-0 p-1 rounded hover:bg-gray-100"
                title={todoPanelOpen ? 'TODO 영역 접기' : 'TODO 영역 펼치기'}
                aria-label={todoPanelOpen ? 'TODO 영역 접기' : 'TODO 영역 펼치기'}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  {todoPanelOpen ? (
                    <>
                      <polyline points="13 17 18 12 13 7" />
                      <polyline points="6 17 11 12 6 7" />
                    </>
                  ) : (
                    <>
                      <polyline points="11 17 6 12 11 7" />
                      <polyline points="18 17 13 12 18 7" />
                    </>
                  )}
                </svg>
              </button>
              {todoPanelOpen ? (
                <SectionTitle variant="page" className="whitespace-nowrap">
                  ☑ TODO
                </SectionTitle>
              ) : (
                <button
                  onClick={expandTodoPanel}
                  className="text-xl leading-none hover:scale-110 transition-transform"
                  title="TODO 영역 펼치기"
                >
                  ☑
                </button>
              )}
            </div>
            {todoPanelOpen ? (
              <button
                onClick={() => setView('todos')}
                className="text-xs text-gray-500 hover:text-blue-500 transition-colors whitespace-nowrap"
              >
                전체 보기 →
              </button>
            ) : null}
          </div>

          {!todoPanelOpen ? null : activeTodos.length === 0 ? (
            <Card className="whitespace-nowrap">
              <EmptyState compact>진행 중인 TODO가 없습니다</EmptyState>
            </Card>
          ) : (
            <div className="space-y-4 overflow-auto pr-1 flex-1 min-h-0">
              {pendingTodos.length > 0 ? (
                <div>
                  <button
                    onClick={() => setShowPending(!showPending)}
                    className="w-full flex items-center justify-between mb-2 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors whitespace-nowrap"
                  >
                    <span>
                      {showPending ? '▼' : '▶'} 진행중 ({pendingTodos.length})
                    </span>
                  </button>
                  {showPending ? (
                    <div className="space-y-1.5">
                      {pendingTodos.map((todo) => (
                        <TodoRow key={todo.id} todo={todo} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {todayCompletedTodos.length > 0 ? (
                <div>
                  <button
                    onClick={() => setShowCompleted(!showCompleted)}
                    className="w-full flex items-center justify-between mb-2 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors whitespace-nowrap"
                  >
                    <span>
                      {showCompleted ? '▼' : '▶'} 완료됨 ({todayCompletedTodos.length})
                    </span>
                  </button>
                  {showCompleted ? (
                    <div className="space-y-1.5">
                      {todayCompletedTodos.map((todo) => (
                        <TodoRow key={todo.id} todo={todo} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
