import { create } from 'zustand'
import type {
  Meeting,
  MeetingDetail,
  MeetingKind,
  MeetingTemplateId,
  ReassignResult,
  ReassignScope,
  RecordingStreamEvent,
  SpeakerVoiceResult
} from '../types'
import { blobToWav16kMono } from '../utils/audio'
import { mergeProcessingEvent } from '../utils/processing-progress'
import type { ProcessingState } from '../utils/processing-progress'

// 진행 상태의 형태와 이벤트 병합 규칙은 utils/processing-progress.ts가 갖는다.
// 화면들이 스토어를 통해 그대로 쓸 수 있도록 다시 내보낸다.

// 목소리 등록·확인·거절 결과. ok=false면 실패, message는 사용자에게 보여줄 안내(없으면 null)
export interface VoiceActionOutcome {
  ok: boolean
  message: string | null
}

export type VoiceAction = 'enroll' | 'confirm' | 'reject'

const VOICE_FAIL: Record<VoiceAction, string> = {
  enroll: '목소리 등록 실패',
  confirm: '목소리 지정 실패',
  reject: '목소리 지정 해제 실패'
}

// IPC 반환을 사용자 안내로 바꾼다. result=null은 호출 자체가 throw한 경우.
// 등록·확정이 성공했어도 enrolled===false면 발화가 짧아 표본을 저장하지 않은 것이다.
export function voiceActionOutcome(
  action: VoiceAction,
  result: SpeakerVoiceResult | null
): VoiceActionOutcome {
  if (!result || !result.success) {
    return { ok: false, message: result?.error?.trim() || VOICE_FAIL[action] }
  }
  if (action !== 'reject' && result.enrolled === false) {
    return { ok: true, message: '발화가 짧아 목소리는 등록하지 않았습니다.' }
  }
  return { ok: true, message: null }
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
  // 취소 요청을 보낸 회의 (meetingId → true). 취소 버튼 중복 클릭을 막고
  // 버튼을 "취소 중…"으로 표시한다. phase:'cancelled' 수신 시 해제된다.
  cancelling: Record<number, boolean>
  // 다른 메뉴에 다녀와도 보고 있던 필터가 유지되도록 전역 상태로 둔다
  // (RecordingView는 메뉴 전환 시 언마운트된다).
  kindFilter: KindFilter
  setKindFilter: (f: KindFilter) => void
  // 다른 화면(회의록 등)에서 "이 시점부터 듣기"를 눌렀을 때 상세 화면이 열리며 소비할 재생 위치(#13).
  pendingSeek: { meetingId: number; ms: number } | null
  setPendingSeek: (v: { meetingId: number; ms: number } | null) => void
  // 같은 회의면 ms를 돌려주고 비운다. 다른 회의면 null(예약은 그대로 둔다).
  consumePendingSeek: (meetingId: number) => number | null

  // 목록/상세
  fetchMeetings: () => Promise<void>
  openMeeting: (id: number) => Promise<void>
  closeMeeting: () => void
  refreshCurrent: () => Promise<void>

  // 녹음 완료 → 저장+처리+요약 (세션 오케스트레이션은 recorderSession.ts)
  createDraft: (input: {
    title?: string
    source: 'mic' | 'mic+system'
    kind?: MeetingKind
    // 참석 인원(화자분리 클러스터 수). 미지정 시 면접=2, 회의=자동 추정.
    expected_speakers?: number | null
    // 참석자로 지정할 구성원 id. 전사 힌트·화자 이름 프리셋·요약 참석자에 쓰인다.
    attendee_ids?: number[]
    // 처리 전 긴 침묵을 잘라낼지 여부(기본 true)
    compact_audio?: boolean
    // 요약 형식. null이면 제목으로 자동 판별
    summary_template?: MeetingTemplateId | null
  }) => Promise<number>
  // 녹음 오디오 저장 — 실패하면 throw한다(호출자가 blob을 보존해 재시도할 수 있게).
  saveRecording: (meetingId: number, blob: Blob, durationMs: number, mime: string) => Promise<void>
  // 저장된 녹음의 전사+화자분리 → 요약. 수 분 걸리므로 백그라운드로 호출하며 에러는 삼킨다.
  processAndSummarize: (meetingId: number) => Promise<void>
  // 시작 실패·취소된 draft 행 삭제(오디오 없는 'recording' 행만 main이 지운다)
  discardDraft: (id: number) => Promise<void>
  summarizeMeeting: (id: number) => Promise<void>
  reprocessMeeting: (id: number, fast?: boolean) => Promise<void>
  // 진행 중인 처리(전사/화자분리/요약)를 취소한다
  cancelProcessing: (meetingId: number) => Promise<void>

  // 편집/연계
  renameMeeting: (id: number, title: string) => Promise<void>
  removeMeeting: (id: number) => Promise<void>
  updateSpeaker: (
    speakerId: number,
    input: { display_name?: string | null; color?: string; label?: string }
  ) => Promise<void>
  // 목소리 등록·자동 지정 확인/거절. throw하지 않고 결과와 안내 문구를 돌려준다
  enrollSpeakerVoice: (speakerId: number) => Promise<VoiceActionOutcome>
  confirmSpeakerMatch: (speakerId: number) => Promise<VoiceActionOutcome>
  rejectSpeakerMatch: (speakerId: number) => Promise<VoiceActionOutcome>
  // 발언 화자 교정. 결과를 돌려주고 새로고침은 호출측이 한다. 예외면 null
  reassignSegment: (
    segmentId: number,
    speakerId: number | null,
    scope?: ReassignScope
  ) => Promise<ReassignResult | null>
  updateSegmentText: (segmentId: number, text: string) => Promise<void>
  // 새 화자를 추가하고 id를 반환 (같은 이름이 있으면 기존 화자 id 재사용). 실패 시 null
  addSpeaker: (meetingId: number, name: string) => Promise<number | null>
  mergeSpeakers: (meetingId: number, fromSpeakerId: number, intoSpeakerId: number) => Promise<void>
  toggleCut: (cutId: number, enabled: boolean) => Promise<void>
  actionItemToTodo: (meetingId: number, index: number) => Promise<void>
  setExpectedSpeakers: (id: number, n: number | null) => Promise<void>
  // 회의 참석자(구성원 id 목록)를 통째로 교체한다
  setAttendees: (meetingId: number, memberIds: number[]) => Promise<void>
  // 요약 형식 저장(null=자동). 재요약은 summarizeMeeting으로 따로 부른다
  setSummaryTemplate: (meetingId: number, templateId: MeetingTemplateId | null) => Promise<boolean>
  // 메모·북마크(#11). 열려 있는 회의의 메모면 상세를 새로고침한다
  addMark: (input: {
    meetingId: number
    raw_ms: number
    text?: string
    origin?: 'live' | 'post'
  }) => Promise<number | null>
  updateMark: (input: { id: number; text: string }) => Promise<boolean>
  deleteMark: (id: number) => Promise<boolean>

  // 처리 진행률 스트림 구독
  subscribeStream: () => () => void
}

