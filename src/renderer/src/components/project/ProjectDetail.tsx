import { useEffect, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useDocumentStore } from '../../stores/documentStore'
import { format } from 'date-fns'
import type { Task } from '../../types'
import TaskList from './TaskList'
import ScheduleTimeline from './ScheduleTimeline'
import DocumentForm from '../document/DocumentForm'
import MarkdownContent from '../memo/MarkdownContent'
import { Badge, Card, FolderIcon, IconButton, LinkIcon, SectionTitle, TrashIcon, projectStatus, button } from '../ui'

export default function ProjectDetail(): React.ReactNode {
  const { currentProject, setProjectView, setEditingProject, deleteProject, tasks, updateTask } =
    useProjectStore()
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
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-xl font-bold text-gray-900">{currentProject.name}</h3>
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
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Badge color={status.badge}>{status.label}</Badge>
              {currentProject.status_manual === 1 && (
                <span className="text-xs text-amber-500" title="수동 설정됨">✎</span>
              )}
            </div>
            <button
              onClick={() => setEditingProject(currentProject)}
              className={`px-3 py-1.5 text-sm ${button.subtle}`}
            >
              Edit
            </button>
            <button onClick={handleDelete} className={`px-3 py-1.5 text-sm ${button.danger}`}>
              Delete
            </button>
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
