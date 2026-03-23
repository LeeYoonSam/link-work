import { useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import type { Task } from '../../types'

interface TaskListProps {
  projectId: number
}

const statusColors: Record<string, string> = {
  pending: 'bg-gray-100 text-gray-600',
  in_progress: 'bg-yellow-100 text-yellow-800',
  done: 'bg-green-100 text-green-800'
}

const statusLabels: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  done: 'Done'
}

export default function TaskList({ projectId }: TaskListProps): React.ReactNode {
  const { tasks, createTask, updateTask, deleteTask } = useProjectStore()
  const [newTaskName, setNewTaskName] = useState('')
  const [newStartDate, setNewStartDate] = useState('')
  const [newEndDate, setNewEndDate] = useState('')
  const [editingTask, setEditingTask] = useState<Task | null>(null)

  const handleAddTask = async (): Promise<void> => {
    if (!newTaskName.trim()) return
    await createTask({
      project_id: projectId,
      name: newTaskName,
      start_date: newStartDate || undefined,
      end_date: newEndDate || undefined
    })
    setNewTaskName('')
    setNewStartDate('')
    setNewEndDate('')
  }

  const handleStatusChange = async (task: Task, status: string): Promise<void> => {
    await updateTask(task.id, { status })
  }

  const handleSaveEdit = async (): Promise<void> => {
    if (!editingTask) return
    await updateTask(editingTask.id, {
      name: editingTask.name,
      start_date: editingTask.start_date || undefined,
      end_date: editingTask.end_date || undefined
    })
    setEditingTask(null)
  }

  const inputClass =
    'px-2 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-700 mb-3">Tasks</h4>

      {tasks.length === 0 ? (
        <p className="text-sm text-gray-400 mb-3">No tasks yet</p>
      ) : (
        <div className="space-y-2 mb-4">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-center gap-2 bg-white border border-gray-200 rounded-md px-3 py-2"
            >
              {editingTask?.id === task.id ? (
                <>
                  <input
                    type="text"
                    value={editingTask.name}
                    onChange={(e) => setEditingTask({ ...editingTask, name: e.target.value })}
                    className={`flex-1 ${inputClass}`}
                  />
                  <input
                    type="date"
                    value={editingTask.start_date || ''}
                    onChange={(e) =>
                      setEditingTask({ ...editingTask, start_date: e.target.value || null })
                    }
                    className={inputClass}
                  />
                  <input
                    type="date"
                    value={editingTask.end_date || ''}
                    onChange={(e) =>
                      setEditingTask({ ...editingTask, end_date: e.target.value || null })
                    }
                    className={inputClass}
                  />
                  <button
                    onClick={handleSaveEdit}
                    className="text-sm text-blue-600 hover:text-blue-800"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingTask(null)}
                    className="text-sm text-gray-400 hover:text-gray-600"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm text-gray-800">{task.name}</span>
                  {task.start_date && (
                    <span className="text-xs text-gray-400">
                      {task.start_date} ~ {task.end_date || ''}
                    </span>
                  )}
                  <select
                    value={task.status}
                    onChange={(e) => handleStatusChange(task, e.target.value)}
                    className={`text-xs px-2 py-1 rounded-full border-0 ${statusColors[task.status]}`}
                  >
                    {Object.entries(statusLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => setEditingTask({ ...task })}
                    className="text-xs text-gray-400 hover:text-gray-600"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteTask(task.id, projectId)}
                    className="text-xs text-red-400 hover:text-red-600"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end">
        <input
          type="text"
          value={newTaskName}
          onChange={(e) => setNewTaskName(e.target.value)}
          placeholder="New task name"
          className={`flex-1 ${inputClass}`}
          onKeyDown={(e) => e.key === 'Enter' && handleAddTask()}
        />
        <input
          type="date"
          value={newStartDate}
          onChange={(e) => setNewStartDate(e.target.value)}
          className={inputClass}
        />
        <input
          type="date"
          value={newEndDate}
          onChange={(e) => setNewEndDate(e.target.value)}
          className={inputClass}
        />
        <button
          onClick={handleAddTask}
          className="px-3 py-1.5 bg-gray-900 text-white text-sm rounded hover:bg-gray-800 transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  )
}
