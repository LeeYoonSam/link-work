// 오늘 대시보드의 '일정' 카드 (docs/ASSISTANT.md 부록 O).
// 종일 칩, 시간 일정 행(지난 일정 흐림), '지금 HH:mm' 선, 회의 전 브리핑 인라인 펼침, 내일 1줄.
// 브리핑 짝짓기는 payload.meeting.id === CalendarEvent.id(ScheduleRow.id) 다.
import { Fragment, useEffect, useState } from 'react'
import type { ScheduleRow, TodayDashboard } from './todayModel'
import { Card, ChevronDownIcon } from '../ui'
import {
  MeetingBriefingBody,
  briefingsByMeetingId,
  nearestUpcomingEventId,
  type MeetingBriefingRow
} from './MeetingBriefingCard'
import { CARD_HEAD, DIMMED, MORE_LINK } from './todayTokens'

const pad = (n: number): string => String(n).padStart(2, '0')

/** 로컬 'YYYY-MM-DD HH:mm:ss'. 회의 브리핑 payload 의 시각 형식과 같다 */
export function localStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 로컬 'HH:mm' */
export function localClock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 오늘 일정 행과 짝이 맞는 브리핑만 고른다. 행에 없는 회의의 브리핑은 대시보드에 보이지 않는다 */
export function matchBriefings(rows: ScheduleRow[], briefings: MeetingBriefingRow[]): Map<string, MeetingBriefingRow> {
  const byId = briefingsByMeetingId(briefings)
  const out = new Map<string, MeetingBriefingRow>()
  for (const r of rows) {
    const b = byId.get(r.id)
    if (b) out.set(r.id, b)
  }
  return out
}

/** 기본으로 펼칠 브리핑 1건. 아직 시작 안 한 가장 가까운 회의 중 브리핑이 있는 것이다 */
export function defaultOpenBriefingId(matched: Map<string, MeetingBriefingRow>, now: Date): number | null {
  return nearestUpcomingEventId([...matched.values()], localStamp(now))
}

// 브리핑 본문 글자. 'keep-all' 로 '목/표' 처럼 낱말 중간에서 끊기지 않게 한다
export const BRIEFING_BODY_TEXT = [
  'break-keep [overflow-wrap:anywhere] text-pretty',
  '[&_p]:text-[13px] [&_li]:text-[13px] [&_p]:leading-snug [&_li]:leading-snug',
  '[&_ul]:pl-4 [&_ol]:pl-4 [&_*]:break-keep'
].join(' ')

/** 기본 캘린더가 아닌 일정인가. calendarId 가 없거나 'primary' 면 기본이다 */
export function isOtherCalendar(calendarId: string | null | undefined): boolean {
  return !!calendarId && calendarId !== 'primary'
}

/**
 * 실제로 펼친 브리핑 id. 사용자가 한 번도 접거나 펼치지 않았으면 기본 1건(매 렌더 다시 계산)과
 * 알림 클릭으로 받은 id 다. 한 번이라도 직접 바꿨으면 그 뒤로는 사용자가 정한 집합(manual)을 따른다
 */
export function effectiveOpenIds(
  manual: Set<number> | null,
  defaultId: number | null,
  forceId: number | null
): Set<number> {
  if (manual) return manual
  const ids = new Set<number>()
  if (defaultId !== null) ids.add(defaultId)
  if (forceId !== null) ids.add(forceId)
  return ids
}

function ScheduleItem({
  row,
  briefing,
  open,
  onToggle,
  regenerating,
  canRegenerate,
  onRegenerate
}: {
  row: ScheduleRow
  briefing: MeetingBriefingRow | undefined
  open: boolean
  onToggle: (eventId: number) => void
  regenerating: boolean
  canRegenerate: boolean
  onRegenerate: (eventId: number) => void
}): React.ReactNode {
  const past = row.timing === 'past'
  const current = row.timing === 'current'
  // ScheduleRow.calendarId (impl-b 모델). 다른 캘린더 일정은 그대로 보이되 작은 꼬리표로 구분한다
  const calendarId = row.calendarId
  const other = isOtherCalendar(calendarId)
  return (
    <li id={`schedule-row-${row.id}`} data-timing={row.timing} className="scroll-mt-4">
      <div
        id={briefing ? `meeting-briefing-${briefing.event.id}` : undefined}
        className={`grid grid-cols-[3rem_0.1875rem_minmax(0,1fr)] gap-x-2.5 px-4 py-2 scroll-mt-4 ${past ? DIMMED : ''}`}
      >
        <span className="pt-px text-right text-sm text-gray-600 tabular-nums">
          {row.start}
          <span className="block text-[11px] text-gray-400">{row.end}</span>
        </span>
        <span
          aria-hidden
          className={`rounded-full ${current ? 'bg-purple-500' : past ? 'bg-gray-200' : 'bg-purple-200'}`}
        />
        <div className="min-w-0">
          <div className="flex min-w-0 items-start gap-2">
            <span className={`min-w-0 flex-1 break-words text-sm ${current ? 'font-semibold text-gray-900' : 'text-gray-800'}`}>
              {row.title}
              {current ? <span className="ml-1.5 text-xs font-medium text-purple-700">진행 중</span> : null}
              {other ? (
                <span
                  data-other-calendar
                  title={`다른 캘린더: ${calendarId}`}
                  className="ml-1.5 inline-flex items-center gap-1 align-middle text-[11px] text-gray-500"
                >
                  <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full border border-gray-500" />
                  다른 캘린더
                </span>
              ) : null}
            </span>
            {briefing ? (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`meeting-briefing-body-${briefing.event.id}`}
                onClick={() => onToggle(briefing.event.id)}
                className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium text-purple-700 hover:bg-purple-50"
              >
                브리핑
                <ChevronDownIcon size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
            ) : null}
          </div>
          {row.location ? <p className="mt-0.5 break-words text-xs text-gray-500">{row.location}</p> : null}
        </div>
      </div>
      {briefing && open ? (
        <div
          id={`meeting-briefing-body-${briefing.event.id}`}
          // 좁은 열에서도 읽히게: 들여쓰기 없이 열 폭을 다 쓰고, 글자를 한 단계 줄이며 낱말 단위로 줄바꿈한다
          className={`mx-3 mb-2 rounded-md border border-purple-100 bg-purple-50/40 px-2.5 py-2 ${BRIEFING_BODY_TEXT}`}
        >
          <MeetingBriefingBody
            row={briefing}
            regenerating={regenerating}
            canRegenerate={canRegenerate}
            onRegenerate={onRegenerate}
          />
        </div>
      ) : null}
    </li>
  )
}