export const useRecordingStore = create<RecordingStore>((set, get) => ({
  meetings: [],
  current: null,
  loading: false,
  processing: {},
  cancelling: {},
  kindFilter: 'all',
  pendingSeek: null,

  setKindFilter: (f) => set({ kindFilter: f }),

  setPendingSeek: (v) => set({ pendingSeek: v }),

  consumePendingSeek: (meetingId) => {
    const p = get().pendingSeek
    if (!p || p.meetingId !== meetingId) return null
    set({ pendingSeek: null })
    return p.ms
  },

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
      kind: input.kind,
      expected_speakers: input.expected_speakers,
      attendee_ids: input.attendee_ids,
      compact_audio: input.compact_audio,
      summary_template: input.summary_template
    })
    await get().fetchMeetings()
    return result.id
  },

  saveRecording: async (meetingId, blob, durationMs, mime) => {
    // 오디오 저장 — whisper 입력 포맷(16kHz mono WAV)으로 변환해 저장한다.
    // WAV는 duration 메타데이터도 갖춰 재생 표시가 정확하다.
    // 변환 실패 시 원본(webm)을 저장하고 폴백 전사로 진행한다.
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
    await get().fetchMeetings()
    await get().refreshCurrent()
  },

  processAndSummarize: async (meetingId) => {
    try {
      // 1) 전사+화자분리+VAD 파이프라인
      // process IPC는 반드시 첫 await 전에 보낸다 — recorderSession.stopAndSave 순서 주의 참고.
      const processResult = await window.api.recording.process(meetingId)
      await get().refreshCurrent()

      if (!processResult.success) {
        console.error('[recordingStore] process failed:', processResult.error)
        return
      }

      // 2) AI 요약 — 실제 전사가 있을 때만 자동 실행.
      // 폴백 전사(엔진 미설치/빈 전사)면 불필요한 Claude 호출을 건너뛴다.
      if (processResult.transcribed) {
        await get().summarizeMeeting(meetingId)
      }
    } catch (err) {
      console.error('[recordingStore] processAndSummarize error:', err)
      await get().refreshCurrent()
    }
  },

  discardDraft: async (id) => {
    try {
      const result = await window.api.recording.discardDraft(id)
      if (!result.success) console.warn('[recordingStore] discardDraft skipped:', id)
    } catch (err) {
      console.error('[recordingStore] discardDraft error:', err)
    }
    await get().fetchMeetings()
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

  cancelProcessing: async (meetingId) => {
    // 취소 대기 표시(버튼 비활성 + "취소 중…"). 실제 상태 정리는 아래 분기 또는
    // phase:'cancelled' 스트림 이벤트가 담당한다.
    set((state) => ({ cancelling: { ...state.cancelling, [meetingId]: true } }))
    const clearCancelling = (): void =>
      set((state) => {
        if (!(meetingId in state.cancelling)) return state
        const next = { ...state.cancelling }
        delete next[meetingId]
        return { cancelling: next }
      })
    try {
      const result = await window.api.recording.cancel(meetingId)
      // 취소할 활성 파이프라인이 없었으면(success:false) 'cancelled' 스트림이 오지 않으므로
      // 여기서 즉시 대기 표시를 해제한다. 성공 시엔 스트림 수신에서 정리된다.
      if (!result.success) clearCancelling()
    } catch (err) {
      console.error('[recordingStore] cancelProcessing error:', err)
      clearCancelling()
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

  setAttendees: async (meetingId, memberIds) => {
    try {
      await window.api.recording.setAttendees(meetingId, memberIds)
      await get().refreshCurrent()
    } catch (err) {
      console.error('[recordingStore] setAttendees error:', err)
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

  enrollSpeakerVoice: async (speakerId) => {
    try {
      const r = await window.api.recording.enrollSpeakerVoice(speakerId)
      await get().refreshCurrent()
      return voiceActionOutcome('enroll', r)
    } catch (err) {
      console.error('[recordingStore] enrollSpeakerVoice error:', err)
      return voiceActionOutcome('enroll', null)
    }
  },

  confirmSpeakerMatch: async (speakerId) => {
    try {
      const r = await window.api.recording.confirmSpeakerMatch(speakerId)
      await get().refreshCurrent()
      return voiceActionOutcome('confirm', r)
    } catch (err) {
      console.error('[recordingStore] confirmSpeakerMatch error:', err)
      return voiceActionOutcome('confirm', null)
    }
  },

  rejectSpeakerMatch: async (speakerId) => {
    try {
      const r = await window.api.recording.rejectSpeakerMatch(speakerId)
      await get().refreshCurrent()
      return voiceActionOutcome('reject', r)
    } catch (err) {
      console.error('[recordingStore] rejectSpeakerMatch error:', err)
      return voiceActionOutcome('reject', null)
    }
  },

  reassignSegment: async (segmentId, speakerId, scope = 'one') => {
    try {
      return await window.api.recording.reassignSegment(segmentId, speakerId, scope)
    } catch (err) {
      console.error('[recordingStore] reassignSegment error:', err)
      return null
    }
  },

  setSummaryTemplate: async (meetingId, templateId) => {
    try {
      const r = await window.api.recording.setSummaryTemplate(meetingId, templateId)
      if (!r.success) {
        console.error('[recordingStore] setSummaryTemplate failed:', r.error)
        return false
      }
      await get().refreshCurrent()
      return true
    } catch (err) {
      console.error('[recordingStore] setSummaryTemplate error:', err)
      return false
    }
  },

  addMark: async (input) => {
    try {
      const r = await window.api.recording.addMark(input)
      if (get().current?.meeting.id === input.meetingId) await get().refreshCurrent()
      return r.id
    } catch (err) {
      console.error('[recordingStore] addMark error:', err)
      return null
    }
  },

  updateMark: async (input) => {
    try {
      const r = await window.api.recording.updateMark(input)
      if (get().current?.marks?.some((m) => m.id === input.id)) await get().refreshCurrent()
      return r.success
    } catch (err) {
      console.error('[recordingStore] updateMark error:', err)
      return false
    }
  },

  deleteMark: async (id) => {
    try {
      const r = await window.api.recording.deleteMark(id)
      if (get().current?.marks?.some((m) => m.id === id)) await get().refreshCurrent()
      return r.success
    } catch (err) {
      console.error('[recordingStore] deleteMark error:', err)
      return false
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

  subscribeStream: () => {
    const unsubscribe = window.api.recording.onStream((e: RecordingStreamEvent) => {
      const { current } = get()

      // 완료/실패/취소 시 해당 회의의 진행률·취소대기 슬롯만 제거 (다른 회의 진행률은 보존)
      if (e.phase === 'done' || e.phase === 'error' || e.phase === 'cancelled') {
        set((state) => {
          const inProcessing = e.meetingId in state.processing
          const inCancelling = e.meetingId in state.cancelling
          if (!inProcessing && !inCancelling) return state
          const nextProcessing = { ...state.processing }
          const nextCancelling = { ...state.cancelling }
          delete nextProcessing[e.meetingId]
          delete nextCancelling[e.meetingId]
          return { processing: nextProcessing, cancelling: nextCancelling }
        })
        if (current?.meeting.id === e.meetingId) {
          get().refreshCurrent()
        }
        get().fetchMeetings()
        return
      }

      // 해당 회의 슬롯만 갱신.
      // 이벤트를 통째로 덮지 않고 직전 상태에 합친다 — 진행률 없는 메시지 전용 이벤트가
      // 진행 바를 0%로 되돌리지 않게 하기 위해서다(mergeProcessingEvent 주석 참고).
      const now = Date.now()
      set((state) => ({
        processing: {
          ...state.processing,
          [e.meetingId]: mergeProcessingEvent(state.processing[e.meetingId], e, now)
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

