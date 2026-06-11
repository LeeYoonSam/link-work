import { useEffect, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useDocumentStore } from '../../stores/documentStore'
import { format } from 'date-fns'
import type { Task } from '../../types'
import TaskList from './TaskList'
import ScheduleTimeline from './ScheduleTimeline'
import DocumentForm from '../document/DocumentForm'
import MarkdownContent from '../memo/MarkdownContent'

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

  const statusColors: Record<string, string> = {
    scheduled: 'bg-slate-100 text-slate-700',
    development: 'bg-green-100 text-green-800',
    qa: 'bg-orange-100 text-orange-800',
    deploy: 'bg-red-100 text-red-800',
    completed: 'bg-blue-100 text-blue-800',
    cancelled: 'bg-gray-100 text-gray-600'
  }

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

      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
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
              <span
                className={`px-2 py-0.5 text-xs rounded-full font-medium ${statusColors[currentProject.status]}`}
              >
                {currentProject.status}
              </span>
              {currentProject.status_manual === 1 && (
                <span className="text-xs text-amber-500" title="수동 설정됨">✎</span>
              )}
            </div>
            <button
              onClick={() => setEditingProject(currentProject)}
              className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200"
            >
              Edit
            </button>
            <button
              onClick={handleDelete}
              className="px-3 py-1.5 text-sm bg-red-50 text-red-600 rounded-md hover:bg-red-100"
            >
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
      </div>

      {tasks.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
          <h4 className="text-sm font-semibold text-gray-700 mb-4">Schedule</h4>
          <ScheduleTimeline
            project={currentProject}
            tasks={tasks}
            onCycleStatus={cycleStatus}
            variant="full"
          />
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <TaskList projectId={currentProject.id} />
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6 mt-6">
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-sm font-semibold text-gray-700">Documents</h4>
          <button
            onClick={() => setShowDocForm(true)}
            className="px-3 py-1.5 text-xs text-white bg-blue-600 rounded-md hover:bg-blue-700"
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
                  <span className="text-sm flex-shrink-0">
                    {doc.type === 'link' ? '🔗' : '📁'}
                  </span>
                  <span className="text-sm text-gray-900 truncate">{doc.name}</span>
                </div>
                <button
                  onClick={() => {
                    if (confirm('Delete this document?')) deleteDocument(doc.id).then(() => fetchDocuments(currentProject.id))
                  }}
                  className="p-1 text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  🗑️
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

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
