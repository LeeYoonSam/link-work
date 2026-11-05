import { useEffect, useMemo, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useMemoStore } from '../../stores/memoStore'
import ProjectProgress from './ProjectProgress'
import MarkdownContent from '../memo/MarkdownContent'
import { selectFocus, sortActiveProjects } from './focusProject'
import { formatDateSafe } from '../../utils/date'
import type { Task } from '../../types'
import { Badge, Card, EmptyState, SectionTitle, StarIcon } from '../ui'

// 배치 로드 결과에 프로젝트 키가 없을 때 넘기는 빈 목록. 매번 새 배열을 만들지 않는다
const NO_TASKS: Task[] = []

// 홈('오늘' 화면)의 개요. 중요 메모, 진행 중 프로젝트, 우선순위 미지정 배지를 둔다.
// 집중 대상은 오늘 계획의 집중 작업 1개뿐이다 (D2). 그래서 여기에는 집중 카드가 없다.
export default function HomeOverview(): React.ReactNode {
  const { projects, fetchProjects, setView } = useProjectStore()
  const { importantMemos, fetchImportantMemos } = useMemoStore()
  // 카드에는 항상 배치 결과를 넘긴다. 이유: initialTasks 가 없으면 카드가 각자 작업을 읽는다(N+1)
  const [tasksByProject, setTasksByProject] = useState<Record<number, Task[]>>({})

  // 홈은 스피너를 보이지 않는다. 그래서 silent 로 읽는다. 실패하면 이전 목록을 그대로 둔다
  useEffect(() => {
    fetchProjects(undefined, { silent: true }).catch(() => undefined)
    fetchImportantMemos().catch(() => undefined)
  }, [])

  // 정렬·필터 규칙은 utils/projectOrder.ts 한 곳에만 있다
  const activeProjects = useMemo(() => sortActiveProjects(projects), [projects])
  // 미지정 배지에만 쓴다 (D2)
  const unprioritizedDevCount = useMemo(
    () => selectFocus(activeProjects).unprioritizedDevCount,
    [activeProjects]
  )

  // 진행 중 프로젝트의 작업을 IPC 1번으로 읽는다.
  // projects 참조가 바뀌면 다시 읽는다. 이유: 자동 갱신이 프로젝트를 다시 읽으면 작업 진행률도 바뀐다
  useEffect(() => {
    const ids = activeProjects.map((p) => p.id)
    if (ids.length === 0) {
      setTasksByProject({})
      return
    }
    let cancelled = false
    window.api.task
      .listByProjectIds(ids)
      .then((grouped) => {
        if (!cancelled) setTasksByProject(grouped)
      })
      .catch(() => {
        // 읽기에 실패하면 빈 작업으로 카드를 그린다
        if (!cancelled) setTasksByProject({})
      })
    return () => {
      cancelled = true
    }
  }, [activeProjects])

  return (
    <div id="home-overview" className="space-y-5">
      {importantMemos.length > 0 ? (
        <section>
          <SectionTitle variant="page" className="mb-3">
            <span className="inline-flex items-center gap-1.5">
              <StarIcon size={16} filled className="text-amber-400" />
              중요 메모
            </span>
          </SectionTitle>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {importantMemos.map((memo) => (
              <div
                key={memo.id}
                className="bg-yellow-50 border border-yellow-200 rounded-lg p-4"
              >
                {/* 메모 전문을 보인다. 이유: 홈 카드는 말줄임 없이 다 보인다 (사용자 피드백 2026-11-05) */}
                <div className="break-words">
                  <MarkdownContent content={memo.content} compact />
                </div>
                {/* 오늘 화면은 ISO 날짜를 보이지 않는다 (A53). 그래서 'M/d HH:mm' 으로 줄인다 */}
                <div className="text-xs text-gray-500 mt-2 tabular-nums">
                  {formatDateSafe(memo.created_at, 'M/d HH:mm')}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        {/* 배지를 제목 바로 옆에 둔다. 이유: 양 끝에 벌리면 넓은 창에서 어느 영역의 배지인지 알 수 없다 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3">
          <SectionTitle variant="page">진행 중 프로젝트</SectionTitle>
          {activeProjects.length > 0 ? (
            <span className="text-sm text-gray-500 tabular-nums">{activeProjects.length}건</span>
          ) : null}
          {unprioritizedDevCount > 0 ? (
            <Badge
              color="bg-amber-100 text-amber-700"
              onClick={() => setView('projects')}
              title="개발 중인데 우선순위가 지정되지 않은 프로젝트입니다. 프로젝트 목록에서 지정하세요."
            >
              우선순위 미지정 {unprioritizedDevCount}건 · 지정하기 →
            </Badge>
          ) : null}
        </div>
        {activeProjects.length === 0 ? (
          <Card padding="sm">
            <EmptyState compact>진행 중인 프로젝트가 없어요.</EmptyState>
          </Card>
        ) : (
          <div className="grid gap-3 min-w-0 [&>*]:min-w-0">
            {/* 카드는 가로 전체 폭을 쓴다. 이유: 진행률 막대와 일정이 넓어야 읽기 쉽다 (사용자 피드백 2026-11-05) */}
            {activeProjects.map((project) => (
              <ProjectProgress
                key={project.id}
                project={project}
                initialTasks={tasksByProject[project.id] ?? NO_TASKS}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
