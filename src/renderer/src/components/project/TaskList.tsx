import { useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import type { Task } from '../../types'
import { buildTaskTree } from '../../utils/taskTree'
import {
  SectionTitle,
  StatusDot,
  IconButton,
  PencilIcon,
  TrashIcon,
  ChevronDownIcon,
  taskStatus,
  button
} from '../ui'

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
  // 하위 추가 폼을 여는 상위 작업 id (null이면 닫힘)
  const [addingChildFor, setAddingChildFor] = useState<number | null>(null)
  const [childName, setChildName] = useState('')
  const [childStartDate, setChildStartDate] = useState('')
  const [childEndDate, setChildEndDate] = useState('')

  const tree = buildTaskTree(tasks)

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

  const openChildForm = (parentId: number): void => {
    setAddingChildFor(parentId)
    setChildName('')
    setChildStartDate('')
    setChildEndDate('')
  }

  const handleAddChild = async (parentId: number): Promise<void> => {
    if (!childName.trim()) return
    await createTask({
      project_id: projectId,
      parent_task_id: parentId,
      name: childName,
      start_date: childStartDate || undefined,
      end_date: childEndDate || undefined
    })
    setAddingChildFor(null)
    setChildName('')
    setChildStartDate('')
    setChildEndDate('')
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

  // 상위/하위 공용 행 렌더러. isChild면 들여쓰기 + 트리 글리프, 상위면 "하위 추가" 노출.
  const renderTaskRow = (task: Task, isChild: boolean): React.ReactNode => (
    <div
      key={task.id}
      className={`group flex items-center gap-3 py-2.5 pr-3 hover:bg-gray-50 transition-colors ${
        isChild ? 'pl-9' : 'pl-3'
      }`}
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
            onChange={(e) => setEditingTask({ ...editingTask, start_date: e.target.value || null })}
            className={inputClass}
          />
          <input
            type="date"
            value={editingTask.end_date || ''}
            onChange={(e) => setEditingTask({ ...editingTask, end_date: e.target.value || null })}
            className={inputClass}
          />
          <button onClick={handleSaveEdit} className="text-sm text-blue-600 hover:text-blue-800">
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
          {isChild && <span className="text-gray-300 -ml-4 select-none">↳</span>}
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
          {/* 네이티브 select 화살표를 숨기고 커스텀 셰브론으로 겹침 방지 */}
          <span
            className={`relative inline-flex items-center rounded-full ${taskStatus[task.status].badge}`}
          >
            <select
              value={task.status}
              onChange={(e) => handleStatusChange(task, e.target.value)}
              className="appearance-none bg-transparent text-xs font-medium pl-2.5 pr-6 py-1 cursor-pointer focus:outline-none"
            >
              {Object.entries(taskStatus).map(([value, { label }]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <ChevronDownIcon size={12} className="absolute right-2 pointer-events-none" />
          </span>
          <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
            {!isChild && (
              <button
                onClick={() => openChildForm(task.id)}
                className="text-xs text-gray-400 hover:text-blue-600 px-1.5 whitespace-nowrap"
                title="하위 작업 추가"
              >
                + 하위
              </button>
            )}
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
  )

  // 상위 아래에 붙는 하위 추가 인라인 폼
  const renderChildForm = (parentId: number): React.ReactNode => (
    <div className="flex gap-2 items-center py-2 pr-3 pl-9 bg-blue-50/40">
      <span className="text-gray-300 -ml-4 select-none">↳</span>
      <input
        type="text"
        value={childName}
        onChange={(e) => setChildName(e.target.value)}
        placeholder="하위 작업 이름"
        autoFocus
        className={`flex-1 ${inputClass}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            handleAddChild(parentId)
          }
          if (e.key === 'Escape') setAddingChildFor(null)
        }}
      />
      <input
        type="date"
        value={childStartDate}
        onChange={(e) => {
          setChildStartDate(e.target.value)
          if (!childEndDate) setChildEndDate(e.target.value)
        }}
        className={inputClass}
      />
      <input
        type="date"
        value={childEndDate}
        onChange={(e) => setChildEndDate(e.target.value)}
        className={inputClass}
      />
      <button
        onClick={() => handleAddChild(parentId)}
        className={`px-3 py-1.5 text-sm ${button.primary}`}
      >
        추가
      </button>
      <button
        onClick={() => setAddingChildFor(null)}
        className="text-sm text-gray-400 hover:text-gray-600"
      >
        취소
      </button>
    </div>
  )

  return (
    <div>
      <SectionTitle className="mb-3">Tasks</SectionTitle>

      {tasks.length === 0 ? (
        <p className="text-sm text-gray-400 mb-3">No tasks yet</p>
      ) : (
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden mb-4">
          {tree.map((node) => (
            <div key={node.task.id} className="divide-y divide-gray-100">
              {renderTaskRow(node.task, false)}
              {node.children.map((child) => renderTaskRow(child, true))}
              {addingChildFor === node.task.id && renderChildForm(node.task.id)}
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
        <button onClick={handleAddTask} className={`px-3 py-1.5 text-sm ${button.primary}`}>
          Add
        </button>
      </div>
    </div>
  )
}
