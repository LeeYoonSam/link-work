import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AssistantEvent, CheckinPayload, PlanItem } from '../../types'

// 체크인 패널 (docs/ASSISTANT.md 부록 H.8.1·H.9.8).
// CommandInput 은 스토어를 쓰므로 모킹한다. 받은 props 만 표시한다.
vi.mock('./CommandInput', () => ({
  default: (props: { scopeItemId?: number; onApplied?: () => void }) => (
    <div data-testid="command-input" data-scope={props.scopeItemId ?? ''} />
  )
}))

const { default: CheckinPanel, pendingCheckin, parseCheckinPayload, submitCheckin } = await import('./CheckinPanel')

const item = (over: Partial<PlanItem> & Pick<PlanItem, 'id'>): PlanItem => ({
  plan_id: 1,
  candidate_id: `task:${over.id}`,
  source: 'task',
  title: `작업 ${over.id}`,
  link: null,
  jira_issue_key: null,
  project_id: 3,
  due_date: null,
  score: 50,
  rank: over.id,
  slot_start: null,
  slot_end: null,
  pinned: false,
  added_by: 'start',
  urgent: false,
  status: 'planned',
  status_note: null,
  status_at: null,
  first_planned_date: '2026-11-02',
  ...over
})

const checkinPayload = (over: Partial<CheckinPayload> = {}): CheckinPayload => ({
  itemId: 1,
  candidateId: 'task:1',
  itemTitle: '작업 1',
  blockStart: '09:45',
  blockEnd: '11:00',
  title: '체크인: 작업 1',
  body: '지금까지 어떻게 됐나요? 답장하거나 눌러서 고르세요.',
  ...over
})

const event = (
  over: Partial<AssistantEvent> & Pick<AssistantEvent, 'id'>,
  payload: CheckinPayload | null = checkinPayload()
): AssistantEvent => ({
  event_key: `checkin:2026-11-02:${over.id}`,
  kind: 'checkin',
  plan_date: '2026-11-02',
  scheduled_at: '2026-11-02 10:55:00',
  fired_at: '2026-11-02 10:55:10',
  status: 'sent',
  ref_id: payload ? String(payload.itemId) : null,
  payload: payload ? JSON.stringify(payload) : null,
  response: null,
  responded_at: null,
  created_at: '2026-11-02 10:55:10',
  ...over
})

const noop = (): void => {}

describe('parseCheckinPayload', () => {
  it('정상 payload 를 읽고, 비었거나 깨졌거나 itemId 가 없으면 null 이다', () => {
    expect(parseCheckinPayload(JSON.stringify(checkinPayload()))).toEqual(checkinPayload())
    expect(parseCheckinPayload(null)).toBeNull()
    expect(parseCheckinPayload('{깨짐')).toBeNull()
    expect(parseCheckinPayload(JSON.stringify({ blockStart: '09:00', blockEnd: '10:00' }))).toBeNull()
    expect(parseCheckinPayload('null')).toBeNull()
  })
})

describe('pendingCheckin (부록 H.8.1)', () => {
  const items = [item({ id: 1 }), item({ id: 2, status: 'in_progress' }), item({ id: 3, status: 'done' })]

  it('응답 없는 checkin 중 fired_at 이 가장 늦은 1건을 고른다', () => {
    const events = [
      event({ id: 10, fired_at: '2026-11-02 10:55:10' }),
      event(
        { id: 11, fired_at: '2026-11-02 14:55:00' },
        checkinPayload({ itemId: 2, blockStart: '13:00', blockEnd: '15:00' })
      )
    ]
    const p = pendingCheckin(events, items)
    expect(p?.event.id).toBe(11)
    expect(p?.item.id).toBe(2)
    expect(p?.payload.blockEnd).toBe('15:00')
  })

  it('응답한 행, 다른 kind, 활성이 아닌 항목, 계획에 없는 항목, 깨진 payload 는 고르지 않는다', () => {
    const events = [
      event({ id: 10, response: 'button:done', responded_at: '2026-11-02 10:56:00' }),
      event({ id: 11, kind: 'command' }),
      event({ id: 12 }, checkinPayload({ itemId: 3 })),
      event({ id: 13 }, checkinPayload({ itemId: 99 })),
      event({ id: 14, payload: '{깨짐' })
    ]
    expect(pendingCheckin(events, items)).toBeNull()
    expect(pendingCheckin([], items)).toBeNull()
  })

  it('입력 배열을 바꾸지 않는다', () => {
    const events = [event({ id: 10 }), event({ id: 11, fired_at: '2026-11-02 12:00:00' })]
    const before = JSON.stringify(events)
    pendingCheckin(events, items)
    expect(JSON.stringify(events)).toBe(before)
  })
})

