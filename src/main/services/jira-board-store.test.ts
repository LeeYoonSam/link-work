import { describe, expect, it, vi } from 'vitest'
import { memoryBoardDb as memoryDb } from './__fixtures__/jira/board-db'
import type { JiraBoardIssue } from './jira-board'
import {
  clearStoredBoards,
  parseStoredIssue,
  readStoredBoard,
  replaceStoredBoard,
  upsertStoredIssues,
  type StoreWriteMeta
} from './jira-board-store'

function issue(key: string, over: Partial<JiraBoardIssue> = {}): JiraBoardIssue {
  return {
    key,
    summary: `${key} 제목`,
    issueType: '작업',
    level: 'standard',
    status: '진행 중',
    statusCategory: 'indeterminate',
    inScope: true,
    priority: null,
    parentKey: null,
    parentSummary: null,
    assigneeAccountId: null,
    assigneeName: null,
    duedate: null,
    updated: '2026-11-17T10:00:00.000+0900',
    resolvedAt: null,
    labels: [],
    excerpt: null,
    fixVersions: [],
    links: [],
    ...over
  }
}

const meta = (over: Partial<StoreWriteMeta> = {}): StoreWriteMeta => ({
  myAccountId: 'acc-me',
  truncated: false,
  recentDoneDays: 14,
  syncedAt: '2026-11-18T01:00:00.000Z',
  ...over
})

