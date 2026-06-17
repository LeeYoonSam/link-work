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
    opts: {
      minSpeakers?: number
      maxSpeakers?: number
      // 정확한 참석자 수를 알 때 지정 (sherpa clustering numClusters로 직접 사용). 미지정 시 자동 추정.
      numSpeakers?: number
      source?: string
      // 채널 기반 어댑터가 STT segment 경계로 화자를 귀속할 때 사용 (다른 어댑터는 무시)
      segments?: SttSegment[]
    }
  ): Promise<DiarTurn[]>
}

// 채널 에너지 envelope — mic=L/system=R 스테레오를 모델 없이 2화자로 분리하기 위한 데이터.
// renderer가 webm 디코딩 시 hopMs 간격으로 L/R RMS(0~1)를 계산해 저장한다.
export interface ChannelEnergy {
  hopMs: number
  left: number[] // mic 채널 RMS
  right: number[] // system 채널 RMS
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
