import type { TimelineEntry, TodayPayload } from '../../types'
import { Card } from '../ui'
import { freeTimeLabel } from './PlanItemRow'

// 요약 타일 1칸. sub 가 null 이면 보조 줄을 그리지 않는다
export interface SummaryTile {
  key: 'remaining' | 'done' | 'meeting' | 'free'
  label: string
  value: string
  sub: string | null
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
export function summaryTiles(
  today: Pick<TodayPayload, 'plan' | 'items' | 'timeline'>,
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

  return [
    { key: 'remaining', label: '남은 할 일', value: `${remaining}건`, sub: `전체 ${total}건` },
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

// 타일 카드들. 그리드와 id="today-summary" 는 TodayView 가 감싼다
export default function SummaryTiles({ tiles }: { tiles: SummaryTile[] }): React.ReactNode {
  return (
    <>
      {tiles.map((t) => (
        <Card key={t.key} padding="sm">
          <p className="text-sm text-gray-500">{t.label}</p>
          <p className="mt-1 text-2xl font-bold text-gray-900 tabular-nums break-words">
            {t.value}
          </p>
          {t.sub ? (
            <p className="mt-1 text-sm text-gray-500 break-words">
              {t.sub}
            </p>
          ) : null}
        </Card>
      ))}
    </>
  )
}
