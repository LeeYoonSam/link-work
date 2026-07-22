import { create } from 'zustand'
import type {
  Meeting,
  MeetingDetail,
  MeetingKind,
  RecordingStreamEvent
} from '../types'
import { blobToWav16kMono } from '../utils/audio'

interface ProcessingState {
  meetingId: number
  phase: string
  progress?: number
  message?: string
}

// 목록 필터 — 'all'이면 회의·면접을 함께 본다
export type KindFilter = 'all' | MeetingKind

interface RecordingStore {
  meetings: Meeting[]
  current: MeetingDetail | null
  loading: boolean
  // 회의별 진행률 맵 (meetingId → 상태). 여러 회의를 동시에 재처리해도
  // 각 회의의 진행률이 서로 덮어쓰지 않고 독립적으로 표시된다.
  processing: Record<number, ProcessingState>
  // 다른 메뉴에 다녀와도 보고 있던 필터가 유지되도록 전역 상태로 둔다
  // (RecordingView는 메뉴 전환 시 언마운트된다).
  kindFilter: KindFilter
  setKindFilter: (f: KindFilter) => void

  // 목록/상세
  fetchMeetings: () => Promise<void>
  openMeeting: (id: number) => Promise<void>
  closeMeeting: () => void
  refreshCurrent: () => Promise<void>

  // 녹음 완료 → 저장+처리+요약 오케스트레이션
  createDraft: (input: {
    title?: string
    source: 'mic' | 'mic+system'
    kind?: MeetingKind
  }) => Promise<number>
  saveAndProcess: (meetingId: number, blob: Blob, durationMs: number, mime: string) => Promise<void>
  summarizeMeeting: (id: number) => Promise<void>
  reprocessMeeting: (id: number, fast?: boolean) => Promise<void>

  // 편집/연계
  renameMeeting: (id: number, title: string) => Promise<void>
  removeMeeting: (id: number) => Promise<void>
  updateSpeaker: (
    speakerId: number,
    input: { display_name?: string | null; color?: string; label?: string }
  ) => Promise<void>
  reassignSegment: (segmentId: number, speakerId: number | null) => Promise<void>
  updateSegmentText: (segmentId: number, text: string) => Promise<void>
  // 새 화자를 추가하고 id를 반환 (같은 이름이 있으면 기존 화자 id 재사용). 실패 시 null
  addSpeaker: (meetingId: number, name: string) => Promise<number | null>
  mergeSpeakers: (meetingId: number, fromSpeakerId: number, intoSpeakerId: number) => Promise<void>
  toggleCut: (cutId: number, enabled: boolean) => Promise<void>
  actionItemToTodo: (meetingId: number, index: number) => Promise<void>
  linkProject: (id: number, projectId: number | null) => Promise<void>
  setExpectedSpeakers: (id: number, n: number | null) => Promise<void>

  // 처리 진행률 스트림 구독
  subscribeStream: () => () => void
}

