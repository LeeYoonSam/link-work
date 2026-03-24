import { create } from 'zustand'
import type { Variable, VariableInput } from '../types'

interface VariableStore {
  variables: Variable[]
  loading: boolean

  fetchVariables: () => Promise<void>
  createVariable: (input: VariableInput) => Promise<void>
  updateVariable: (id: number, input: Partial<VariableInput>) => Promise<void>
  deleteVariable: (id: number) => Promise<void>
  reorderVariables: (items: { id: number; sort_order: number }[]) => Promise<void>
}

export const useVariableStore = create<VariableStore>((set, get) => ({
  variables: [],
  loading: false,

  fetchVariables: async () => {
    set({ loading: true })
    const variables = await window.api.variable.list()
    set({ variables, loading: false })
  },

  createVariable: async (input) => {
    await window.api.variable.create(input)
    await get().fetchVariables()
  },

  updateVariable: async (id, input) => {
    await window.api.variable.update(id, input)
    await get().fetchVariables()
  },

  deleteVariable: async (id) => {
    await window.api.variable.delete(id)
    await get().fetchVariables()
  },

  reorderVariables: async (items) => {
    await window.api.variable.reorder(items)
    await get().fetchVariables()
  }
}))
