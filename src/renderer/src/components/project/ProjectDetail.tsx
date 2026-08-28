import { useEffect, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useDocumentStore } from '../../stores/documentStore'
import { format } from 'date-fns'
import type { Task } from '../../types'
import TaskList from './TaskList'
import ScheduleTimeline from './ScheduleTimeline'
import ReleaseNotesCard from './ReleaseNotesCard'
import DocumentForm from '../document/DocumentForm'
import MarkdownContent from '../memo/MarkdownContent'
import { AUTO_STATUS, statusSelectionPatch } from '../../utils/projectFormValidation'
import { Badge, Card, DropdownMenu, FolderIcon, IconButton, LinkIcon, SectionTitle, TrashIcon, projectStatus, button, type DropdownItem } from '../ui'

/**
 * 헤더 오버플로(⋯) 메뉴의 내용.
 *
 * 상시 노출은 Edit 하나로 줄이고 나머지는 여기로 접었다. 중단/재개는 자주 쓰지 않는데
 * 버튼으로 세워두면 좁은 폭에서 한글 라벨이 글자 단위로 깨졌고, Delete는 옆에 붙어 있을수록
 * 잘못 눌릴 자리였다. 렌더링과 떼어 둬야 항목 구성을 그대로 검증할 수 있다.
 */
export function detailMenuItems({
  onHold,
  onToggleHold,
  onDelete
}: {
  onHold: boolean
  onToggleHold: () => void
  onDelete: () => void
}): DropdownItem[] {
  return [
    {
      key: 'hold',
      label: onHold ? '재개' : '중단',
      // 무엇이 바뀌는지는 라벨만으로 알 수 없다 — 상태 고정을 걸고 푸는 일이라고 밝혀둔다.
      description: onHold ? '자동 계산으로 복귀' : '상태 수동 고정',
      leading: <span aria-hidden="true">{onHold ? '▶' : '⏸'}</span>,
      onSelect: onToggleHold
    },
    {
      key: 'delete',
      label: 'Delete',
      tone: 'danger',
      separatorBefore: true,
      onSelect: onDelete
    }
  ]
}