export default function ScheduleCard({
  schedule,
  now,
  briefings,
  regeneratingIds,
  canRegenerate,
  onRegenerate,
  forceOpenEventId,
  onOpenCalendar,
  onOpenSettings
}: {
  schedule: TodayDashboard['schedule']
  now: Date
  // meetingBriefings(today.events) 결과
  briefings: MeetingBriefingRow[]
  regeneratingIds: number[]
  canRegenerate: boolean
  onRegenerate: (eventId: number) => void
  // 알림 클릭(focus 'meeting')으로 펼칠 브리핑 이벤트 id
  forceOpenEventId: number | null
  onOpenCalendar: () => void
  onOpenSettings: () => void
}): React.ReactNode {
  const matched = matchBriefings(schedule.rows, briefings)
  // null = 사용자가 아직 직접 접거나 펼치지 않음. 그동안은 기본 펼침을 매 렌더 다시 계산한다 —
  // 앱을 켠 직후(브리핑이 아직 없음)나 회의 직전에 새로 생긴 브리핑도 자동으로 펼쳐진다
  const [manual, setManual] = useState<Set<number> | null>(null)
  const open = effectiveOpenIds(manual, defaultOpenBriefingId(matched, now), forceOpenEventId)

  // 알림 클릭으로 열린 브리핑은 사용자가 바꾼 상태와 무관하게 펼친다
  useEffect(() => {
    if (forceOpenEventId === null) return
    setManual((prev) => (prev === null || prev.has(forceOpenEventId) ? prev : new Set(prev).add(forceOpenEventId)))
  }, [forceOpenEventId])

  const toggle = (id: number): void => {
    const next = new Set(open)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setManual(next)
  }

  const nowLine = (
    <li key="now-line" aria-label={`지금 ${localClock(now)}`} className="flex items-center gap-2 px-4 py-0.5" data-testid="now-line">
      <span className="w-12 text-right text-[11px] font-semibold text-blue-600 tabular-nums">지금 {localClock(now)}</span>
      <span aria-hidden className="h-px flex-1 bg-blue-400" />
    </li>
  )

  return (
    <Card padding="none" className="h-full">
      <section id="today-schedule" aria-labelledby="today-schedule-title">
        <div className={CARD_HEAD}>
          <h3 id="today-schedule-title" className="text-sm font-semibold text-gray-700">
            일정
          </h3>
          {schedule.connected ? (
            <button type="button" onClick={onOpenCalendar} className={MORE_LINK}>
              캘린더 →
            </button>
          ) : null}
        </div>

        {!schedule.connected ? (
          <div className="px-4 pb-4 text-sm text-gray-400">
            <p>캘린더가 연결되지 않았어요.</p>
            <button type="button" onClick={onOpenSettings} className={`mt-1 ${MORE_LINK}`}>
              설정에서 연결하기 →
            </button>
          </div>
        ) : (
          <>
            {schedule.allDay.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 px-4 pb-2">
                {schedule.allDay.map((a) => (
                  <span
                    key={a.id}
                    title="종일"
                    className="max-w-full break-words rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                  >
                    {a.title}
                  </span>
                ))}
              </div>
            ) : null}

            {schedule.rows.length === 0 ? (
              <p className="px-4 pb-3 text-sm text-gray-400">오늘 시간 일정이 없어요.</p>
            ) : (
              <ul className="pb-1">
                {schedule.rows.map((row, i) => {
                  const b = matched.get(row.id)
                  return (
                    <Fragment key={row.id}>
                      {i === schedule.nowIndex ? nowLine : null}
                      <ScheduleItem
                        row={row}
                        briefing={b}
                        open={b ? open.has(b.event.id) : false}
                        onToggle={toggle}
                        regenerating={b ? regeneratingIds.includes(b.event.id) : false}
                        canRegenerate={canRegenerate}
                        onRegenerate={onRegenerate}
                      />
                    </Fragment>
                  )
                })}
                {schedule.nowIndex >= schedule.rows.length ? nowLine : null}
              </ul>
            )}

            <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500 tabular-nums break-words">
              <span className="font-medium text-gray-600">내일</span>
              <span aria-hidden> ▸ </span>
              {schedule.tomorrowCount > 0
                ? `일정 ${schedule.tomorrowCount}건${schedule.tomorrowFirst ? ` · 첫 ${schedule.tomorrowFirst}` : ''}`
                : '시간 일정 없음'}
            </p>
          </>
        )}
      </section>
    </Card>
  )
}
