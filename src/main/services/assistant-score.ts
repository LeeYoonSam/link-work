// 우선순위 점수 (docs/ASSISTANT.md §5.1). 순수 모듈이다 (A3·A14).
import type { Candidate, CandidateSource, ScoredCandidate } from './assistant-types'

const DAY_MS = 24 * 60 * 60 * 1000
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/

/** 'YYYY-MM-DD…' 를 UTC 기준 일 번호로 바꾼다. 형식이 아니면 null. */
export function dayNumber(date: string | null | undefined): number | null {
  if (!date) return null
  const m = DATE_RE.exec(date)
  if (!m) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(ms) ? null : Math.round(ms / DAY_MS)
}

function dueScore(dueDate: string | null, today: number | null): number {
  const due = dayNumber(dueDate)
  if (due === null || today === null) return 0
  const diff = due - today
  if (diff < 0) return 100 + Math.min(-diff, 7) * 5
  if (diff === 0) return 90
  if (diff === 1) return 70
  if (diff <= 3) return 50
  if (diff <= 7) return 30
  return 0
}

/** §5.1 표의 정수 합산. */
export function scoreCandidate(c: Candidate, today: string): number {
  const todayNo = dayNumber(today)
  let score = dueScore(c.dueDate, todayNo)
  if (c.inProgress) score += 25
  if (c.priority === 'high') score += 20
  else if (c.priority === 'medium') score += 10
  if (c.source === 'action_item') score += 5
  const touched = dayNumber(c.lastTouchedAt)
  if (touched !== null && todayNo !== null && todayNo - touched >= 14) score -= 5
  return score
}

export const SOURCE_ORDER: Record<CandidateSource, number> = {
  jira: 0,
  task: 1,
  todo: 2,
  action_item: 3,
  manual: 4 // 'manual' 임시 항목은 출처 순서의 마지막이다 (부록 G.6.1)
}

/** 마감 오름차순. null 은 뒤로 간다. */
export function compareDue(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? -1 : 1
}

export function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 점수 내림차순 → 마감 오름차순 → 출처 순서 → id 오름차순. */
export function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.score !== b.score) return b.score - a.score
  const due = compareDue(a.candidate.dueDate, b.candidate.dueDate)
  if (due !== 0) return due
  const src = SOURCE_ORDER[a.candidate.source] - SOURCE_ORDER[b.candidate.source]
  if (src !== 0) return src
  return compareId(a.candidate.id, b.candidate.id)
}

/** 점수를 매겨 정렬한 새 배열을 돌려준다. 입력을 바꾸지 않는다. */
export function rankCandidates(list: Candidate[], today: string): ScoredCandidate[] {
  return list
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, today) }))
    .sort(compareCandidates)
}
