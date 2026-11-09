import type { PlanItem, TimelineEntry, TodayPayload } from '../../types'
import { freeTimeLabel, isActiveItem, isDueAlert } from './PlanItemRow'
import { EMPHASIS, TILE_TONE } from './todayTokens'

// 요약 타일 1칸. sub 와 alert 가 모두 null 이면 보조 줄을 그리지 않는다.
// alert 는 보조 줄 끝에 빨간 글자로 붙는다 (부록 M.4 강조 2)
export interface SummaryTile {
  key: 'remaining' | 'done' | 'meeting' | 'free'
  label: string
  value: string
  sub: string | null
  alert?: string | null
}

// 활성 항목 중 마감이 오늘·지남이거나 긴급인 항목 수 (부록 M.5.7)
export function dueAlertCount(
  items: Pick<PlanItem, 'status' | 'due_date' | 'urgent'>[],
  logicalDate: string
): number {
  return items.filter((i) => isActiveItem(i) && isDueAlert(i, logicalDate)).length
}

type MeetingEntry = Extract<TimelineEntry, { kind: 'meeting' }>

// 시간표의 회의 중 끝나지 않은 첫 건을 고른다 (부록 L).
// entries 는 시작 시각 오름차순이다. 'HH:mm' 은 문자열 비교로 순서를 정한다
export function nextMeeting(entries: TimelineEntry[], nowHHmm: string): MeetingEntry | null {
  for (const e of entries) {
    if (e.kind === 'meeting' && e.end > nowHHmm) return e
  }
  return null
}

// 홈 맨 위 요약 타일 4개를 만든다 (부록 L). 데이터는 TodayPayload 만 쓴다
// logicalDate 가 없으면 마감 날짜를 비교하지 않고 긴급 항목만 센다
export function summaryTiles(
  today: Pick<TodayPayload, 'plan' | 'items' | 'timeline'> & { logicalDate?: string },
  nowHHmm: string
): SummaryTile[] {
  const count = (status: string): number => today.items.filter((i) => i.status === status).length
  // '오늘 할 일' 목록과 같은 기준이다. 제안·무시는 세지 않는다
  const total = today.items.filter((i) => i.status !== 'suggested' && i.status !== 'dismissed').length
  const remaining = count('planned') + count('in_progress')
  const deferred = count('deferred')
  const dropped = count('dropped')
  const doneSub = [deferred > 0 ? `미룸 ${deferred}` : '', dropped > 0 ? `제외 ${dropped}` : '']
    .filter(Boolean)
    .join(' · ')
  const meeting = nextMeeting(today.timeline?.entries ?? [], nowHHmm)
  const active = today.plan?.status === 'active'
  const dueAlerts = dueAlertCount(today.items, today.logicalDate ?? '')

  return [
    {
      key: 'remaining',
      label: '남은 할 일',
      value: `${remaining}건`,
      sub: `전체 ${total}건`,
      alert: dueAlerts > 0 ? `마감 ${dueAlerts}건` : null
    },
    { key: 'done', label: '완료', value: `${count('done')}건`, sub: doneSub || null },
    {
      key: 'meeting',
      label: '다음 회의',
      value: meeting ? meeting.start : '—',
      sub: meeting ? meeting.title : '남은 회의가 없어요'
    },
    {
      key: 'free',
      label: '집중 가능 시간',
      value: active && today.timeline ? freeTimeLabel(today.timeline.freeMinutesLeft) : '—',
      sub: null
    }
  ]
}

// 타일 카드들. 그리드와 id="today-summary" 는 TodayView 가 감싼다.
// 타일마다 TILE_TONE 의 색 1개를 쓴다 (부록 M.9 N4). 공용 Card 를 쓰지 않는다.
// 이유: Card 의 bg-white 가 타일 배경색과 겹친다
export default function SummaryTiles({ tiles }: { tiles: SummaryTile[] }): React.ReactNode {
  return (
    <>
      {tiles.map((t) => (
        <div key={t.key} data-tile={t.key} className={`rounded-lg border p-4 ${TILE_TONE[t.key].box}`}>
          <p className={`text-sm ${TILE_TONE[t.key].label}`}>{t.label}</p>
          <p className={`mt-1 text-2xl font-bold tabular-nums break-words ${TILE_TONE[t.key].value}`}>
            {t.value}
          </p>
          {t.sub || t.alert ? (
            <p className="mt-1 text-sm text-gray-600 break-words">
              {t.sub && t.alert ? `${t.sub} · ` : t.sub}
              {t.alert ? <span className={EMPHASIS.urgentText}>{t.alert}</span> : null}
            </p>
          ) : null}
        </div>
      ))}
    </>
  )
}
