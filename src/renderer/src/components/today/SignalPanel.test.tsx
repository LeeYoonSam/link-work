import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SignalRef, TodaySignal } from './todayModel'
import { collect, click, findButton } from './testTree'

// DOM 환경이 없어 SignalPanel 을 함수로 직접 부른다. 그래서 useState 를 단순 구현으로 바꾸고 세터 호출을 기록한다
const setters = vi.hoisted(() => ({ calls: [] as unknown[] }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(init: T | (() => T)) => [
      typeof init === 'function' ? (init as () => T)() : init,
      (v: unknown) => setters.calls.push(v)
    ]
  }
})

const { default: SignalPanel, SeverityIcon, meetingSoonSuffix } = await import('./SignalPanel')

const NOW = new Date(2026, 10, 19, 13, 20, 0)
const START_1400 = new Date(2026, 10, 19, 14, 0, 0).toISOString()

const sig = (over: Partial<TodaySignal> & Pick<TodaySignal, 'id'>): TodaySignal => ({
  kind: 'overdue',
  severity: 'warn',
  text: '마감 지난 Jira 1건',
  refs: [],
  ...over
})

const SIGNALS: TodaySignal[] = [
  sig({
    id: 'release_risk',
    kind: 'release_risk',
    severity: 'critical',
    text: 'QA 시작, 2건 미완 — 4.177.0 포함분',
    refs: [
      { type: 'issue', id: 'ICA-812', label: 'ICA-812' },
      { type: 'issue', id: 'ICA-830', label: 'ICA-830' }
    ]
  }),
  sig({ id: 'overdue:todo', kind: 'overdue', severity: 'warn', text: '마감 지난 할 일 1건', refs: [{ type: 'todo', id: '3', label: '보고서' }] }),
  sig({
    id: 'meeting_soon',
    kind: 'meeting_soon',
    severity: 'info',
    text: '14:00 Tech weekly',
    refs: [{ type: 'meeting', id: 'cal-9', label: 'Tech weekly' }]
  })
]

const render = (over: Partial<Parameters<typeof SignalPanel>[0]> = {}): string =>
  renderToStaticMarkup(
    <SignalPanel
      signals={SIGNALS}
      hiddenSignals={[]}
      hiddenCount={0}
      summaryLine=""
      now={NOW}
      meetingStarts={{ 'cal-9': START_1400 }}
      onOpenRef={() => {}}
      {...over}
    />
  )

