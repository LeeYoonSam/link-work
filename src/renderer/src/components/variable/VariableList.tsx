import { useEffect, useState } from 'react'
import { useVariableStore } from '../../stores/variableStore'
import VariableForm from './VariableForm'
import type { Variable } from '../../types'

export default function VariableList(): React.ReactNode {
  const { variables, fetchVariables, deleteVariable } = useVariableStore()
  const [showForm, setShowForm] = useState(false)
  const [editingVar, setEditingVar] = useState<Variable | null>(null)
  const [revealedIds, setRevealedIds] = useState<Set<number>>(new Set())
  const [copiedId, setCopiedId] = useState<number | null>(null)

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
          className="px-4 py-2 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700"
        >
          + Add Variable
        </button>
      </div>

      {variables.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-3">&#x2699;</div>
          <p className="text-sm">No variables yet. Add your first variable.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 font-medium text-gray-500">Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Value</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Description</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 w-20">Type</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500 w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {variables.map((v) => (
                <tr key={v.id} className="border-b border-gray-100 hover:bg-gray-50 group">
                  <td className="px-4 py-3 font-mono font-medium text-gray-900">{v.key}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        onClick={() => handleCopy(v.id, v.value)}
                        className="cursor-pointer hover:text-blue-600 transition-colors"
                        title="Click to copy"
                      >
                        {copiedId === v.id ? (
                          <span className="text-green-600 text-xs font-medium">Copied!</span>
                        ) : (
                          renderValue(v)
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
                    <span
                      className={`px-2 py-0.5 text-xs rounded-full font-medium ${
                        v.view_type === 'secret'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {v.view_type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleEdit(v)}
                        className="p-1.5 text-gray-400 hover:text-gray-600 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Edit"
                      >
                        ✏️
                      </button>
                      <button
                        onClick={() => handleDelete(v.id)}
                        className="p-1.5 text-gray-400 hover:text-red-600 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete"
                      >
                        🗑️
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && <VariableForm onClose={handleCloseForm} editingVariable={editingVar} />}
    </div>
  )
}
