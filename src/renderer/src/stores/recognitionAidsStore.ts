import { create } from 'zustand'
import type {
  GlossaryEntry,
  Member,
  MemberVoiceprint,
  RematchMeetingPlan,
  RematchOptions,
  RematchResult
} from '../types'
import { useRecordingStore } from './recordingStore'

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
}

interface MemberUpsertInput {
  id?: number
  name: string
  aliases?: string[]
  role?: string | null
  enabled?: boolean
  sort_order?: number
}

interface ImportResult {
  added: number
  updated: number
  skipped: number
}

interface RecognitionAidsStore {
  glossary: GlossaryEntry[]
  members: Member[]
  /** 구성원별 저장된 목소리 표본 요약 (표본이 없는 구성원은 빠진다) */
  voiceprints: MemberVoiceprint[]
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
  /** 구성원의 목소리 표본을 전부 지운다 */
  clearVoiceprint: (memberId: number) => Promise<boolean>
  /** 등록된 목소리로 지난 회의의 이름 없는 화자를 다시 찾는다(저장 안 함). 실패 시 null */
  previewRematch: (opts?: RematchOptions) => Promise<RematchMeetingPlan[] | null>
  /** 다시 찾은 결과를 저장한다. 목소리 표본은 만들지 않는다. 실패 시 null */
  applyRematch: (opts?: RematchOptions) => Promise<RematchResult | null>
}

// 직전 미리보기 계획. applyRematch 가 새로 읽을 열린 회의를 고르는 데 쓴다
let lastPreview: { key: string; plan: RematchMeetingPlan[] } | null = null
const rematchKey = (opts?: RematchOptions): string =>
  JSON.stringify({ meetingIds: opts?.meetingIds ?? null, memberIds: opts?.memberIds ?? null })

const message = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback

export const useRecognitionAidsStore = create<RecognitionAidsStore>((set, get) => ({
  glossary: [],
  members: [],
  voiceprints: [],
  loading: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true })
    try {
      const [glossary, members, voiceprints] = await Promise.all([
        window.api.recognitionAids.listGlossary(),
        window.api.recognitionAids.listMembers(),
        // 목소리 요약은 부가 정보다. 실패해도 용어집·구성원 목록은 보여준다.
        window.api.recognitionAids.listVoiceprints().catch((err: unknown) => {
          console.error('[recognitionAidsStore] listVoiceprints error:', err)
          return [] as MemberVoiceprint[]
        })
      ])
      set({ glossary, members, voiceprints, error: null })
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
  },

  clearVoiceprint: async (memberId) => {
    try {
      await window.api.recognitionAids.clearVoiceprint(memberId)
      set({ error: null })
      await get().fetchAll()
      return true
    } catch (err) {
      console.error('[recognitionAidsStore] clearVoiceprint error:', err)
      set({ error: message(err, '목소리 삭제 실패') })
      return false
    }
  },

  previewRematch: async (opts) => {
    try {
      const plan = await window.api.recognitionAids.previewRematch(opts)
      lastPreview = { key: rematchKey(opts), plan }
      return plan
    } catch (err) {
      console.error('[recognitionAidsStore] previewRematch error:', err)
      return null
    }
  },

  applyRematch: async (opts) => {
    try {
      // 바뀔 회의는 직전 미리보기 계획으로 안다. 이유: 적용 결과는 건수만 돌려준다.
      // 같은 조건의 미리보기가 없으면 열린 회의를 새로 읽는다
      const plan = lastPreview?.key === rematchKey(opts) ? lastPreview.plan : null
      lastPreview = null
      const result = await window.api.recognitionAids.applyRematch(opts)
      await get().fetchAll()
      const recording = useRecordingStore.getState()
      const openId = recording.current?.meeting.id
      if (
        openId != null &&
        (plan === null ||
          plan.some((p) => p.meeting_id === openId) ||
          (opts?.meetingIds?.includes(openId) ?? false))
      ) {
        await recording.refreshCurrent()
      }
      return result
    } catch (err) {
      console.error('[recognitionAidsStore] applyRematch error:', err)
      return null
    }
  }
}))
