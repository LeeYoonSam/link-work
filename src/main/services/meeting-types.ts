// 회의 녹음 — main 프로세스 공유 타입 (SSOT: docs/MEETING_RECORDING.md)
// renderer의 types/index.ts와 형태를 일치시키되, main은 renderer 타입을 import하지 않는
// 기존 컨벤션(ai-agent.ts)을 따라 여기에 독립 정의한다.

export interface RecordingStreamEvent {
  meetingId: number
  phase: 'transcribe' | 'diarize' | 'vad' | 'merge' | 'summarize' | 'done' | 'error'
  progress?: number
  message?: string
  error?: string
}

export type SendStream = (e: RecordingStreamEvent) => void

// ── STT (음성→텍스트) 어댑터 ──
export interface SttSegment {
  start_ms: number
  end_ms: number
  text: string
  confidence?: number
}
export interface SttAdapter {
  readonly name: string
  isAvailable(): Promise<boolean>
  transcribe(
    audioPath: string,
    opts: {
      language: string
      onProgress?: (p: number) => void
      // 모델 다운로드 등 단계 안내를 UI에 노출 (옵셔널)
      onMessage?: (m: string) => void
    }
  ): Promise<SttSegment[]>
}

// ── 화자 분리 (Diarization) 어댑터 ──
export interface DiarTurn {
  start_ms: number
  end_ms: number
  speaker_key: string
}
export interface DiarizationAdapter {
  readonly name: string
  isAvailable(): Promise<boolean>
  diarize(
    audioPath: string,
    opts: { minSpeakers?: number; maxSpeakers?: number; source?: string }
  ): Promise<DiarTurn[]>
}

// ── VAD (침묵 검출) 어댑터 ──
export interface VadRegion {
  start_ms: number
  end_ms: number
  kind: 'silence'
}
export interface VadAdapter {
  readonly name: string
  detectSilence(audioPath: string, opts?: { minSilenceMs?: number }): Promise<VadRegion[]>
}

// AI 요약 5분류 (meeting_summaries에 JSON 직렬화되어 저장)
export interface SummaryActionItem {
  text: string
  assignee?: string | null
  due?: string | null
}
export interface MeetingSummaryResult {
  tldr: string
  key_points: string[]
  decisions: string[]
  action_items: SummaryActionItem[]
  next_steps: string[]
}
