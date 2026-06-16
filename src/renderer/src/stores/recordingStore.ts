import { create } from 'zustand'
import type {
  Meeting,
  MeetingDetail,
  RecordingStreamEvent
} from '../types'
import { blobToWav16kMono } from '../utils/audio'

interface ProcessingState {
  meetingId: number
  phase: string
  progress?: number
  message?: string
}

interface RecordingStore {
  meetings: Meeting[]
  current: MeetingDetail | null
  loading: boolean
  processing: ProcessingState | null

  // 목록/상세
  fetchMeetings: () => Promise<void>
  openMeeting: (id: number) => Promise<void>
  closeMeeting: () => void
  refreshCurrent: () => Promise<void>

  // 녹음 완료 → 저장+처리+요약 오케스트레이션
  createDraft: (input: { title?: string; source: 'mic' | 'mic+system' }) => Promise<number>
  saveAndProcess: (meetingId: number, blob: Blob, durationMs: number, mime: string) => Promise<void>
  summarizeMeeting: (id: number) => Promise<void>
  reprocessMeeting: (id: number) => Promise<void>

  // 편집/연계
  renameMeeting: (id: number, title: string) => Promise<void>
  removeMeeting: (id: number) => Promise<void>
  updateSpeaker: (
    speakerId: number,
    input: { display_name?: string | null; color?: string; label?: string }
  ) => Promise<void>
  reassignSegment: (segmentId: number, speakerId: number | null) => Promise<void>
  mergeSpeakers: (meetingId: number, fromSpeakerId: number, intoSpeakerId: number) => Promise<void>
  toggleCut: (cutId: number, enabled: boolean) => Promise<void>
  actionItemToTodo: (meetingId: number, index: number) => Promise<void>
  linkProject: (id: number, projectId: number | null) => Promise<void>

  // 처리 진행률 스트림 구독
  subscribeStream: () => () => void
}

export const useRecordingStore = create<RecordingStore>((set, get) => ({
  meetings: [],
  current: null,
  loading: false,
  processing: null,

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
      source: input.source
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

  reprocessMeeting: async (id) => {
    try {
      const processResult = await window.api.recording.process(id)
      await get().refreshCurrent()
      if (processResult.success && processResult.transcribed) {
        await get().summarizeMeeting(id)
      }
    } catch (err) {
      console.error('[recordingStore] reprocessMeeting error:', err)
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

      if (e.phase === 'done') {
        set({ processing: null })
        if (current?.meeting.id === e.meetingId) {
          get().refreshCurrent()
        }
        get().fetchMeetings()
        return
      }

      if (e.phase === 'error') {
        set({ processing: null })
        if (current?.meeting.id === e.meetingId) {
          get().refreshCurrent()
        }
        get().fetchMeetings()
        return
      }

      set({
        processing: {
          meetingId: e.meetingId,
          phase: e.phase,
          progress: e.progress,
          message: e.message
        }
      })

      // 진행 중인 회의가 현재 열려있으면 현재 상태도 갱신
      if (current?.meeting.id === e.meetingId) {
        get().refreshCurrent()
      }
    })

    return unsubscribe
  }
}))

