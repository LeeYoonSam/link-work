import { useState } from 'react'
import { useVariableStore } from '../../stores/variableStore'
import type { Variable, VariableViewType } from '../../types'
import { SectionTitle, button } from '../ui'

interface VariableFormProps {
  onClose: () => void
  editingVariable?: Variable | null
}

export default function VariableForm({
  onClose,
  editingVariable
}: VariableFormProps): React.ReactNode {
  const { createVariable, updateVariable } = useVariableStore()

  const [key, setKey] = useState(editingVariable?.key || '')
  const [value, setValue] = useState(editingVariable?.value || '')
  const [description, setDescription] = useState(editingVariable?.description || '')
  const [viewType, setViewType] = useState<VariableViewType>(
    editingVariable?.view_type || 'general'
  )
  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!key.trim() || !value.trim()) return

    const input = {
      key: key.trim(),
      value: value.trim(),
      description: description.trim() || undefined,
      view_type: viewType
    }

    if (editingVariable) {
      await updateVariable(editingVariable.id, input)
    } else {
      await createVariable(input)
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <SectionTitle variant="page" className="mb-4">
          {editingVariable ? 'Edit Variable' : 'Add Variable'}
        </SectionTitle>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Variable name"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Value</label>
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="value"
              rows={2}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Optional description"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">View Type</label>
            <select
              value={viewType}
              onChange={(e) => setViewType(e.target.value as VariableViewType)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="general">General (visible)</option>
              <option value="secret">Secret (masked)</option>
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className={`px-4 py-2 text-sm ${button.subtle}`}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`px-4 py-2 text-sm ${button.primary}`}
            >
              {editingVariable ? 'Save' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
