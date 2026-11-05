import { useEffect, useState } from 'react'
import { useVariableStore } from '../../stores/variableStore'
import { useFocusRequest, useFocusStore } from '../../stores/focusStore'
import { focusDomId, useFlash, useFocusScroll } from '../../hooks/useFocusFlash'
import VariableForm from './VariableForm'
import type { Variable } from '../../types'
import { Badge, Card, EmptyState, IconButton, PencilIcon, TrashIcon, button } from '../ui'

export default function VariableList(): React.ReactNode {
  const { variables, fetchVariables, deleteVariable, reorderVariables } = useVariableStore()
  const [showForm, setShowForm] = useState(false)
  const [editingVar, setEditingVar] = useState<Variable | null>(null)
  const [revealedIds, setRevealedIds] = useState<Set<number>>(new Set())
  const [copiedId, setCopiedId] = useState<number | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  useEffect(() => {
    fetchVariables()
  }, [])

  // 앱 내 링크(linkwork://variable/{id})로 들어오면 행을 강조한다.
  // secret 값은 공개하지 않는다. 이유: 링크 클릭만으로 비밀값이 화면에 드러나면 안 된다
  const focusRequest = useFocusRequest('variable')
  const [flashId, flash] = useFlash<number>()
  useEffect(() => {
    if (!focusRequest) return
    if (!variables.some((v) => v.id === focusRequest.id)) return
    flash(focusRequest.id)
    useFocusStore.getState().consume(focusRequest.nonce)
  }, [focusRequest, variables])

  const handleDelete = async (id: number): Promise<void> => {
    if (confirm('Are you sure you want to delete this variable?')) {
      await deleteVariable(id)
    }
  }

  const handleEdit = (v: Variable): void => {
    setEditingVar(v)
    setShowForm(true)
  }

  const handleCloseForm = (): void => {
    setShowForm(false)
    setEditingVar(null)
  }

  const toggleReveal = (id: number): void => {
    setRevealedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const handleCopy = async (id: number, value: string): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const handleDragStart = (e: React.DragEvent, index: number): void => {
    setDragIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5'
    }
  }

  const handleDragOver = (e: React.DragEvent, index: number): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverIndex(index)
  }

  const handleDragEnd = (e: React.DragEvent): void => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1'
    }
    if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
      const reordered = [...variables]
      const [moved] = reordered.splice(dragIndex, 1)
      reordered.splice(overIndex, 0, moved)
      const updates = reordered.map((item, i) => ({ id: item.id, sort_order: i }))
      reorderVariables(updates)
    }
    setDragIndex(null)
    setOverIndex(null)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-bold text-gray-900">Variables</h2>
        <button
          onClick={() => setShowForm(true)}
          className={`px-4 py-2 text-sm ${button.primary}`}
        >
          + Add Variable
        </button>
      </div>

      {variables.length === 0 ? (
        <EmptyState>
          <div className="text-4xl mb-3">&#x2699;</div>
          <p className="text-sm">No variables yet. Add your first variable.</p>
        </EmptyState>
      ) : (
        <Card padding="none">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="w-8"></th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Value</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Description</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 w-20">Type</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500 w-24">Actions</th>
              </tr>
            </thead>
            <tbody>
              {variables.map((v, index) => (
                <VariableRow
                  key={v.id}
                  variable={v}
                  highlighted={v.id === flashId}
                  revealed={revealedIds.has(v.id)}
                  copied={copiedId === v.id}
                  dropTarget={overIndex === index}
                  onToggleReveal={toggleReveal}
                  onCopy={(id, value) => void handleCopy(id, value)}
                  onEdit={handleEdit}
                  onDelete={(id) => void handleDelete(id)}
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragEnd={handleDragEnd}
                  onDragLeave={() => setOverIndex(null)}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {showForm && <VariableForm onClose={handleCloseForm} editingVariable={editingVar} />}
    </div>
  )
}

// 표 행의 강조 스타일. <tr> 은 ring(box-shadow)을 브라우저마다 다르게 그린다.
// 그래서 각 셀 배경과 첫 셀의 왼쪽 강조선으로 강조한다. 리터럴로 둔다. 이유: Tailwind 는 소스의 리터럴만 스캔한다
export const ROW_FOCUS_CLASS = '*:bg-blue-50'
export const FIRST_CELL_FOCUS_CLASS = 'shadow-[inset_3px_0_0_var(--color-blue-400)]'

interface VariableRowProps {
  variable: Variable
  // 앱 내 링크로 찾아온 행이면 true. 강조하고 화면 가운데로 스크롤한다
  highlighted?: boolean
  revealed: boolean
  copied: boolean
  // 드래그 중인 행을 이 행 위에 놓으려 하면 true
  dropTarget: boolean
  onToggleReveal: (id: number) => void
  onCopy: (id: number, value: string) => void
  onEdit: (v: Variable) => void
  onDelete: (id: number) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragEnd: (e: React.DragEvent) => void
  onDragLeave: () => void
}

// 변수 표의 한 행. 행마다 스크롤 ref 가 필요해서 컴포넌트로 나눈다
export function VariableRow({
  variable: v,
  highlighted = false,
  revealed,
  copied,
  dropTarget,
  onToggleReveal,
  onCopy,
  onEdit,
  onDelete,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDragLeave
}: VariableRowProps): React.ReactNode {
  const rowRef = useFocusScroll<HTMLTableRowElement>(highlighted)
  const hidden = v.view_type === 'secret' && !revealed

  return (
    <tr
      ref={rowRef}
      id={focusDomId('variable', v.id)}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragLeave={onDragLeave}
      className={`border-b border-gray-100 hover:bg-gray-50 group cursor-grab active:cursor-grabbing ${
        dropTarget ? 'border-t-2 border-t-blue-400' : ''
      } ${highlighted ? ROW_FOCUS_CLASS : ''}`}
    >
      <td
        className={`pl-3 text-gray-300 text-xs select-none ${highlighted ? FIRST_CELL_FOCUS_CLASS : ''}`}
      >
        ⠿
      </td>
      <td className="px-4 py-3 font-medium text-gray-900">{v.key}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            onClick={() => onCopy(v.id, v.value)}
            className="relative cursor-pointer hover:text-blue-600 transition-colors"
            title="Click to copy"
          >
            {hidden ? (
              <span className="text-gray-400 tracking-wider">••••••••</span>
            ) : (
              <span className="font-mono text-sm break-all">{v.value}</span>
            )}
            {copied && (
              <span className="absolute -top-6 left-0 z-10 px-2 py-0.5 text-xs font-medium text-white bg-green-600 rounded shadow-sm pointer-events-none whitespace-nowrap">
                Copied!
              </span>
            )}
          </span>
          {v.view_type === 'secret' && (
            <button
              onClick={() => onToggleReveal(v.id)}
              className="p-1 text-gray-400 hover:text-gray-600 flex-shrink-0"
              title={revealed ? 'Hide' : 'Show'}
            >
              {revealed ? '🙈' : '👁'}
            </button>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-gray-500">{v.description || '-'}</td>
      <td className="px-4 py-3">
        <Badge
          color={v.view_type === 'secret' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-600'}
        >
          {v.view_type}
        </Badge>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <IconButton title="Edit" onClick={() => onEdit(v)}>
            <PencilIcon size={14} />
          </IconButton>
          <IconButton tone="danger" title="Delete" onClick={() => onDelete(v.id)}>
            <TrashIcon size={14} />
          </IconButton>
        </div>
      </td>
    </tr>
  )
}
