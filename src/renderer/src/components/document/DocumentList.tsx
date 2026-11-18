import { useEffect, useState } from 'react'
import { useDocumentStore } from '../../stores/documentStore'
import DocumentForm from './DocumentForm'
import type { Document } from '../../types'
import { Card, EmptyState, FolderIcon, IconButton, LinkIcon, PencilIcon, TrashIcon, button } from '../ui'

export default function DocumentList(): React.ReactNode {
  const { documents, fetchAllDocuments, deleteDocument, openDocument, reorderDocuments } =
    useDocumentStore()
  const [showForm, setShowForm] = useState(false)
  const [editingDoc, setEditingDoc] = useState<Document | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  useEffect(() => {
    fetchAllDocuments()
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

  const handleDragStart = (e: React.DragEvent, index: number): void => {
    setDragIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5'
    }
  }

  const handleDragOver = (e: React.DragEvent, index: number): void => {
    e.preventDefault()
    if (dragIndex === null) return
    e.dataTransfer.dropEffect = 'move'
    setOverIndex(index)
  }

  const handleDragEnd = (e: React.DragEvent, docs: Document[]): void => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '1'
    }
    if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
      const reordered = [...docs]
      const [moved] = reordered.splice(dragIndex, 1)
      reordered.splice(overIndex, 0, moved)
      const updates = reordered.map((item, i) => ({ id: item.id, sort_order: i }))
      reorderDocuments(updates)
    }
    setDragIndex(null)
    setOverIndex(null)
  }

  // 프로젝트 연결 문서도 함께 보이는 평면 목록이다
  const renderDocItem = (doc: Document, index: number, docs: Document[]): React.ReactNode => (
    <div
      key={doc.id}
      draggable
      onDragStart={(e) => handleDragStart(e, index)}
      onDragOver={(e) => handleDragOver(e, index)}
      onDragEnd={(e) => handleDragEnd(e, docs)}
      onDragLeave={() => setOverIndex(null)}
      className={`flex items-center justify-between py-2 px-3 hover:bg-gray-50 rounded-md group cursor-grab active:cursor-grabbing ${
        dragIndex !== null && overIndex === index
          ? 'border-t-2 border-blue-400'
          : ''
      }`}
    >
      <div
        className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
        onClick={() => openDocument(doc.url, doc.type)}
      >
        <span className="text-gray-300 text-xs select-none mr-1">⠿</span>
        {doc.type === 'link' ? <LinkIcon size={15} className="text-blue-400 flex-shrink-0" /> : <FolderIcon size={15} className="text-amber-400 flex-shrink-0" />}
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-900 truncate">{doc.name}</div>
          {doc.description && (
            <div className="text-xs text-gray-500 truncate">{doc.description}</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <IconButton
          title="Edit"
          onClick={(e) => {
            e.stopPropagation()
            handleEdit(doc)
          }}
        >
          <PencilIcon size={14} />
        </IconButton>
        <IconButton
          tone="danger"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation()
            handleDelete(doc.id)
          }}
        >
          <TrashIcon size={14} />
        </IconButton>
      </div>
    </div>
  )

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-bold text-gray-900">Documents</h2>
        <button
          onClick={() => setShowForm(true)}
          className={`px-4 py-2 text-sm ${button.primary}`}
        >
          + Add Document
        </button>
      </div>

      {documents.length === 0 ? (
        <EmptyState>
          <div className="text-4xl mb-3">📄</div>
          <p className="text-sm">No documents yet. Add your first document or link.</p>
        </EmptyState>
      ) : (
        <Card padding="none">
          <div className="px-2 py-1">
            {documents.map((doc, i) => renderDocItem(doc, i, documents))}
          </div>
        </Card>
      )}

      {showForm && <DocumentForm onClose={handleCloseForm} editingDocument={editingDoc} />}
    </div>
  )
}