export default function ProjectDetail(): React.ReactNode {
  const {
    currentProject,
    setProjectView,
    setEditingProject,
    deleteProject,
    patchProject,
    tasks,
    updateTask
  } = useProjectStore()
  const { documents, fetchDocuments, openDocument, deleteDocument } = useDocumentStore()
  const [showDocForm, setShowDocForm] = useState(false)

  const cycleStatus = async (task: Task): Promise<void> => {
    const nextStatus: Record<string, string> = {
      pending: 'in_progress',
      in_progress: 'done',
      done: 'pending'
    }
    await updateTask(task.id, { status: nextStatus[task.status] })
  }

  useEffect(() => {
    if (currentProject) {
      fetchDocuments(currentProject.id)
    }
  }, [currentProject?.id])

  if (!currentProject) {
    return <div className="text-gray-400">Project not found</div>
  }

  const handleDelete = async (): Promise<void> => {
    if (confirm('Are you sure you want to delete this project?')) {
      await deleteProject(currentProject.id)
    }
  }

  const status = projectStatus[currentProject.status] ?? projectStatus.cancelled

  // 중단은 날짜로 계산할 수 없는 사정이라 늘 수동 고정이고, 재개는 그 고정을 풀어
  // 날짜 기반 자동 계산으로 되돌리는 것이다. 되돌릴 상태를 따로 기억해 둘 필요가 없다.
  const onHold = currentProject.status === 'on_hold'
  const menuItems = detailMenuItems({
    onHold,
    onToggleHold: () =>
      patchProject(currentProject.id, statusSelectionPatch(onHold ? AUTO_STATUS : 'on_hold')),
    onDelete: handleDelete
  })

  return (
    <div>
      <div className="flex items-center gap-2 mb-6">
        <button
          onClick={() => setProjectView('list')}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          &larr; Back
        </button>
      </div>

      <Card className="mb-6">
        {/* 제목 컬럼이 min-w-0으로 수축을 흡수하고, 액션 그룹은 shrink-0으로 원래 폭을 지킨다.
            반대로 두면 좁은 창에서 버튼이 먼저 눌려 한글 라벨이 세로로 깨진다. */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h3 className="text-xl font-bold text-gray-900 break-words">{currentProject.name}</h3>
            {currentProject.description && (
              <div className="mt-2 text-gray-700">
                <MarkdownContent
                  content={currentProject.description}
                  compact
                  preserveNewlines
                />
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex items-center gap-1">
              <Badge color={status.badge}>{status.label}</Badge>
              {currentProject.status_manual === 1 && (
                <span className="text-xs text-amber-500" title="수동 설정됨">✎</span>
              )}
            </div>
            <button
              onClick={() => setEditingProject(currentProject)}
              className={`px-3 py-1.5 text-sm whitespace-nowrap ${button.subtle}`}
            >
              Edit
            </button>
            <DropdownMenu
              items={menuItems}
              width="w-48"
              trigger={({ toggle }) => (
                <button
                  onClick={toggle}
                  title="더 보기"
                  aria-label="더 보기"
                  className={`px-3 py-1.5 text-sm leading-none ${button.subtle}`}
                >
                  ⋯
                </button>
              )}
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 text-sm">
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-gray-500 text-xs mb-1">Development</div>
            <div className="font-medium">
              {format(new Date(currentProject.dev_start_date), 'yyyy-MM-dd')} ~{' '}
              {format(new Date(currentProject.dev_end_date), 'yyyy-MM-dd')}
            </div>
          </div>
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-gray-500 text-xs mb-1">QA</div>
            <div className="font-medium">
              {format(new Date(currentProject.qa_start_date), 'yyyy-MM-dd')} ~{' '}
              {format(new Date(currentProject.qa_end_date), 'yyyy-MM-dd')}
            </div>
          </div>
          <div className="bg-gray-50 rounded-md p-3">
            <div className="text-gray-500 text-xs mb-1">Deploy</div>
            <div className="font-medium">
              {format(new Date(currentProject.deploy_date), 'yyyy-MM-dd')}
            </div>
            {currentProject.deploy_version && (
              <div className="text-xs text-gray-500 mt-1">v{currentProject.deploy_version}</div>
            )}
          </div>
        </div>
      </Card>

      {tasks.length > 0 && (
        <Card className="mb-6">
          <SectionTitle className="mb-4">Schedule</SectionTitle>
          <ScheduleTimeline
            project={currentProject}
            tasks={tasks}
            onCycleStatus={cycleStatus}
            variant="full"
          />
        </Card>
      )}

      <Card>
        <TaskList projectId={currentProject.id} />
      </Card>

      <Card className="mt-6">
        <div className="flex items-center justify-between mb-4">
          <SectionTitle>Documents</SectionTitle>
          <button
            onClick={() => setShowDocForm(true)}
            className={`px-3 py-1.5 text-xs ${button.primary}`}
          >
            + Add
          </button>
        </div>
        {documents.length === 0 ? (
          <p className="text-sm text-gray-400">No documents linked to this project.</p>
        ) : (
          <div className="space-y-1">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between py-2 px-2 hover:bg-gray-50 rounded group"
              >
                <div
                  className="flex items-center gap-2 cursor-pointer min-w-0 flex-1"
                  onClick={() => openDocument(doc.url, doc.type)}
                >
                  {doc.type === 'link' ? <LinkIcon size={15} className="text-blue-400 flex-shrink-0" /> : <FolderIcon size={15} className="text-amber-400 flex-shrink-0" />}
                  <span className="text-sm text-gray-900 truncate">{doc.name}</span>
                </div>
                <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                  <IconButton
                    tone="danger"
                    title="삭제"
                    onClick={() => {
                      if (confirm('Delete this document?')) deleteDocument(doc.id).then(() => fetchDocuments(currentProject.id))
                    }}
                  >
                    <TrashIcon size={14} />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <ReleaseNotesCard deployVersion={currentProject.deploy_version} />

      {showDocForm && (
        <DocumentForm
          onClose={() => {
            setShowDocForm(false)
            fetchDocuments(currentProject.id)
          }}
          defaultProjectId={currentProject.id}
        />
      )}
    </div>
  )
}
