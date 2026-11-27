import { describe, expect, it } from 'vitest'
import { memoryInboxDb } from './__fixtures__/inbox/inbox-db'
import {
  getRequest,
  listOpenRequests,
  markRequest,
  mergeFetchedRequests,
  pruneHandledRequests,
  type FetchedRequest
} from './request-inbox-store'

function req(id: string, over: Partial<FetchedRequest> = {}): FetchedRequest {
  return {
    id,
    source: 'jira',
    kind: 'assigned',
    title: `${id} 제목`,
    ref: 'ICA-1',
    actor: null,
    excerpt: null,
    url: `https://acme.atlassian.net/browse/${id}`,
    requestedAt: null,
    ...over
  }
}

const T1 = '2026-11-27T01:00:00.000Z'
const T2 = '2026-11-27T02:00:00.000Z'

describe('request-inbox-store', () => {
  it('새 요청은 open 으로 넣고 새로 넣은 건수를 돌려준다', () => {
    const db = memoryInboxDb()
    expect(mergeFetchedRequests(db, 'jira', [req('a'), req('b')], true, T1)).toBe(2)
    expect(mergeFetchedRequests(db, 'jira', [req('a'), req('b')], true, T2)).toBe(0)
    expect(listOpenRequests(db).map((r) => r.id).sort()).toEqual(['a', 'b'])
  })

  it('할 일로 바꾸거나 처리한 요청은 다시 잡혀도 보이지 않고, 내용과 last_seen 만 갱신된다', () => {
    const db = memoryInboxDb()
    mergeFetchedRequests(db, 'jira', [req('a'), req('b')], true, T1)
    expect(markRequest(db, 'a', 'todo', 7)).toBe(true)
    expect(markRequest(db, 'b', 'dismissed', null)).toBe(true)
    // 이미 처리한 요청은 다시 바꾸지 않는다
    expect(markRequest(db, 'a', 'dismissed', null)).toBe(false)
    mergeFetchedRequests(db, 'jira', [req('a', { title: '바뀐 제목' }), req('b')], true, T2)
    expect(listOpenRequests(db)).toEqual([])
    expect(getRequest(db, 'a')).toMatchObject({ state: 'todo', title: '바뀐 제목' })
  })

  it('조회가 끝까지 성공했을 때만 사라진 open 요청을 지운다. 처리한 행과 다른 원본은 남긴다', () => {
    const db = memoryInboxDb()
    mergeFetchedRequests(db, 'jira', [req('a'), req('b'), req('c')], true, T1)
    mergeFetchedRequests(db, 'bitbucket', [req('pr', { source: 'bitbucket', kind: 'review' })], true, T1)
    markRequest(db, 'c', 'dismissed', null)

    // 잘린 조회: 지우지 않는다
    mergeFetchedRequests(db, 'jira', [req('a')], false, T2)
    expect(listOpenRequests(db).map((r) => r.id).sort()).toEqual(['a', 'b', 'pr'])

    mergeFetchedRequests(db, 'jira', [req('a')], true, T2)
    expect(listOpenRequests(db).map((r) => r.id).sort()).toEqual(['a', 'pr'])
    expect(getRequest(db, 'c')?.state).toBe('dismissed')
  })

  it('다른 원본의 행은 이 원본의 결과로 넣지 않는다', () => {
    const db = memoryInboxDb()
    mergeFetchedRequests(db, 'jira', [req('pr', { source: 'bitbucket' })], true, T1)
    expect(listOpenRequests(db)).toEqual([])
  })

  it('요청 시각(없으면 처음 본 시각) 최신순으로 보인다', () => {
    const db = memoryInboxDb()
    mergeFetchedRequests(db, 'jira', [req('old', { requestedAt: '2026-11-20T00:00:00.000Z' })], true, T1)
    mergeFetchedRequests(
      db,
      'bitbucket',
      [req('new', { source: 'bitbucket', kind: 'review', requestedAt: '2026-11-26T00:00:00.000Z' })],
      true,
      T1
    )
    // requestedAt 이 없으면 처음 본 시각(T1)
    mergeFetchedRequests(db, 'jira', [req('old', { requestedAt: '2026-11-20T00:00:00.000Z' }), req('seen')], true, T1)
    expect(listOpenRequests(db).map((r) => r.id)).toEqual(['seen', 'new', 'old'])
  })

  it('보일 원본을 고르면 다른 원본의 open 행은 보이지 않는다', () => {
    const db = memoryInboxDb()
    mergeFetchedRequests(db, 'jira', [req('a')], true, T1)
    mergeFetchedRequests(db, 'bitbucket', [req('pr', { source: 'bitbucket', kind: 'review' })], true, T1)
    expect(listOpenRequests(db, ['bitbucket']).map((r) => r.id)).toEqual(['pr'])
    expect(listOpenRequests(db, []).map((r) => r.id)).toEqual([])
  })

  it('한 원본에서 마지막으로 잡힌 지 30일 지난 처리 행만 지운다', () => {
    const db = memoryInboxDb()
    mergeFetchedRequests(db, 'jira', [req('a'), req('b'), req('c')], true, '2026-10-01T00:00:00.000Z')
    markRequest(db, 'a', 'dismissed', null)
    markRequest(db, 'b', 'todo', 1)
    mergeFetchedRequests(db, 'jira', [req('b'), req('c')], false, '2026-11-20T00:00:00.000Z')
    mergeFetchedRequests(db, 'bitbucket', [req('pr', { source: 'bitbucket', kind: 'review' })], true, '2026-10-01T00:00:00.000Z')
    markRequest(db, 'pr', 'dismissed', null)
    pruneHandledRequests(db, new Date('2026-11-27T00:00:00.000Z'), 'jira')
    expect(getRequest(db, 'a')).toBeNull()
    // 다른 원본은 건드리지 않는다
    expect(getRequest(db, 'pr')?.state).toBe('dismissed')
    expect(getRequest(db, 'b')?.state).toBe('todo')
    // open 행은 기간과 무관하게 남는다(사라졌는지는 merge 가 판단한다)
    expect(getRequest(db, 'c')?.state).toBe('open')
  })
})
