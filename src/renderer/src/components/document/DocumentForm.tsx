import { useState, useEffect } from 'react'
import { useDocumentStore } from '../../stores/documentStore'
import { useProjectStore } from '../../stores/projectStore'
import type { Document } from '../../types'
import { SectionTitle, button } from '../ui'

interface DocumentFormProps {
  onClose: () => void
  editingDocument?: Document | null
  defaultProjectId?: number | null
}

export default function DocumentForm({
  onClose,
  editingDocument,
  defaultProjectId
}: DocumentFormProps): React.ReactNode {
  const { createDocument, updateDocument } = useDocumentStore()
  const { projects, fetchProjects } = useProjectStore()

  const [name, setName] = useState(editingDocument?.name || '')
  const [url, setUrl] = useState(editingDocument?.url || '')
  const [type, setType] = useState<'link' | 'file'>(editingDocument?.type || 'link')
  const [description, setDescription] = useState(editingDocument?.description || '')
  const [projectId, setProjectId] = useState<number | null>(
    editingDocument?.project_id ?? defaultProjectId ?? null
  )

  useEffect(() => {
    fetchProjects()
  }, [])

  const handleUrlChange = (value: string): void => {
    setUrl(value)
    if (/^https?:\/\//.test(value)) {
      setType('link')
    } else if (value && !editingDocument) {
      setType('file')
    }
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim() || !url.trim()) return

    const input = {
      name: name.trim(),
      url: url.trim(),
      type,
      description: description.trim() || undefined,
      project_id: projectId
    }

    if (editingDocument) {
      await updateDocument(editingDocument.id, input)
    } else {
      await createDocument(input)
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-md">
        <SectionTitle variant="page" className="mb-4">
          {editingDocument ? 'Edit Document' : 'Add Document'}
        </SectionTitle>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Document name"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">URL / Path</label>
            <input
              type="text"
              value={url}
              onChange={(e) => handleUrlChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="https://... or /path/to/file"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as 'link' | 'file')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="link">Link</option>
              <option value="file">File</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Optional description"
              rows={2}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Project</label>
            <select
              value={projectId ?? ''}
              onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">None (General)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
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
              {editingDocument ? 'Save' : 'Add'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
