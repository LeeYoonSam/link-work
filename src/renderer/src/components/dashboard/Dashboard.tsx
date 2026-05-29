import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useCalendarStore } from '../../stores/calendarStore'
import { useMemoStore } from '../../stores/memoStore'
import { useTodoStore } from '../../stores/todoStore'
import ProjectProgress from './ProjectProgress'
import TodaySchedule from './TodaySchedule'
import MarkdownContent from '../memo/MarkdownContent'
import { format } from 'date-fns'
import type { Task, Todo } from '../../types'

function TodoRow({ todo }: { todo: Todo }): React.ReactNode {
  const { completeTodo, restoreTodo } = useTodoStore()
  const isCompleted = todo.is_completed === 1

  const priorityDot =
    todo.priority === 'high'
      ? 'bg-red-500'
      : todo.priority === 'medium'
        ? 'bg-blue-500'
        : 'bg-gray-400'

  const isOverdue = Boolean(
    todo.due_date && !isCompleted && new Date(todo.due_date) < new Date()
  )

  return (
    <div
      className={`flex items-center gap-2 p-2.5 rounded-lg border ${
        isCompleted
          ? 'bg-gray-50 border-gray-200'
          : isOverdue
            ? 'bg-red-50/50 border-red-200'
            : 'bg-white border-gray-200'
      }`}
    >
      <button
        onClick={() => (isCompleted ? restoreTodo(todo.id) : completeTodo(todo.id))}
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
      <span
        className={`text-sm flex-1 truncate ${
          isCompleted ? 'line-through text-gray-400' : 'text-gray-900'
        }`}
      >
        {todo.title}
      </span>
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
          {format(new Date(todo.due_date), 'MM-dd HH:mm')}
        </span>
      ) : null}
    </div>
  )
}

export default function Dashboard(): React.ReactNode {
  const { projects, fetchProjects, setView } = useProjectStore()
  const { events, status, fetchEvents, fetchStatus } = useCalendarStore()
  const { importantMemos, fetchImportantMemos } = useMemoStore()
  const { activeTodos, fetchActiveTodos } = useTodoStore()

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
  const activeProjects = useMemo(() => {
    const statusPriority: Record<string, number> = {
      development: 0,
      qa: 1,
      deploy: 2,
      scheduled: 3
    }
    return projects
      .filter((p) => ['scheduled', 'development', 'qa', 'deploy'].includes(p.status))
      .slice()
      .sort((a, b) => (statusPriority[a.status] ?? 99) - (statusPriority[b.status] ?? 99))
  }, [projects])

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
          <h3 className="text-lg font-semibold text-gray-900 mb-4">★ Important Memos</h3>
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
          <div className="flex flex-col min-h-0 min-w-0">
            <h3 className="text-lg font-semibold text-gray-900 mb-4 flex-shrink-0">
              Active Projects
            </h3>
            {activeProjects.length === 0 ? (
              <div className="text-center text-gray-400 py-8 bg-white border border-gray-200 rounded-lg text-sm">
                No active projects
              </div>
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
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Today&apos;s Schedule</h3>
            <TodaySchedule
              events={events}
              connected={status.connected}
              todos={activeTodos}
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
                <h3 className="text-lg font-semibold text-gray-900 whitespace-nowrap">
                  ☑ TODO
                </h3>
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
            <div className="text-center text-gray-400 py-8 bg-white border border-gray-200 rounded-lg text-sm whitespace-nowrap">
              진행 중인 TODO가 없습니다
            </div>
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
