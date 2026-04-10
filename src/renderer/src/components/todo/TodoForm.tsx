import { useState, useEffect } from 'react'
import { useTodoStore } from '../../stores/todoStore'
import type { Todo, TodoTag } from '../../types'

interface TodoFormProps {
  todo?: Todo | null
  onClose: () => void
}

function getCurrentDate(): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function getCurrentTime(): string {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  return `${hh}:${mi}`
}

function parseDueDate(value: string | null | undefined): { date: string; time: string } {
  if (!value) return { date: '', time: '' }
  // Accept both "YYYY-MM-DD" and "YYYY-MM-DD HH:mm"
  const [datePart, timePart = ''] = value.split(' ')
  return { date: datePart || '', time: timePart.slice(0, 5) || '' }
}

export default function TodoForm({ todo, onClose }: TodoFormProps): React.ReactNode {
  const { tags, fetchTags, createTodo, updateTodo } = useTodoStore()

  const parsed = parseDueDate(todo?.due_date)

  const [title, setTitle] = useState(todo?.title || '')
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>(todo?.priority || 'medium')
  const [dueDate, setDueDate] = useState(parsed.date)
  const [alarmEnabled, setAlarmEnabled] = useState(Boolean(parsed.time) || todo?.due_reminder === 1)
  const [dueTime, setDueTime] = useState(parsed.time || getCurrentTime())
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>(
    todo?.tags?.map((t: TodoTag) => t.id) || []
  )

  useEffect(() => {
    fetchTags()
  }, [])

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!title.trim()) return

    // If alarm is enabled, we need a date to anchor the time to
    let combinedDue: string | null = null
    if (dueDate) {
      combinedDue = alarmEnabled ? `${dueDate} ${dueTime || '00:00'}` : dueDate
    } else if (alarmEnabled) {
      // Alarm without date: fall back to today
      combinedDue = `${getCurrentDate()} ${dueTime || getCurrentTime()}`
    }

    const input = {
      title: title.trim(),
      priority,
      due_date: combinedDue,
      due_reminder: alarmEnabled ? 1 : 0,
      tag_ids: selectedTagIds
    }

    if (todo) {
      await updateTodo(todo.id, input)
    } else {
      await createTodo(input)
    }
    onClose()
  }

  const toggleTag = (tagId: number): void => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    )
  }

  const toggleAlarm = (checked: boolean): void => {
    setAlarmEnabled(checked)
    if (checked) {
      if (!dueDate) setDueDate(getCurrentDate())
      if (!dueTime) setDueTime(getCurrentTime())
    }
  }

  const priorityOptions: { value: 'low' | 'medium' | 'high'; label: string; color: string }[] = [
    { value: 'low', label: '낮음', color: 'bg-gray-100 text-gray-600 border-gray-300' },
    { value: 'medium', label: '중간', color: 'bg-blue-100 text-blue-600 border-blue-300' },
    { value: 'high', label: '높음', color: 'bg-red-100 text-red-600 border-red-300' }
  ]

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        <form onSubmit={handleSubmit}>
          <div className="p-6 space-y-4">
            <h2 className="text-lg font-semibold text-gray-900">
              {todo ? 'TODO 수정' : '새 TODO'}
            </h2>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">작업</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="할 일을 입력하세요"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">우선순위</label>
              <div className="flex gap-2">
                {priorityOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPriority(opt.value)}
                    className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-colors ${
                      priority === opt.value
                        ? opt.color
                        : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 기한 (선택) */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                기한 <span className="text-gray-400">(선택)</span>
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* 알림 설정 체크박스 + 시간 */}
            <div className="border border-gray-200 rounded-lg p-3 bg-gray-50/40">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={alarmEnabled}
                  onChange={(e) => toggleAlarm(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300"
                />
                <span className="flex items-center gap-1">
                  <span>🔔</span>
                  <span>알림 설정</span>
                </span>
              </label>
              {alarmEnabled ? (
                <div className="mt-3 pl-6">
                  <label className="block text-xs text-gray-500 mb-1">알림 시간</label>
                  <input
                    type="time"
                    value={dueTime}
                    onChange={(e) => setDueTime(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {!dueDate ? (
                    <p className="text-xs text-gray-400 mt-1">
                      기한이 비어있으면 오늘 날짜로 설정됩니다
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            {tags.length > 0 ? (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">태그</label>
                <div className="flex flex-wrap gap-2">
                  {tags.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                        selectedTagIds.includes(tag.id)
                          ? 'text-white border-transparent'
                          : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                      }`}
                      style={
                        selectedTagIds.includes(tag.id)
                          ? { backgroundColor: tag.color, borderColor: tag.color }
                          : undefined
                      }
                    >
                      {tag.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={!title.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600 disabled:opacity-40 transition-colors"
            >
              {todo ? '수정' : '추가'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
