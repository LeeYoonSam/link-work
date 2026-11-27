import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { memoryInboxDb } from './__fixtures__/inbox/inbox-db'

let db: Database.Database

vi.mock('../db/database', () => ({ getDatabase: () => db }))
vi.mock('../utils/activity-logger', () => ({ logActivity: vi.fn() }))

const jira = {
  connected: true,
  assigned: vi.fn(),
  mentions: vi.fn(),
  myId: vi.fn()
}
vi.mock('./jira', () => ({
  isJiraConnected: () => jira.connected,
  getJiraMyAccountId: () => jira.myId(),
  getJiraIssueUrl: (key: string) => `https://acme.atlassian.net/browse/${key}`,
  listAssignedRequests: () => jira.assigned(),
  listMentionRequests: (id: string) => jira.mentions(id)
}))

const bb = { connected: true, workspace: 'ws' as string | null, reviews: vi.fn() }
vi.mock('./bitbucket', () => ({
  isBitbucketConnected: () => bb.connected,
  getBitbucketWorkspace: () => bb.workspace,
  listReviewRequests: (fallback: string | null, isHandled: (ws: string, repo: string, id: number) => boolean) =>
    bb.reviews(fallback, isHandled)
}))

import {
  cachedRequestInbox,
  convertRequestToTodo,
  dismissRequest,
  FORCE_MIN_INTERVAL_MS,
  isDateKey,
  markRequestInboxStale,
  MIN_SYNC_INTERVAL_MS,
  requestUrl,
  resetRequestInboxState,
  syncRequestInbox,
  todoTitleFor
} from './request-inbox'

// 강제 동기화도 30초 안의 연타는 거른다. 테스트마다 시각을 1시간씩 넘긴다
let clock = 0
const tick = (): number => (clock += 3_600_000)

beforeEach(() => {
  db = memoryInboxDb()
  resetRequestInboxState()
  jira.connected = true
  bb.connected = true
  bb.workspace = 'ws'
  jira.myId.mockReset().mockResolvedValue('acc-me')
  jira.assigned.mockReset().mockResolvedValue({
    issues: [{ key: 'ICA-1', summary: 'QA', reporterName: '김명환', updated: '2026-11-27T12:00:00.000+0900' }],
    truncated: false
  })
  jira.mentions.mockReset().mockResolvedValue({
    mentions: [
      { key: 'ICA-2', summary: '스킴', commentId: '55', authorName: '을', created: '2026-11-26T10:00:00.000+0900', excerpt: '@나 확인' }
    ],
    truncated: false
  })
  bb.reviews.mockReset().mockResolvedValue({
    requests: [
      { workspace: 'ws', repo: 'app', id: 3, title: '로그인', authorName: '갑', url: 'https://bitbucket.org/ws/app/pull-requests/3', createdOn: '2026-11-25T00:00:00+00:00' }
    ],
    complete: true
  })
})

describe('syncRequestInbox', () => {
  it('Jira 할당·멘션과 Bitbucket 리뷰 요청을 모은다', async () => {
    const snap = await syncRequestInbox(true, tick())
    expect(snap.jira).toEqual({ state: 'ok', error: null })
    expect(snap.bitbucket).toEqual({ state: 'ok', error: null })
    const byId = Object.fromEntries(snap.items.map((i) => [i.id, i]))
    expect(Object.keys(byId).sort()).toEqual([
      'bitbucket:review:ws/app#3',
      'jira:assigned:ICA-1',
      'jira:mention:ICA-2:55'
    ])
    expect(byId['jira:mention:ICA-2:55']).toMatchObject({
      kind: 'mention',
      ref: 'ICA-2',
      actor: '을',
      url: 'https://acme.atlassian.net/browse/ICA-2?focusedCommentId=55',
      requestedAt: '2026-11-26T01:00:00.000Z'
    })
    expect(byId['bitbucket:review:ws/app#3']).toMatchObject({ ref: 'app #3', title: '로그인', actor: '갑' })
    // Bitbucket 은 Jira accountId 를 대신 쓸 수 있게 받는다
    expect(bb.reviews).toHaveBeenCalledWith('acc-me', expect.any(Function))
  })

  it('한 원본이 실패해도 다른 원본은 반영하고, 실패한 원본의 기존 요청은 지우지 않는다', async () => {
    await syncRequestInbox(true, tick())
    jira.assigned.mockRejectedValueOnce(new Error('Jira 토큰이 만료됐거나'))
    bb.reviews.mockResolvedValueOnce({ requests: [], complete: true })
    const snap = await syncRequestInbox(true, tick())
    expect(snap.jira).toEqual({ state: 'error', error: 'Jira 토큰이 만료됐거나' })
    expect(snap.items.map((i) => i.id).sort()).toEqual(['jira:assigned:ICA-1', 'jira:mention:ICA-2:55'])
  })

  it('연결되지 않았거나 워크스페이스가 없으면 그 원본을 부르지 않는다', async () => {
    jira.connected = false
    bb.workspace = null
    const snap = await syncRequestInbox(true, tick())
    expect(snap.jira.state).toBe('not_connected')
    expect(snap.bitbucket.state).toBe('no_workspace')
    expect(jira.assigned).not.toHaveBeenCalled()
    expect(bb.reviews).not.toHaveBeenCalled()
    expect(cachedRequestInbox().bitbucket.state).toBe('no_workspace')
  })

  it('자동 동기화는 간격 안이면 원본을 부르지 않고, ↻ 는 30초 안의 연타만 거른다', async () => {
    const t0 = 1_000_000
    await syncRequestInbox(false, t0)
    await syncRequestInbox(false, t0 + MIN_SYNC_INTERVAL_MS - 1)
    expect(jira.assigned).toHaveBeenCalledTimes(1)
    await syncRequestInbox(false, t0 + MIN_SYNC_INTERVAL_MS)
    expect(jira.assigned).toHaveBeenCalledTimes(2)
    const t1 = t0 + MIN_SYNC_INTERVAL_MS
    await syncRequestInbox(true, t1 + FORCE_MIN_INTERVAL_MS - 1)
    expect(jira.assigned).toHaveBeenCalledTimes(2)
    await syncRequestInbox(true, t1 + FORCE_MIN_INTERVAL_MS)
    expect(jira.assigned).toHaveBeenCalledTimes(3)
  })

  it('설정을 바꾸면(markRequestInboxStale) 다음 자동 동기화가 간격과 무관하게 돈다', async () => {
    const t0 = 1_000_000
    await syncRequestInbox(false, t0)
    markRequestInboxStale()
    await syncRequestInbox(false, t0 + 1)
    expect(jira.assigned).toHaveBeenCalledTimes(2)
  })

  it('내 Jira accountId 는 동기화마다 다시 읽는다(계정을 바꿔 다시 연결해도 옛 값을 쓰지 않는다)', async () => {
    await syncRequestInbox(true, 1_000_000)
    jira.myId.mockResolvedValue('acc-new')
    await syncRequestInbox(true, 2_000_000)
    expect(jira.mentions).toHaveBeenLastCalledWith('acc-new')
    expect(bb.reviews).toHaveBeenLastCalledWith('acc-new', expect.any(Function))
  })

  it('연결을 끊은 원본의 저장 행은 보이지 않는다', async () => {
    await syncRequestInbox(true, 1_000_000)
    jira.connected = false
    expect(cachedRequestInbox().items.map((i) => i.source)).toEqual(['bitbucket'])
    bb.workspace = null
    expect(cachedRequestInbox().items).toEqual([])
  })

  it('이미 처리한 리뷰 요청은 승인 확인을 건너뛰게 알려 준다', async () => {
    await syncRequestInbox(true, 1_000_000)
    dismissRequest('bitbucket:review:ws/app#3')
    await syncRequestInbox(true, 2_000_000)
    const isHandled = bb.reviews.mock.calls.at(-1)![1] as (ws: string, repo: string, id: number) => boolean
    expect(isHandled('ws', 'app', 3)).toBe(true)
    expect(isHandled('ws', 'app', 4)).toBe(false)
  })
})

