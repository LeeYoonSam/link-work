import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DailyPlan, DayTimeline, PlanItem, TimelineEntry } from '../../types'
import SummaryTiles, { nextMeeting, summaryTiles, type SummaryTile } from './SummaryTiles'

// 홈 요약 타일 (부록 L). 순수 함수만 판정하고 마크업은 클래스 규칙만 본다

const item = (id: number, status: PlanItem['status']): PlanItem =>
  ({ id, status }) as unknown as PlanItem

const plan = (status: DailyPlan['status']): DailyPlan => ({ status }) as unknown as DailyPlan

const ENTRIES: TimelineEntry[] = [
  { kind: 'block', start: '09:45', end: '11:00', minutes: 75, state: 'current', itemId: 1, reason: 'focus', continued: false },
  { kind: 'meeting', start: '11:00', end: '12:00', title: '주간 스프린트' },
  { kind: 'meeting', start: '12:00', end: '13:00', title: '점심' },
  { kind: 'block', start: '13:00', end: '15:30', minutes: 150, state: 'future', itemId: 1, reason: 'focus', continued: true },
  { kind: 'meeting', start: '15:30', end: '16:00', title: '1:1' }
]

const timeline = (over: Partial<DayTimeline> = {}): DayTimeline => ({
  entries: ENTRIES,
  freeMinutesLeft: 270,
  focusItemId: 1,
  unplacedDeadlineItemIds: [],
  ...over
})

const byKey = (tiles: SummaryTile[], key: SummaryTile['key']): SummaryTile => {
  const t = tiles.find((x) => x.key === key)
  if (!t) throw new Error(`타일 없음: ${key}`)
  return t
}

describe('summaryTiles (부록 L)', () => {
  it('남은 할 일은 예정+진행 중, 전체는 제안·무시를 뺀 수, 완료 보조는 0 인 부분을 생략한다', () => {
    const items = [
      item(1, 'planned'),
      item(2, 'in_progress'),
      item(3, 'done'),
      item(4, 'done'),
      item(5, 'deferred'),
      item(6, 'suggested'),
      item(7, 'dismissed')
    ]
    const tiles = summaryTiles({ plan: plan('active'), items, timeline: timeline() }, '10:00')
    expect(tiles.map((t) => t.label)).toEqual(['남은 할 일', '완료', '다음 회의', '집중 가능 시간'])
    expect(byKey(tiles, 'remaining')).toMatchObject({ value: '2건', sub: '전체 5건' })
    expect(byKey(tiles, 'done')).toMatchObject({ value: '2건', sub: '미룸 1' })

    const withDropped = summaryTiles(
      { plan: plan('active'), items: [...items, item(8, 'dropped')], timeline: timeline() },
      '10:00'
    )
    expect(byKey(withDropped, 'done').sub).toBe('미룸 1 · 제외 1')
    const clean = summaryTiles({ plan: plan('active'), items: [item(1, 'done')], timeline: timeline() }, '10:00')
    expect(byKey(clean, 'done').sub).toBeNull()
  })

  it('다음 회의는 끝나지 않은(end > now) 첫 회의다. 진행 중인 회의도 고른다', () => {
    expect(nextMeeting(ENTRIES, '10:00')?.title).toBe('주간 스프린트')
    // 11:30 은 첫 회의가 진행 중이다
    expect(nextMeeting(ENTRIES, '11:30')?.title).toBe('주간 스프린트')
    // 끝 시각과 같으면 끝난 회의다
    expect(nextMeeting(ENTRIES, '12:00')?.title).toBe('점심')
    expect(nextMeeting(ENTRIES, '14:00')?.title).toBe('1:1')
    const tiles = summaryTiles({ plan: plan('active'), items: [], timeline: timeline() }, '12:30')
    expect(byKey(tiles, 'meeting')).toMatchObject({ value: '12:00', sub: '점심' })
  })

  it('남은 회의가 없으면 값은 — 이고 보조는 남은 회의가 없어요 다', () => {
    expect(nextMeeting(ENTRIES, '16:00')).toBeNull()
    const late = summaryTiles({ plan: plan('active'), items: [], timeline: timeline() }, '17:00')
    expect(byKey(late, 'meeting')).toMatchObject({ value: '—', sub: '남은 회의가 없어요' })
    const none = summaryTiles({ plan: plan('active'), items: [], timeline: timeline({ entries: [] }) }, '09:00')
    expect(byKey(none, 'meeting')).toMatchObject({ value: '—', sub: '남은 회의가 없어요' })
  })

  it('집중 가능 시간은 근무 중이면 남은 빈 시간, 닫힘이면 — 다', () => {
    const active = summaryTiles({ plan: plan('active'), items: [], timeline: timeline() }, '10:00')
    expect(byKey(active, 'free').value).toBe('4시간 30분')
    const closed = summaryTiles({ plan: plan('closed'), items: [], timeline: timeline() }, '10:00')
    expect(byKey(closed, 'free').value).toBe('—')
    const noPlan = summaryTiles({ plan: null, items: [], timeline: timeline() }, '10:00')
    expect(byKey(noPlan, 'free').value).toBe('—')
  })

  it('타일 마크업: 카드 4개, 값 text-2xl, 작은 글자 없음', () => {
    const tiles = summaryTiles({ plan: plan('active'), items: [item(1, 'planned')], timeline: timeline() }, '10:00')
    const html = renderToStaticMarkup(<SummaryTiles tiles={tiles} />)
    expect(html.split('text-2xl font-bold').length - 1).toBe(4)
    expect(html).not.toMatch(/text-\[1[01]px\]/)
    expect(html).not.toContain('text-xs')
  })
})
