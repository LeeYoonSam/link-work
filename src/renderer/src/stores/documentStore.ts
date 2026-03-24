import { create } from 'zustand'
import type { Document, DocumentInput } from '../types'

interface DocumentStore {
  documents: Document[]
  loading: boolean

  fetchDocuments: (projectId?: number | null) => Promise<void>
  fetchAllDocuments: () => Promise<void>
  createDocument: (input: DocumentInput) => Promise<void>
  updateDocument: (id: number, input: Partial<DocumentInput>) => Promise<void>
  deleteDocument: (id: number) => Promise<void>
  openDocument: (url: string, type: 'link' | 'file') => Promise<void>
  reorderDocuments: (items: { id: number; sort_order: number }[]) => Promise<void>
}

export const useDocumentStore = create<DocumentStore>((set, get) => ({
  documents: [],
  loading: false,

  fetchDocuments: async (projectId?) => {
    set({ loading: true })
    const documents = await window.api.document.list(projectId)
    set({ documents, loading: false })
  },

  fetchAllDocuments: async () => {
    set({ loading: true })
    const documents = await window.api.document.listAll()
    set({ documents, loading: false })
  },

  createDocument: async (input) => {
    await window.api.document.create(input)
    await get().fetchAllDocuments()
  },

  updateDocument: async (id, input) => {
    await window.api.document.update(id, input)
    await get().fetchAllDocuments()
  },

  deleteDocument: async (id) => {
    await window.api.document.delete(id)
    await get().fetchAllDocuments()
  },

  openDocument: async (url, type) => {
    await window.api.document.open(url, type)
  },

  reorderDocuments: async (items) => {
    await window.api.document.reorder(items)
    await get().fetchAllDocuments()
  }
}))