describe('할 일로·처리함', () => {
  it('할 일로 바꾸면 출처 링크·마감이 붙은 할 일이 생기고 요청은 다시 보이지 않는다', async () => {
    await syncRequestInbox(true, tick())
    const res = convertRequestToTodo('bitbucket:review:ws/app#3', '2026-11-27')
    expect(res.success).toBe(true)
    const todo = db.prepare('SELECT title, due_date, source_link FROM todos').get()
    expect(todo).toEqual({
      title: '[리뷰] app #3 로그인',
      due_date: '2026-11-27',
      source_link: 'https://bitbucket.org/ws/app/pull-requests/3'
    })
    expect(cachedRequestInbox().items.map((i) => i.id)).not.toContain('bitbucket:review:ws/app#3')
    // 다시 동기화해도 돌아오지 않는다
    expect((await syncRequestInbox(true, tick())).items.map((i) => i.id)).not.toContain('bitbucket:review:ws/app#3')
    // 두 번 바꾸지 않는다
    expect(convertRequestToTodo('bitbucket:review:ws/app#3', null)).toEqual({
      success: false,
      error: '이미 처리했거나 사라진 요청입니다.'
    })
  })

  it('잘못된 입력은 거부한다', async () => {
    await syncRequestInbox(true, tick())
    expect(convertRequestToTodo(1, null).success).toBe(false)
    expect(convertRequestToTodo('jira:assigned:ICA-1', '11/27').success).toBe(false)
    expect(convertRequestToTodo('jira:assigned:ICA-1', '2026-02-31').success).toBe(false)
    expect(isDateKey('2026-02-28')).toBe(true)
    expect(isDateKey('2028-02-29')).toBe(true)
    expect(isDateKey('2026-13-01')).toBe(false)
    expect(dismissRequest({}).success).toBe(false)
  })

  it('처리함은 다시 보이지 않고, 원본 주소는 저장된 행에서만 꺼낸다', async () => {
    await syncRequestInbox(true, tick())
    expect(requestUrl('jira:assigned:ICA-1')).toBe('https://acme.atlassian.net/browse/ICA-1')
    expect(requestUrl('없는 id')).toBeNull()
    expect(dismissRequest('jira:assigned:ICA-1')).toEqual({ success: true })
    expect((await syncRequestInbox(true, tick())).items.map((i) => i.id)).not.toContain('jira:assigned:ICA-1')
  })

  it('할 일 제목은 출처를 앞에 붙인다', () => {
    expect(todoTitleFor({ kind: 'assigned', ref: 'ICA-1', title: 'QA' })).toBe('[ICA-1] QA')
    expect(todoTitleFor({ kind: 'mention', ref: 'ICA-2', title: '스킴' })).toBe('[ICA-2] 스킴 댓글 답하기')
    expect(todoTitleFor({ kind: 'review', ref: 'app #3', title: '로그인' })).toBe('[리뷰] app #3 로그인')
  })
})
