// 회의 녹음 — main 프로세스 공유 타입 (SSOT: docs/MEETING_RECORDING.md)
// renderer의 types/index.ts와 형태를 일치시키되, main은 renderer 타입을 import하지 않는
// 기존 컨벤션(ai-agent.ts)을 따라 여기에 독립 정의한다.

export interface RecordingStreamEvent {
  meetingId: number
  // 'cancelled': 사용자가 처리를 취소해 이전 상태로 복원됨 (일반 'error'와 구분).
  phase: 'transcribe' | 'diarize' | 'vad' | 'merge' | 'summarize' | 'done' | 'error' | 'cancelled'
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
      // whisper initial_prompt로 전달되는 도메인 컨텍스트(회의 제목·참석자 등).
      // whisper는 마지막 224토큰만 반영하므로 그 이상은 잘린다.
      prompt?: string
      onProgress?: (p: number) => void
      // 모델 다운로드 등 단계 안내를 UI에 노출 (옵셔널)
      onMessage?: (m: string) => void
      // 취소 신호. 어댑터는 aborted 시 실행 중인 whisper 프로세스를 가능한 한 빨리 중단해야 한다.
      signal?: AbortSignal
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
      // 취소 신호. 어댑터는 aborted 시 실행 중인 sherpa 프로세스를 가능한 한 빨리 중단해야 한다.
      signal?: AbortSignal
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

// 녹음 종류 — 요약 스키마와 상세 UI가 이 값으로 갈린다 (meetings.kind)
export type MeetingKind = 'meeting' | 'interview'

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

// ── 면접 기록 (kind='interview') 전용 요약 구조 ──
// 설계 원칙: 합격/불합격 판단이나 점수를 생성하지 않는다. 지원자의 실제 발언을
// 질문 단위로 정리하고, 근거(인용)와 확인이 필요한 지점만 남긴다.
export interface InterviewQaPair {
  question: string
  answer_summary: string
  // 질문이 시작된 오디오 위치(ms). 파싱 실패 시 null → 재생 점프 버튼을 숨긴다.
  start_ms: number | null
  // 지원자 발언 원문 인용 (요약이 아닌 실제 문장)
  quote?: string | null
}
export interface InterviewCompetency {
  topic: string
  evidence: string[]
  note?: string | null
}
export interface InterviewSummaryResult {
  overview: string
  qa_pairs: InterviewQaPair[]
  competencies: InterviewCompetency[]
  follow_ups: string[]
  fact_checks: string[]
}
