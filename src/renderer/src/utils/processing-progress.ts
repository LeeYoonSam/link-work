import type { RecordingStreamEvent } from '../types'

// 회의 처리 파이프라인의 진행률 계산.
//
// 파이프라인은 단계별로 0~1 진행률을 따로 보낸다. 그것만 그대로 보여주면 "전사 100%"
// 다음에 다시 0%로 떨어져 사용자는 전체가 얼마나 남았는지 알 수 없다. 여기서 단계별
// 진행률을 하나의 전체 진행률로 합친다.

// 단계 순서와 각 단계가 전체에서 차지하는 몫. 합은 1.0.
// 몫은 97분 녹음 실측 기준의 체감 소요 시간 비율이다 — 전사가 압도적으로 길고,
// 화자 분리가 그다음이며, vad·merge는 거의 즉시 끝난다.
// compact는 파일 전체를 한 번에 검출하며(청크 분할 없음, nThreads 1) 실시간 약 224배라
// 97분 녹음이 약 26초에 끝난다. 그래서 0.10에서 0.04로 낮추고 그만큼을 전사·화자 분리로 돌렸다.
const PHASE_ORDER: { phase: string; weight: number }[] = [
  { phase: 'compact', weight: 0.04 },
  { phase: 'transcribe', weight: 0.6 },
  { phase: 'vad', weight: 0.01 },
  { phase: 'diarize', weight: 0.28 },
  { phase: 'merge', weight: 0.02 },
  // 요약은 process가 끝난 뒤 별도 IPC로 돌아 새 슬롯의 phase 'summarize'로 도착한다.
  // 그래서 전체 진행률이 0.95에서 이어붙는다 — 의도된 동작이다.
  { phase: 'summarize', weight: 0.05 }
]

export const PHASE_WEIGHTS: Record<string, number> = Object.fromEntries(
  PHASE_ORDER.map((p) => [p.phase, p.weight])
)

// 각 단계 앞에 놓인 가중치의 누적합. 순서 의존을 한곳에 가둔다.
const PHASE_OFFSET: Record<string, number> = (() => {
  const out: Record<string, number> = {}
  let acc = 0
  for (const { phase, weight } of PHASE_ORDER) {
    out[phase] = acc
    acc += weight
  }
  return out
})()

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

/**
 * 단계별 진행률을 전체 파이프라인 기준 0~1로 환산한다.
 * 알 수 없는 phase(취소·오류 등 가중치가 없는 단계)는 0 — 진행 바를 그릴 근거가 없다.
 */
export function overallProgress(phase: string, phaseProgress: number | undefined): number {
  if (phase === 'done') return 1
  const offset = PHASE_OFFSET[phase]
  if (offset === undefined) return 0
  return offset + PHASE_WEIGHTS[phase] * clamp01(phaseProgress ?? 0)
}

export interface ProcessingState {
  meetingId: number
  phase: string
  progress: number
  message?: string
  /** 이 회의의 처리가 처음 관측된 시각(ms). phase가 바뀌어도 유지된다. */
  startedAt: number
  /** 현재 phase가 시작된 시각(ms). phase가 바뀔 때만 갱신된다. */
  phaseStartedAt: number
  /** 전체 파이프라인 기준 진행률 0~1 */
  overall: number
}

/**
 * 스트림 이벤트 하나를 직전 진행 상태에 합친다.
 *
 * 파이프라인은 진행률 없이 메시지만 담은 이벤트(`{phase, message}`)를 자주 보낸다
 * (예: "발화 구간 검출 중…"). 그런 이벤트로 progress를 통째로 덮으면 undefined가 되어
 * 진행 바가 0%로 되돌아간다 — 실제로 97분 녹음에서 "무음 정리 0%"가 몇 분간 멈춘 것처럼
 * 보인 원인이다. 그래서 **같은 phase 안에서는** 빠진 필드를 직전 값으로 채운다.
 * phase가 바뀌면 그 단계는 새로 시작하는 것이므로 이벤트 값(없으면 0)에서 출발하고,
 * 직전 단계의 메시지도 들고 가지 않는다.
 */
export function mergeProcessingEvent(
  prev: ProcessingState | undefined,
  e: RecordingStreamEvent,
  now: number
): ProcessingState {
  const phaseChanged = prev == null || prev.phase !== e.phase
  const progress = e.progress ?? (phaseChanged ? 0 : prev.progress)
  const message = e.message ?? (phaseChanged ? undefined : prev.message)

  return {
    meetingId: e.meetingId,
    phase: e.phase,
    progress,
    message,
    startedAt: prev?.startedAt ?? now,
    phaseStartedAt: phaseChanged ? now : prev.phaseStartedAt,
    overall: overallProgress(e.phase, progress)
  }
}

/** 경과 시간을 `2:13` / `1:02:03` 꼴로. 진행 표시용이라 시:분:초까지만 쓴다. */
export function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
