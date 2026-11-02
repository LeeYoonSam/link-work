// 트레이 '오늘 계획' 요약. TodayPayload 의 순수 투영이다 (A27).
// electron·DB·네트워크 모듈을 import 하지 않는다 (A3).
import type { PlanItem, PlanItemStatus, TodayPayload, TrayAssistant } from './assistant-types'

export const TRAY_ITEM_LIMIT = 3

const ACTIVE: ReadonlySet<PlanItemStatus> = new Set<PlanItemStatus>(['planned', 'in_progress'])

// rank 오름차순. null 은 뒤로. 같으면 id 오름차순
function compareRank(a: PlanItem, b: PlanItem): number {
  if (a.rank !== b.rank) {
    if (a.rank === null) return 1
    if (b.rank === null) return -1
    return a.rank - b.rank
  }
  return a.id - b.id
}

// 'YYYY-MM-DD HH:mm:ss' → 'HH:mm'
function hhmmOf(localDateTime: string): string | null {
  const m = /(\d{2}:\d{2})/.exec(localDateTime.slice(10))
  return m ? m[1] : null
}

export function toTraySummary(payload: TodayPayload): TrayAssistant {
  const { plan, logicalDate } = payload
  if (!plan) {
    return {
      logicalDate,
      status: 'none',
      startedAt: null,
      items: [],
      activeCount: 0,
      doneCount: 0,
      suggestedCount: 0,
      urgentSuggestedCount: 0,
      freeMinutesLeft: 0
    }
  }

  const focusId = payload.timeline.focusItemId
  // filter 가 새 배열을 만들므로 sort 가 입력을 바꾸지 않는다 (A14)
  const active = payload.items.filter((i) => ACTIVE.has(i.status)).sort(compareRank)
  const suggested = payload.items.filter((i) => i.status === 'suggested')

  return {
    logicalDate,
    status: plan.status,
    startedAt: hhmmOf(plan.started_at),
    items: active.slice(0, TRAY_ITEM_LIMIT).map((i) => ({
      id: i.id,
      title: i.title,
      rank: i.rank,
      status: i.status,
      isFocus: focusId !== null && i.id === focusId
    })),
    activeCount: active.length,
    doneCount: payload.items.filter((i) => i.status === 'done').length,
    suggestedCount: suggested.length,
    urgentSuggestedCount: suggested.filter((i) => i.urgent).length,
    freeMinutesLeft: payload.timeline.freeMinutesLeft
  }
}
