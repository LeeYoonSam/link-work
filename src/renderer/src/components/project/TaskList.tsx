import { useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import type { Task } from '../../types'
import { SectionTitle, StatusDot, IconButton, PencilIcon, TrashIcon, taskStatus, button } from '../ui'

// 같은 날짜면 한 번만, 기간이면 MM-dd 범위로 압축해 표시
function formatTaskRange(start: string | null, end: string | null): string | null {
  if (!start && !end) return null
  const s = start ?? end!
  const e = end ?? start!
  if (s === e) return s
  return `${s.slice(5)} ~ ${e.slice(5)}`
}

interface TaskListProps {
  projectId: number
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
      <SectionTitle className="mb-3">Tasks</SectionTitle>

      {tasks.length === 0 ? (
        <p className="text-sm text-gray-400 mb-3">No tasks yet</p>
      ) : (
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden mb-4">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="group flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors"
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
                  <StatusDot color={taskStatus[task.status].dot} />
                  <span className="flex-1 text-sm text-gray-800 truncate" title={task.name}>
                    {task.name}
                  </span>
                  {formatTaskRange(task.start_date, task.end_date) && (
                    <span
                      className="text-xs text-gray-400 tabular-nums"
                      title={`${task.start_date ?? ''} ~ ${task.end_date ?? ''}`}
                    >
                      {formatTaskRange(task.start_date, task.end_date)}
                    </span>
                  )}
                  <select
                    value={task.status}
                    onChange={(e) => handleStatusChange(task, e.target.value)}
                    className={`text-xs px-2 py-1 rounded-full border-0 cursor-pointer ${taskStatus[task.status].badge}`}
                  >
                    {Object.entries(taskStatus).map(([value, { label }]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <IconButton title="수정" onClick={() => setEditingTask({ ...task })}>
                      <PencilIcon size={14} />
                    </IconButton>
                    <IconButton
                      tone="danger"
                      title="삭제"
                      onClick={() => {
                        if (confirm(`"${task.name}" 작업을 삭제하시겠습니까?`)) {
                          deleteTask(task.id, projectId)
                        }
                      }}
                    >
                      <TrashIcon size={14} />
                    </IconButton>
                  </div>
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
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              handleAddTask()
            }
          }}
        />
        <input
          type="date"
          value={newStartDate}
          onChange={(e) => {
            setNewStartDate(e.target.value)
            if (!newEndDate) setNewEndDate(e.target.value)
          }}
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
          className={`px-3 py-1.5 text-sm ${button.primary}`}
        >
          Add
        </button>
      </div>
    </div>
  )
}
