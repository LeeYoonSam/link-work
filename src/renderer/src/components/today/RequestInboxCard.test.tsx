import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RequestInboxItem, RequestInboxSnapshot } from '../../types'

// 카드는 '더 보기' 펼침에 useState 를 쓴다. DOM 테스트 환경이 없어 훅만 단순 구현으로 바꿔 함수로 부른다
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(init: T | (() => T)) => [typeof init === 'function' ? (init as () => T)() : init, () => {}]
  }
})

const { default: RequestInboxCard, INBOX_VISIBLE, inboxVisible, relativeTime, sourceNotes } = await import(
  './RequestInboxCard'
)
const { click, findButton } = await import('./testTree')

const NOW = new Date('2026-11-27T06:00:00.000Z')

const item = (id: string, over: Partial<RequestInboxItem> = {}): RequestInboxItem => ({
  id,
  source: 'jira',
  kind: 'assigned',
  title: `${id} 제목`,
  ref: id,
  actor: null,
  excerpt: null,
  url: `https://acme.atlassian.net/browse/${id}`,
  requestedAt: null,
  firstSeenAt: '2026-11-27T05:00:00.000Z',
  ...over
})

const snap = (over: Partial<RequestInboxSnapshot> = {}): RequestInboxSnapshot => ({
  items: [
    item('ICA-1'),
    item('ICA-2', { kind: 'mention', actor: '을', excerpt: '@나 확인 부탁', requestedAt: '2026-11-27T03:00:00.000Z' }),
    item('app #3', { id: 'pr', source: 'bitbucket', kind: 'review', title: '로그인', actor: '갑' })
  ],
  jira: { state: 'ok', error: null },
  bitbucket: { state: 'ok', error: null },
  syncedAt: null,
  ...over
})

const noop = (): void => {}
const handlers = { onOpen: noop, onToTodo: noop, onDismiss: noop, onOpenSettings: noop }

describe('RequestInboxCard', () => {
  it('종류·출처·제목·요청자·시각·멘션 미리보기를 그린다', () => {
    const html = renderToStaticMarkup(
      <RequestInboxCard snapshot={snap()} now={NOW} busyIds={[]} error={null} {...handlers} />
    )
    expect(html).toContain('나에게 온 요청')
    expect(html).toContain('담당')
    expect(html).toContain('멘션')
    expect(html).toContain('리뷰')
    expect(html).toContain('app #3')
    expect(html).toContain('“@나 확인 부탁”')
    expect(html).toContain('을 · 3시간 전')
  })

  it('[할 일로]·[처리함]·출처 버튼이 그 요청 id 로 부른다', () => {
    const onToTodo = vi.fn()
    const onDismiss = vi.fn()
    const onOpen = vi.fn()
    const tree = RequestInboxCard({
      snapshot: snap({ items: [item('ICA-1')] }),
      now: NOW,
      busyIds: [],
      error: null,
      onOpen,
      onToTodo,
      onDismiss,
      onOpenSettings: noop
    })
    click(findButton(tree, '할 일로'))
    click(findButton(tree, '처리함'))
    click(findButton(tree, 'ICA-1'))
    expect(onToTodo).toHaveBeenCalledWith('ICA-1')
    expect(onDismiss).toHaveBeenCalledWith('ICA-1')
    expect(onOpen).toHaveBeenCalledWith('ICA-1')
  })

  it('처리 중인 요청의 버튼은 잠근다', () => {
    const tree = RequestInboxCard({
      snapshot: snap({ items: [item('ICA-1')] }),
      now: NOW,
      busyIds: ['ICA-1'],
      error: null,
      ...handlers
    })
    expect(findButton(tree, '할 일로').props.disabled).toBe(true)
  })

  it(`${INBOX_VISIBLE}건을 넘으면 접어 두고 외 n건을 보인다`, () => {
    const items = Array.from({ length: INBOX_VISIBLE + 2 }, (_, i) => item(`ICA-${i + 10}`))
    const html = renderToStaticMarkup(
      <RequestInboxCard snapshot={snap({ items })} now={NOW} busyIds={[]} error={null} {...handlers} />
    )
    expect(html).toContain('외 2건 더 보기')
    expect(html).not.toContain(`ICA-${INBOX_VISIBLE + 11}`)
  })

  it('비었으면 빈 문구를, 둘 다 연결되지 않았으면 카드를 그리지 않는다', () => {
    const empty = renderToStaticMarkup(
      <RequestInboxCard snapshot={snap({ items: [] })} now={NOW} busyIds={[]} error={null} {...handlers} />
    )
    expect(empty).toContain('새로 온 요청이 없어요')
    const none = snap({ items: [], jira: { state: 'not_connected', error: null }, bitbucket: { state: 'not_connected', error: null } })
    expect(inboxVisible(none)).toBe(false)
    expect(inboxVisible(null)).toBe(false)
    expect(renderToStaticMarkup(<RequestInboxCard snapshot={none} now={NOW} busyIds={[]} error={null} {...handlers} />)).toBe('')
  })

  it('원본 오류와 워크스페이스 미지정만 안내하고, 미연결은 말하지 않는다', () => {
    expect(
      sourceNotes(
        snap({
          jira: { state: 'error', error: '토큰 만료' },
          bitbucket: { state: 'no_workspace', error: null }
        })
      )
    ).toEqual([
      { text: 'Jira: 토큰 만료', tone: 'error' },
      { text: 'Bitbucket 워크스페이스를 정하면 리뷰 요청도 모아요.', tone: 'hint' }
    ])
    expect(sourceNotes(snap({ bitbucket: { state: 'not_connected', error: null } }))).toEqual([])
  })

  it('워크스페이스가 정해져 있고 오류가 없으면 안내 줄·설정 링크를 그리지 않는다', () => {
    const html = renderToStaticMarkup(
      <RequestInboxCard snapshot={snap()} now={NOW} busyIds={[]} error={null} {...handlers} />
    )
    expect(html).not.toContain('워크스페이스를 정하면')
    expect(html).not.toContain('설정 →')
  })

  it('워크스페이스가 없거나 원본 오류면 설정으로 가는 링크를 붙인다', () => {
    const onOpenSettings = vi.fn()
    for (const s of [
      snap({ bitbucket: { state: 'no_workspace', error: null } }),
      snap({ jira: { state: 'error', error: '토큰 만료' } })
    ]) {
      const tree = RequestInboxCard({ snapshot: s, now: NOW, busyIds: [], error: null, ...handlers, onOpenSettings })
      click(findButton(tree, '설정 →'))
    }
    expect(onOpenSettings).toHaveBeenCalledTimes(2)
  })
})

describe('relativeTime', () => {
  it('분·시간·일 단위로 줄인다', () => {
    expect(relativeTime(null, NOW)).toBeNull()
    expect(relativeTime('깨진 값', NOW)).toBeNull()
    expect(relativeTime('2026-11-27T05:59:40.000Z', NOW)).toBe('방금')
    expect(relativeTime('2026-11-27T05:15:00.000Z', NOW)).toBe('45분 전')
    expect(relativeTime('2026-11-27T01:00:00.000Z', NOW)).toBe('5시간 전')
    expect(relativeTime('2026-11-24T06:00:00.000Z', NOW)).toBe('3일 전')
  })
})
