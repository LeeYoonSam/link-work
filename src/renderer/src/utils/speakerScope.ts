// 발언 화자 교정 범위 계산. 순수 모듈이다.
// main services/speaker-correction.ts 의 planReassign 과 같은 규칙이다.
import type { ReassignScope } from '../types'

export type { ReassignScope }

export const SCOPE_LABELS: Record<ReassignScope, string> = {
  one: '이 구간만',
  forward: '이 구간부터',
  all: '전체'
}

interface ScopeSegment {
  id: number
  start_ms: number
  sort_order: number
  speaker_id: number | null
}

function compareSegments(a: ScopeSegment, b: ScopeSegment): number {
  return a.start_ms - b.start_ms || a.sort_order - b.sort_order || a.id - b.id
}

/** 범위에 들어가는 세그먼트 id 를 (start_ms, sort_order, id) 순으로 돌려준다. 기준이 없으면 []. */
export function planReassignIds(
  segments: ScopeSegment[],
  segmentId: number,
  scope: ReassignScope
): number[] {
  const sorted = [...segments].sort(compareSegments)
  const index = sorted.findIndex((s) => s.id === segmentId)
  if (index < 0) return []
  if (scope === 'one') return [segmentId]
  const speaker = sorted[index].speaker_id ?? null
  const from = scope === 'forward' ? index : 0
  return sorted
    .slice(from)
    .filter((s) => (s.speaker_id ?? null) === speaker)
    .map((s) => s.id)
}
