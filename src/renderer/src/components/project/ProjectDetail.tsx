import { useProjectStore } from '../../stores/projectStore'
import { format } from 'date-fns'
import TaskList from './TaskList'

export default function ProjectDetail(): React.ReactNode {
  const { currentProject, setProjectView, setEditingProject, deleteProject } = useProjectStore()

  if (!currentProject) {
    return <div className="text-gray-400">Project not found</div>
  }

  const handleDelete = async (): Promise<void> => {
    if (confirm('Are you sure you want to delete this project?')) {
      await deleteProject(currentProject.id)
    }
  }

  const statusColors: Record<string, string> = {
    active: 'bg-green-100 text-green-800',
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
              <p className="text-gray-500 mt-1">{currentProject.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-0.5 text-xs rounded-full font-medium ${statusColors[currentProject.status]}`}
            >
              {currentProject.status}
            </span>
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
          </div>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-6">
        <TaskList projectId={currentProject.id} />
      </div>
    </div>
  )
}
