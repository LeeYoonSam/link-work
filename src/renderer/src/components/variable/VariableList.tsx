import { useEffect, useState } from 'react'
import { useVariableStore } from '../../stores/variableStore'
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

  const renderValue = (v: Variable): React.ReactNode => {
    if (v.view_type === 'secret' && !revealedIds.has(v.id)) {
      return <span className="text-gray-400 tracking-wider">••••••••</span>
    }
    return <span className="font-mono text-sm break-all">{v.value}</span>
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
                <tr
                  key={v.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragEnd={handleDragEnd}
                  onDragLeave={() => setOverIndex(null)}
                  className={`border-b border-gray-100 hover:bg-gray-50 group cursor-grab active:cursor-grabbing ${
                    overIndex === index ? 'border-t-2 border-t-blue-400' : ''
                  }`}
                >
                  <td className="pl-3 text-gray-300 text-xs select-none">⠿</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{v.key}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        onClick={() => handleCopy(v.id, v.value)}
                        className="relative cursor-pointer hover:text-blue-600 transition-colors"
                        title="Click to copy"
                      >
                        {renderValue(v)}
                        {copiedId === v.id && (
                          <span className="absolute -top-6 left-0 z-10 px-2 py-0.5 text-xs font-medium text-white bg-green-600 rounded shadow-sm pointer-events-none whitespace-nowrap">
                            Copied!
                          </span>
                        )}
                      </span>
                      {v.view_type === 'secret' && (
                        <button
                          onClick={() => toggleReveal(v.id)}
                          className="p-1 text-gray-400 hover:text-gray-600 flex-shrink-0"
                          title={revealedIds.has(v.id) ? 'Hide' : 'Show'}
                        >
                          {revealedIds.has(v.id) ? '🙈' : '👁'}
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{v.description || '-'}</td>
                  <td className="px-4 py-3">
                    <Badge
                      color={
                        v.view_type === 'secret'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-gray-100 text-gray-600'
                      }
                    >
                      {v.view_type}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <IconButton
                        title="Edit"
                        onClick={() => handleEdit(v)}
                      >
                        <PencilIcon size={14} />
                      </IconButton>
                      <IconButton
                        tone="danger"
                        title="Delete"
                        onClick={() => handleDelete(v.id)}
                      >
                        <TrashIcon size={14} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {showForm && <VariableForm onClose={handleCloseForm} editingVariable={editingVar} />}
    </div>
  )
}