describe('CheckinPanel 렌더링 (부록 H.9.8 3가지 상태)', () => {
  const items = [item({ id: 1, title: '결제 API 리팩터링' })]

  it('대기 중: 제목·블록·질문·버튼 4개·메모·범위 지정 명령 입력을 보여 준다', () => {
    const pending = pendingCheckin([event({ id: 10 })], items)
    expect(pending).not.toBeNull()
    const html = renderToStaticMarkup(
      <CheckinPanel pending={pending!} busy={false} readOnly={false} onRespond={noop} onApplied={noop} />
    )
    expect(html).toContain('id="today-checkin"')
    expect(html).toContain('체크인 · 10:55')
    expect(html).toContain('09:45–11:00')
    expect(html).toContain('결제 API 리팩터링')
    expect(html).toContain('어떻게 됐나요?')
    for (const label of ['>완료<', '>진행 중<', '>미룸<', '>넘기기<']) expect(html).toContain(label)
    expect(html).toContain('한 줄 메모')
    expect(html).toContain('data-testid="command-input"')
    expect(html).toContain('data-scope="1"')
    expect(html).not.toContain('오늘 마감')
    expect(html).not.toContain('disabled=""')
  })

  it('대기 중 + busy: 버튼을 비활성으로 둔다', () => {
    const pending = pendingCheckin([event({ id: 10 })], items)!
    const html = renderToStaticMarkup(
      <CheckinPanel pending={pending} busy={true} readOnly={false} onRespond={noop} onApplied={noop} />
    )
    expect(html.match(/<button[^>]*disabled=""/g)?.length).toBe(4)
  })

  it('응답 완료: pendingCheckin 이 null 이라 패널을 그리지 않는다', () => {
    const answered = [event({ id: 10, response: 'skip', responded_at: '2026-11-02 10:57:00' })]
    expect(pendingCheckin(answered, items)).toBeNull()
    // 오늘 화면은 null 이면 패널을 그리지 않는다. 같은 조건을 여기서 그린다
    const p = pendingCheckin(answered, items)
    const html = renderToStaticMarkup(
      <div>
        {p ? <CheckinPanel pending={p} busy={false} readOnly={false} onRespond={noop} onApplied={noop} /> : null}
      </div>
    )
    expect(html).not.toContain('today-checkin')
  })

  it('닫힘: 버튼·메모·명령 입력을 숨기고 오늘 마감만 보인다', () => {
    const pending = pendingCheckin([event({ id: 10 })], items)!
    const html = renderToStaticMarkup(
      <CheckinPanel pending={pending} busy={false} readOnly={true} onRespond={noop} onApplied={noop} />
    )
    expect(html).toContain('id="today-checkin"')
    expect(html).toContain('오늘 마감')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('한 줄 메모')
    expect(html).not.toContain('command-input')
  })
})

describe('submitCheckin 메모 처리', () => {
  it('응답이 성공했을 때만 메모를 비우고, 실패하면 메모를 둔다. 넘기기는 메모를 보내지 않는다', async () => {
    const clear = vi.fn()
    const ok = vi.fn(async () => true)
    await submitCheckin(ok, 10, 'done', '  리뷰 요청함 ', clear)
    expect(ok).toHaveBeenCalledWith(10, 'done', '리뷰 요청함')
    expect(clear).toHaveBeenCalledTimes(1)

    clear.mockClear()
    const fail = vi.fn(async () => false)
    await submitCheckin(fail, 10, 'deferred', '내일 할게', clear)
    expect(fail).toHaveBeenCalledWith(10, 'deferred', '내일 할게')
    expect(clear).not.toHaveBeenCalled()

    const skip = vi.fn(async () => true)
    await submitCheckin(skip, 10, null, '메모', clear)
    expect(skip).toHaveBeenCalledWith(10, null, undefined)
    await submitCheckin(ok, 10, 'in_progress', '   ', clear)
    expect(ok).toHaveBeenLastCalledWith(10, 'in_progress', undefined)
  })
})
