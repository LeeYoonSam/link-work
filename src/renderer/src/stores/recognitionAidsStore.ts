import { create } from 'zustand'
import type { GlossaryEntry, Member } from '../types'

// 인식 보조 장치(용어집·구성원) 전역 상태.
//
// 녹음 컨트롤(참석자 칩), 상세 화면(참석자 편집), 인식 보조 패널이 같은 목록을 본다.
// 세 화면이 각자 로드하면 한쪽에서 구성원을 추가해도 다른 쪽이 옛 목록을 들고 있게 되므로
// 스토어 하나에 모으고, 쓰기 액션은 항상 목록을 다시 읽어 동기화한다.
//
// 실패는 throw하지 않고 `error`에 담는다 — 행 단위 편집(blur 저장)에서 호출부마다
// try/catch를 두는 대신 패널이 배너 한 곳에서 보여준다.

interface GlossaryUpsertInput {
  id?: number
  term: string
  aliases?: string[]
  note?: string | null
  priority?: number
  enabled?: boolean
  project_id?: number | null
}

interface MemberUpsertInput {
  id?: number
  name: string
  aliases?: string[]
  role?: string | null
  enabled?: boolean
  sort_order?: number
}

export interface ImportResult {
  added: number
  updated: number
  skipped: number
}

interface RecognitionAidsStore {
  glossary: GlossaryEntry[]
  members: Member[]
  loading: boolean
  /** 마지막 액션의 실패 사유. 성공하면 null로 지워진다. */
  error: string | null

  fetchAll: () => Promise<void>
  upsertGlossary: (input: GlossaryUpsertInput) => Promise<boolean>
  removeGlossary: (id: number) => Promise<boolean>
  /** 실패 시 null */
  importGlossaryText: (text: string) => Promise<ImportResult | null>
  upsertMember: (input: MemberUpsertInput) => Promise<boolean>
  removeMember: (id: number) => Promise<boolean>
}

const message = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback

export const useRecognitionAidsStore = create<RecognitionAidsStore>((set, get) => ({
  glossary: [],
  members: [],
  loading: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true })
    try {
      const [glossary, members] = await Promise.all([
        window.api.recognitionAids.listGlossary(),
        window.api.recognitionAids.listMembers()
      ])
      set({ glossary, members, error: null })
    } catch (err) {
      console.error('[recognitionAidsStore] fetchAll error:', err)
      set({ error: message(err, '인식 보조 정보를 불러오지 못했습니다') })
    } finally {
      set({ loading: false })
    }
  },

  upsertGlossary: async (input) => {
    try {
      await window.api.recognitionAids.upsertGlossary(input)
      set({ error: null })
      await get().fetchAll()
      return true
    } catch (err) {
      console.error('[recognitionAidsStore] upsertGlossary error:', err)
      set({ error: message(err, '용어 저장 실패') })
      return false
    }
  },

  removeGlossary: async (id) => {
    try {
      await window.api.recognitionAids.removeGlossary(id)
      set({ error: null })
      await get().fetchAll()
      return true
    } catch (err) {
      console.error('[recognitionAidsStore] removeGlossary error:', err)
      set({ error: message(err, '용어 삭제 실패') })
      return false
    }
  },

  importGlossaryText: async (text) => {
    try {
      const result = await window.api.recognitionAids.importGlossaryText(text)
      set({ error: null })
      await get().fetchAll()
      return result
    } catch (err) {
      console.error('[recognitionAidsStore] importGlossaryText error:', err)
      set({ error: message(err, '가져오기 실패') })
      return null
    }
  },

  upsertMember: async (input) => {
    try {
      await window.api.recognitionAids.upsertMember(input)
      set({ error: null })
      await get().fetchAll()
      return true
    } catch (err) {
      console.error('[recognitionAidsStore] upsertMember error:', err)
      set({ error: message(err, '구성원 저장 실패') })
      return false
    }
  },

  removeMember: async (id) => {
    try {
      await window.api.recognitionAids.removeMember(id)
      set({ error: null })
      await get().fetchAll()
      return true
    } catch (err) {
      console.error('[recognitionAidsStore] removeMember error:', err)
      set({ error: message(err, '구성원 삭제 실패') })
      return false
    }
  }
}))