describe('SignalPanel', () => {
  it('신호 행을 순서대로 그리고 severity 를 색과 모양·라벨로 구분한다', () => {
    const html = render()
    expect(html).toContain('지금 챙길 것')
    const order = ['release_risk', 'overdue:todo', 'meeting_soon'].map((id) => html.indexOf(`data-signal="${id}"`))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toContain('aria-label="긴급"')
    expect(html).toContain('aria-label="주의"')
    expect(html).toContain('aria-label="참고"')
    // 모양이 서로 다르다: 마름모·삼각형·원
    const crit = renderToStaticMarkup(<SeverityIcon severity="critical" />)
    const warn = renderToStaticMarkup(<SeverityIcon severity="warn" />)
    const info = renderToStaticMarkup(<SeverityIcon severity="info" />)
    expect(crit).toContain('M8 1.5 14.5 8 8 14.5 1.5 8Z')
    expect(warn).toContain('M8 1.8 15 14H1Z')
    expect(info).toContain('<circle cx="8" cy="8" r="4.5"')
  })

  it('meeting_soon 행에는 화면이 n분 뒤를 붙인다', () => {
    expect(render()).toContain('40분 뒤')
    expect(meetingSoonSuffix(SIGNALS[2], { 'cal-9': START_1400 }, new Date(2026, 10, 19, 14, 5))).toBe('')
    expect(meetingSoonSuffix(SIGNALS[0], { 'cal-9': START_1400 }, NOW)).toBe('')
  })

  it('신호가 0건이면 요약 1줄을 보인다', () => {
    const html = render({ signals: [], summaryLine: '회의 2 · 오늘 마감 1 · 배포 D-5' })
    expect(html).toContain('회의 2 · 오늘 마감 1 · 배포 D-5')
    expect(html).not.toContain('data-signal=')
  })

  it('숨은 신호가 있으면 외 n건 버튼(aria-expanded)으로 같은 모양의 행을 펼친다. 닫기 버튼은 없다', () => {
    const hidden = [
      sig({ id: 'due_today', kind: 'due_today', severity: 'info', text: '오늘 마감 2건' }),
      sig({ id: 'qa_start', kind: 'qa_start', severity: 'info', text: 'QA 시작' })
    ]
    const closed = render({ hiddenSignals: hidden, hiddenCount: 2 })
    expect(closed).toMatch(/<button[^>]*aria-expanded="false"[^>]*>외 2건/)
    expect(closed).not.toContain('data-signal="due_today"')
    expect(closed).not.toContain('닫기')
    const open = render({ hiddenSignals: hidden, hiddenCount: 2, defaultExpanded: true })
    expect(open).toMatch(/aria-expanded="true"[^>]*>접기/)
    expect(open).toContain('id="today-signals-hidden"')
    expect(open).toContain('data-signal="due_today"')
    expect(open).toContain('data-signal="qa_start"')
    // 펼친 영역은 위 행과 구분선으로 나뉜다
    expect(open).toMatch(/id="today-signals-hidden"[^>]*border-t border-dashed/)
    // 버튼을 누르면 펼침 상태를 뒤집는다
    setters.calls.length = 0
    const tree = SignalPanel({
      signals: SIGNALS,
      hiddenSignals: hidden,
      hiddenCount: 2,
      summaryLine: '',
      now: NOW,
      meetingStarts: {},
      onOpenRef: () => {}
    })
    click(findButton(tree, '외 2건'))
    const toggle = setters.calls[0] as (v: boolean) => boolean
    expect(toggle(false)).toBe(true)
    // 숨은 신호 목록이 없으면(옛 모델) 건수만 글자로 보인다
    expect(render({ hiddenCount: 2 })).not.toMatch(/<button[^>]*aria-expanded/)
  })

  it('근거 칩을 누르면 그 ref 로 onOpenRef 를 부른다', () => {
    const onOpenRef = vi.fn<(r: SignalRef) => void>()
    const tree = SignalPanel({
      signals: SIGNALS,
      hiddenSignals: [],
      hiddenCount: 0,
      summaryLine: '',
      now: NOW,
      meetingStarts: {},
      onOpenRef
    })
    const chips = collect(tree).filter((e) => e.type === 'button' && e.props['data-ref-id'])
    expect(chips.map((c) => c.props['data-ref-id'])).toEqual(['ICA-812', 'ICA-830', '3', 'cal-9'])
    click(chips[1])
    expect(onOpenRef).toHaveBeenCalledWith({ type: 'issue', id: 'ICA-830', label: 'ICA-830' })
    click(chips[3])
    expect(onOpenRef).toHaveBeenLastCalledWith({ type: 'meeting', id: 'cal-9', label: 'Tech weekly' })
  })

  it('회의 신호의 근거 칩은 제목을 반복하지 않고 일정 보기라고 쓴다', () => {
    const html = render()
    const row = html.slice(html.indexOf('data-signal="meeting_soon"'))
    expect(row).toContain('>일정 보기</span>')
    expect(row).not.toContain('>Tech weekly</span>')
  })

  it('근거 칩은 최대 4개, 나머지는 외 n 으로 줄인다', () => {
    const refs: SignalRef[] = Array.from({ length: 6 }, (_, i) => ({ type: 'issue', id: `ICA-${i}`, label: `ICA-${i}` }))
    const html = render({ signals: [sig({ id: 'overdue:jira', refs })] })
    expect(html.match(/data-ref-id=/g) ?? []).toHaveLength(4)
    expect(html).toContain('외 2')
    // 배포 ref 는 상한과 무관하게 남는다(모델 visibleRefs 규칙)
    const withRelease = render({
      signals: [sig({ id: 'release_risk', refs: [...refs, { type: 'release', id: '4.177.0', label: '4.177.0' }] })]
    })
    expect(withRelease).toContain('data-ref-id="4.177.0"')
    expect(withRelease.match(/data-ref-id=/g) ?? []).toHaveLength(5)
  })
})
