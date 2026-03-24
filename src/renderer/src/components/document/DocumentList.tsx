import { useEffect, useState } from 'react'
import { useDocumentStore } from '../../stores/documentStore'
import { useProjectStore } from '../../stores/projectStore'
import DocumentForm from './DocumentForm'
import type { Document } from '../../types'

export default function DocumentList(): React.ReactNode {
  const { documents, fetchAllDocuments, deleteDocument, openDocument } = useDocumentStore()
  const { projects, fetchProjects } = useProjectStore()
  const [showForm, setShowForm] = useState(false)
  const [editingDoc, setEditingDoc] = useState<Document | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetchAllDocuments()
    fetchProjects()
  }, [])

  const handleDelete = async (id: number): Promise<void> => {
    if (confirm('Are you sure you want to delete this document?')) {
      await deleteDocument(id)
    }
  }

  const handleEdit = (doc: Document): void => {
    setEditingDoc(doc)
    setShowForm(true)
  }

  const handleCloseForm = (): void => {
    setShowForm(false)
    setEditingDoc(null)
  }

  const toggleGroup = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  // Group documents by project
  const generalDocs = documents.filter((d) => !d.project_id)
  const projectGroups = new Map<number, { name: string; docs: Document[] }>()

  for (const doc of documents) {
    if (doc.project_id) {
      if (!projectGroups.has(doc.project_id)) {
        const project = projects.find((p) => p.id === doc.project_id)
        projectGroups.set(doc.project_id, {
          name: doc.project_name || project?.name || `Project #${doc.project_id}`,
          docs: []
        })
      }
      projectGroups.get(doc.project_id)!.docs.push(doc)
    }
  }

  const renderDocItem = (doc: Document): React.ReactNode => (
    <div
      key={doc.id}
      className="flex items-center justify-between py-2 px-3 hover:bg-gray-50 rounded-md group"
    >
      <div
        className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
        onClick={() => openDocument(doc.url, doc.type)}
      >
        <span className="text-base flex-shrink-0">{doc.type === 'link' ? '🔗' : '📁'}</span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900 truncate">{doc.name}</div>
          {doc.description && (
            <div className="text-xs text-gray-500 truncate">{doc.description}</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => {
            e.stopPropagation()
            handleEdit(doc)
          }}
          className="p-1.5 text-gray-400 hover:text-gray-600 rounded"
          title="Edit"
        >
          ✏️
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            handleDelete(doc.id)
          }}
          className="p-1.5 text-gray-400 hover:text-red-600 rounded"
          title="Delete"
        >
          🗑️
        </button>
      </div>
    </div>
  )

  const renderGroup = (key: string, title: string, docs: Document[]): React.ReactNode => {
    const isCollapsed = collapsedGroups.has(key)
    return (
      <div key={key} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <button
          onClick={() => toggleGroup(key)}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">{isCollapsed ? '▶' : '▼'}</span>
            <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
            <span className="text-xs text-gray-400">({docs.length})</span>
          </div>
        </button>
        {!isCollapsed && (
          <div className="border-t border-gray-100 px-2 py-1">{docs.map(renderDocItem)}</div>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-bold text-gray-900">Documents</h2>
        <button
          onClick={() => setShowForm(true)}
          className="px-4 py-2 text-sm text-white bg-blue-600 rounded-md hover:bg-blue-700"
        >
          + Add Document
        </button>
      </div>

      {documents.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-3">📄</div>
          <p className="text-sm">No documents yet. Add your first document or link.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {Array.from(projectGroups.entries()).map(([projectId, group]) =>
            renderGroup(`project-${projectId}`, group.name, group.docs)
          )}
          {generalDocs.length > 0 && renderGroup('general', 'General', generalDocs)}
        </div>
      )}

      {showForm && <DocumentForm onClose={handleCloseForm} editingDocument={editingDoc} />}
    </div>
  )
}