describe('jira-board-store', () => {
  it('동기화 기록이 없으면 null 이다', () => {
    expect(readStoredBoard(memoryDb(), 'PROJ')).toBeNull()
  })

  it('전체 저장은 그 프로젝트 행을 통째로 바꾸고 다른 프로젝트 행은 건드리지 않는다', () => {
    const db = memoryDb()
    replaceStoredBoard(db, 'PROJ', [issue('PROJ-1'), issue('PROJ-2')], meta())
    replaceStoredBoard(db, 'OTHER', [issue('OTHER-1')], meta())
    replaceStoredBoard(db, 'PROJ', [issue('PROJ-2', { summary: '새' }), issue('PROJ-3')], meta({ syncedAt: 'T2', truncated: true }))

    const board = readStoredBoard(db, 'PROJ')
    expect(board?.issues.map((i) => [i.key, i.summary])).toEqual([
      ['PROJ-2', '새'],
      ['PROJ-3', 'PROJ-3 제목']
    ])
    expect(board?.sync).toEqual({
      projectKey: 'PROJ',
      myAccountId: 'acc-me',
      lastFullSyncAt: 'T2',
      lastSyncAt: 'T2',
      truncated: true,
      recentDoneDays: 14
    })
    expect(readStoredBoard(db, 'OTHER')?.issues).toHaveLength(1)
  })

  it('증분 저장은 덮어쓰고 추가하며 순서와 마지막 전체 동기화 시각을 유지한다', () => {
    const db = memoryDb()
    replaceStoredBoard(db, 'PROJ', [issue('PROJ-1'), issue('PROJ-2')], meta({ syncedAt: 'T1' }))
    upsertStoredIssues(db, 'PROJ', [issue('PROJ-1', { status: '완료' }), issue('PROJ-9')], meta({ syncedAt: 'T2' }))

    const board = readStoredBoard(db, 'PROJ')
    expect(board?.issues.map((i) => [i.key, i.status])).toEqual([
      ['PROJ-1', '완료'],
      ['PROJ-2', '진행 중'],
      ['PROJ-9', '진행 중']
    ])
    expect(board?.sync).toMatchObject({ lastFullSyncAt: 'T1', lastSyncAt: 'T2' })
  })

  it('깨진 JSON·모양이 틀린 행·키가 다른 행은 버리고 나머지를 읽는다', () => {
    const db = memoryDb()
    replaceStoredBoard(db, 'PROJ', [issue('PROJ-1')], meta())
    const ins = db.prepare(
      "INSERT INTO jira_board_issues (project_key, issue_key, data, updated, synced_at) VALUES ('PROJ', ?, ?, 'x', 'x')"
    )
    ins.run('PROJ-2', '{깨짐')
    ins.run('PROJ-3', JSON.stringify({ ...issue('PROJ-3'), level: 'weird' }))
    ins.run('PROJ-4', JSON.stringify(issue('PROJ-5')))
    ins.run('PROJ-6', JSON.stringify([1, 2]))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(readStoredBoard(db, 'PROJ')?.issues.map((i) => i.key)).toEqual(['PROJ-1'])
    spy.mockRestore()
  })

  it('parseStoredIssue 는 필드 형식을 검사한다', () => {
    const ok = JSON.stringify(issue('PROJ-1', { labels: ['a'] }))
    expect(parseStoredIssue(ok, 'PROJ-1')?.labels).toEqual(['a'])
    expect(parseStoredIssue(JSON.stringify({ ...issue('PROJ-1'), labels: [1] }), 'PROJ-1')).toBeNull()
    expect(parseStoredIssue(JSON.stringify({ ...issue('PROJ-1'), inScope: 'yes' }), 'PROJ-1')).toBeNull()
    expect(parseStoredIssue('null', 'PROJ-1')).toBeNull()
  })

  it('links·fixVersions 가 없는 옛 행은 빈 배열로 채우고 legacyRows 로 센다', () => {
    const db = memoryDb()
    replaceStoredBoard(db, 'PROJ', [issue('PROJ-1')], meta())
    const { links: _l, fixVersions: _f, ...old } = issue('PROJ-2')
    db.prepare(
      "INSERT INTO jira_board_issues (project_key, issue_key, data, updated, synced_at) VALUES ('PROJ', 'PROJ-2', ?, 'x', 'x')"
    ).run(JSON.stringify(old))

    const board = readStoredBoard(db, 'PROJ')!
    expect(board.legacyRows).toBe(1)
    expect(board.issues[1]).toMatchObject({ key: 'PROJ-2', links: [], fixVersions: [] })
  })

  it('모양이 틀리거나 http(s)가 아닌 링크·fixVersion 항목은 그 항목만 버린다', () => {
    const raw = JSON.stringify({
      ...issue('PROJ-1'),
      fixVersions: [{ id: '1', name: '4.0' }, { id: 2 }, null],
      links: [
        { kind: 'web', title: '좋음', url: 'https://example.com', source: 'example.com' },
        { kind: 'web', title: '나쁨', url: 'javascript:alert(1)', source: 'x' },
        { kind: 'weird', title: 't', url: 'https://a.b', source: 's' },
        { kind: 'attachment', title: '첨부', url: 'https://a.b/c', source: '첨부', size: 3, mimeType: null, createdAt: 'T' },
        'nope'
      ]
    })
    const parsed = parseStoredIssue(raw, 'PROJ-1')!
    expect(parsed.fixVersions).toEqual([{ id: '1', name: '4.0' }])
    expect(parsed.links).toEqual([
      { kind: 'web', title: '좋음', url: 'https://example.com', source: 'example.com' },
      { kind: 'attachment', title: '첨부', url: 'https://a.b/c', source: '첨부', size: 3, mimeType: null, createdAt: 'T' }
    ])
  })

  it('비우기는 두 테이블의 모든 행을 지운다', () => {
    const db = memoryDb()
    replaceStoredBoard(db, 'PROJ', [issue('PROJ-1')], meta())
    replaceStoredBoard(db, 'OTHER', [issue('OTHER-1')], meta())
    clearStoredBoards(db)
    expect(readStoredBoard(db, 'PROJ')).toBeNull()
    expect(readStoredBoard(db, 'OTHER')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM jira_board_issues').get()).toEqual({ n: 0 })
  })

  it('쓰기 중 오류가 나면 트랜잭션을 되돌려 이전 저장본을 남긴다', () => {
    const db = memoryDb()
    replaceStoredBoard(db, 'PROJ', [issue('PROJ-1')], meta())
    const bad = { ...issue('PROJ-2'), updated: null } as unknown as JiraBoardIssue
    expect(() => replaceStoredBoard(db, 'PROJ', [issue('PROJ-3'), bad], meta())).toThrow()
    expect(readStoredBoard(db, 'PROJ')?.issues.map((i) => i.key)).toEqual(['PROJ-1'])
  })
})