export const useRecordingStore = create<RecordingStore>((set, get) => ({
  meetings: [],
  current: null,
  loading: false,
  processing: {},
  kindFilter: 'all',

  setKindFilter: (f) => set({ kindFilter: f }),

  fetchMeetings: async () => {
    set({ loading: true })
    try {
      const meetings = await window.api.recording.list()
      set({ meetings })
    } catch (err) {
      console.error('[recordingStore] fetchMeetings error:', err)
    } finally {
      set({ loading: false })
    }
  },

  openMeeting: async (id) => {
    set({ loading: true })
    try {
      const detail = await window.api.recording.get(id)
      set({ current: detail })
    } catch (err) {
      console.error('[recordingStore] openMeeting error:', err)
    } finally {
      set({ loading: false })
    }
  },

  closeMeeting: () => {
    set({ current: null })
  },

  refreshCurrent: async () => {
    const { current } = get()
    if (!current) return
    try {
      const detail = await window.api.recording.get(current.meeting.id)
      set({ current: detail })
    } catch (err) {
      console.error('[recordingStore] refreshCurrent error:', err)
    }
  },

  createDraft: async (input) => {
    const result = await window.api.recording.createDraft({
      title: input.title,
      source: input.source,
      kind: input.kind
    })
    await get().fetchMeetings()
    return result.id
  },

  saveAndProcess: async (meetingId, blob, durationMs, mime) => {
    try {
      // 1) 오디오 저장 — whisper 입력 포맷(16kHz mono WAV)으로 변환해 저장한다.
      //    WAV는 duration 메타데이터도 갖춰 재생 표시가 정확하다.
      //    변환 실패 시 원본(webm)을 저장하고 폴백 전사로 진행한다.
      let bytes: ArrayBuffer
      let saveMime = mime
      let saveDuration = durationMs
      let channelEnergy: { hopMs: number; left: number[]; right: number[] } | null = null
      try {
        const converted = await blobToWav16kMono(blob)
        bytes = converted.wav
        saveMime = 'audio/wav'
        if (converted.durationMs > 0) saveDuration = converted.durationMs
        channelEnergy = converted.channelEnergy
      } catch (convErr) {
        console.warn('[recordingStore] WAV 변환 실패, 원본 저장:', convErr)
        bytes = await blob.arrayBuffer()
      }
      await window.api.recording.saveAudio(
        meetingId,
        bytes,
        { mime: saveMime, durationMs: saveDuration },
        channelEnergy
      )
      await get().refreshCurrent()

      // 2) 전사+화자분리+VAD 파이프라인
      const processResult = await window.api.recording.process(meetingId)
      await get().refreshCurrent()

      if (!processResult.success) {
        console.error('[recordingStore] process failed:', processResult.error)
        return
      }

      // 3) AI 요약 — 실제 전사가 있을 때만 자동 실행.
      // 폴백 전사(엔진 미설치/빈 전사)면 불필요한 Claude 호출을 건너뛴다.
      if (processResult.transcribed) {
        await get().summarizeMeeting(meetingId)
      }
    } catch (err) {
      console.error('[recordingStore] saveAndProcess error:', err)
      await get().refreshCurrent()
    }
  },

  summarizeMeeting: async (id) => {
    try {
      const result = await window.api.recording.summarize(id)
      await get().refreshCurrent()
      if (!result.success) {
        console.error('[recordingStore] summarize failed:', result.error)
      }
    } catch (err) {
      console.error('[recordingStore] summarizeMeeting error:', err)
    }
  },

  reprocessMeeting: async (id, fast = false) => {
    try {
      const processResult = await window.api.recording.process(
        id,
        fast ? { skipTranscribe: true } : undefined
      )
      await get().refreshCurrent()
      if (processResult.success && processResult.transcribed) {
        await get().summarizeMeeting(id)
      }
    } catch (err) {
      console.error('[recordingStore] reprocessMeeting error:', err)
    }
  },

  setExpectedSpeakers: async (id, n) => {
    try {
      await window.api.recording.setExpectedSpeakers(id, n)
      await get().refreshCurrent()
    } catch (err) {
      console.error('[recordingStore] setExpectedSpeakers error:', err)
    }
  },

  renameMeeting: async (id, title) => {
    try {
      await window.api.recording.rename(id, title)
      await get().fetchMeetings()
      await get().refreshCurrent()
    } catch (err) {
      console.error('[recordingStore] renameMeeting error:', err)
    }
  },

  removeMeeting: async (id) => {
    try {
      await window.api.recording.remove(id)
      const { current } = get()
      if (current?.meeting.id === id) {
        set({ current: null })
      }
      await get().fetchMeetings()
    } catch (err) {
      console.error('[recordingStore] removeMeeting error:', err)
    }
  },

  updateSpeaker: async (speakerId, input) => {
    try {
      await window.api.recording.updateSpeaker(speakerId, input)
      await get().refreshCurrent()
    } catch (err) {
      console.error('[recordingStore] updateSpeaker error:', err)
    }
  },

  reassignSegment: async (segmentId, speakerId) => {
    try {
      await window.api.recording.reassignSegment(segmentId, speakerId)
      await get().refreshCurrent()
    } catch (err) {
      console.error('[recordingStore] reassignSegment error:', err)
    }
  },

  updateSegmentText: async (segmentId, text) => {
    try {
      await window.api.recording.updateSegmentText(segmentId, text)
      await get().refreshCurrent()
    } catch (err) {
      console.error('[recordingStore] updateSegmentText error:', err)
    }
  },

  addSpeaker: async (meetingId, name) => {
    try {
      const result = await window.api.recording.addSpeaker(meetingId, name)
      await get().refreshCurrent()
      return result.success && result.id != null ? result.id : null
    } catch (err) {
      console.error('[recordingStore] addSpeaker error:', err)
      return null
    }
  },

  mergeSpeakers: async (meetingId, fromSpeakerId, intoSpeakerId) => {
    try {
      await window.api.recording.mergeSpeakers(meetingId, fromSpeakerId, intoSpeakerId)
      await get().refreshCurrent()
    } catch (err) {
      console.error('[recordingStore] mergeSpeakers error:', err)
    }
  },

  toggleCut: async (cutId, enabled) => {
    try {
      await window.api.recording.toggleCut(cutId, enabled)
      await get().refreshCurrent()
    } catch (err) {
      console.error('[recordingStore] toggleCut error:', err)
    }
  },

  actionItemToTodo: async (meetingId, index) => {
    try {
      await window.api.recording.actionItemToTodo(meetingId, index)
      await get().refreshCurrent()
    } catch (err) {
      console.error('[recordingStore] actionItemToTodo error:', err)
    }
  },

  linkProject: async (id, projectId) => {
    try {
      await window.api.recording.linkProject(id, projectId)
      await get().refreshCurrent()
      await get().fetchMeetings()
    } catch (err) {
      console.error('[recordingStore] linkProject error:', err)
    }
  },

  subscribeStream: () => {
    const unsubscribe = window.api.recording.onStream((e: RecordingStreamEvent) => {
      const { current } = get()

      // 완료/실패 시 해당 회의 슬롯만 제거 (다른 회의의 진행률은 보존)
      if (e.phase === 'done' || e.phase === 'error') {
        set((state) => {
          if (!(e.meetingId in state.processing)) return state
          const next = { ...state.processing }
          delete next[e.meetingId]
          return { processing: next }
        })
        if (current?.meeting.id === e.meetingId) {
          get().refreshCurrent()
        }
        get().fetchMeetings()
        return
      }

      // 해당 회의 슬롯만 갱신
      set((state) => ({
        processing: {
          ...state.processing,
          [e.meetingId]: {
            meetingId: e.meetingId,
            phase: e.phase,
            progress: e.progress,
            message: e.message
          }
        }
      }))

      // 진행 중인 회의가 현재 열려있으면 현재 상태도 갱신
      if (current?.meeting.id === e.meetingId) {
        get().refreshCurrent()
      }
    })

    return unsubscribe
  }
}))

