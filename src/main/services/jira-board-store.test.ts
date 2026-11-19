import { describe, expect, it, vi } from 'vitest'
import { memoryBoardDb as memoryDb } from './__fixtures__/jira/board-db'
import type { JiraBoardIssue, JiraEpicAiSummary } from './jira-board'
import {
  clearStoredBoards,
  MAX_STORED_EPIC_SUMMARIES,
  parseStoredEpicSummary,
  parseStoredIssueRow,
  readEpicSummary,
  writeEpicSummary,
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

  it('parseStoredIssueRow 는 필드 형식을 검사한다', () => {
    const ok = JSON.stringify(issue('PROJ-1', { labels: ['a'] }))
    expect(parseStoredIssueRow(ok, 'PROJ-1')?.issue.labels).toEqual(['a'])
    expect(parseStoredIssueRow(JSON.stringify({ ...issue('PROJ-1'), labels: [1] }), 'PROJ-1')).toBeNull()
    expect(parseStoredIssueRow(JSON.stringify({ ...issue('PROJ-1'), inScope: 'yes' }), 'PROJ-1')).toBeNull()
    expect(parseStoredIssueRow('null', 'PROJ-1')).toBeNull()
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
    const parsed = parseStoredIssueRow(raw, 'PROJ-1')!.issue
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

const summary = (epicKey: string, over: Partial<JiraEpicAiSummary> = {}): JiraEpicAiSummary => ({
  epicKey,
  headline: `${epicKey} 요약`,
  bullets: ['진행', '남은 일'],
  generatedAt: '2026-11-18T01:00:00.000Z',
  ...over
})

const countSummaries = (db: ReturnType<typeof memoryDb>, projectKey: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM jira_epic_summaries WHERE project_key = ?').get(projectKey) as { n: number }).n

describe('jira-board-store 에픽 AI 요약 (jira_epic_summaries)', () => {
  it('없으면 null, 저장하면 지문과 요약을 그대로 읽는다', () => {
    const db = memoryDb()
    expect(readEpicSummary(db, 'PROJ', 'PROJ-10')).toBeNull()
    writeEpicSummary(db, 'PROJ', 'fp1', summary('PROJ-10'))
    expect(readEpicSummary(db, 'PROJ', 'PROJ-10')).toEqual({ fingerprint: 'fp1', summary: summary('PROJ-10') })
    // 프로젝트 키로 나뉜다
    expect(readEpicSummary(db, 'OTHER', 'PROJ-10')).toBeNull()
  })

  it('같은 에픽은 한 행을 덮어쓴다', () => {
    const db = memoryDb()
    writeEpicSummary(db, 'PROJ', 'fp1', summary('PROJ-10'))
    writeEpicSummary(db, 'PROJ', 'fp2', summary('PROJ-10', { headline: '새', generatedAt: '2026-11-19T00:00:00.000Z' }))
    expect(countSummaries(db, 'PROJ')).toBe(1)
    expect(readEpicSummary(db, 'PROJ', 'PROJ-10')).toMatchObject({ fingerprint: 'fp2', summary: { headline: '새' } })
  })

  it('깨진 JSON·모양이 틀린 행·키가 다른 행은 없는 것으로 본다', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = memoryDb()
    const insert = db.prepare(
      "INSERT INTO jira_epic_summaries (project_key, epic_key, fingerprint, data, generated_at) VALUES ('PROJ', ?, 'fp', ?, 'T')"
    )
    insert.run('PROJ-1', '{깨짐')
    insert.run('PROJ-2', JSON.stringify({ ...summary('PROJ-2'), bullets: [1, 2] }))
    insert.run('PROJ-3', JSON.stringify(summary('PROJ-99')))
    insert.run('PROJ-4', JSON.stringify([summary('PROJ-4')]))
    for (const key of ['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']) expect(readEpicSummary(db, 'PROJ', key)).toBeNull()
    expect(parseStoredEpicSummary(JSON.stringify(summary('PROJ-5')), 'PROJ-5')).toEqual(summary('PROJ-5'))
  })

  it(`프로젝트당 ${MAX_STORED_EPIC_SUMMARIES}행을 넘으면 generated_at 이 오래된 것부터 지운다. 다른 프로젝트는 그대로다`, () => {
    const db = memoryDb()
    writeEpicSummary(db, 'OTHER', 'fp', summary('OTHER-1', { generatedAt: '2020-01-01T00:00:00.000Z' }))
    for (let n = 1; n <= MAX_STORED_EPIC_SUMMARIES + 2; n++) {
      const at = new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString()
      writeEpicSummary(db, 'PROJ', 'fp', summary(`PROJ-${n}`, { generatedAt: at }))
    }
    expect(countSummaries(db, 'PROJ')).toBe(MAX_STORED_EPIC_SUMMARIES)
    expect(readEpicSummary(db, 'PROJ', 'PROJ-1')).toBeNull()
    expect(readEpicSummary(db, 'PROJ', 'PROJ-2')).toBeNull()
    expect(readEpicSummary(db, 'PROJ', 'PROJ-3')).not.toBeNull()
    expect(readEpicSummary(db, 'PROJ', `PROJ-${MAX_STORED_EPIC_SUMMARIES + 2}`)).not.toBeNull()
    expect(countSummaries(db, 'OTHER')).toBe(1)
  })

  it('상한을 넘겨 줄 수 있다(덮어쓴 행은 최신으로 남는다)', () => {
    const db = memoryDb()
    writeEpicSummary(db, 'PROJ', 'fp', summary('PROJ-1', { generatedAt: '2026-11-01T00:00:00.000Z' }), 2)
    writeEpicSummary(db, 'PROJ', 'fp', summary('PROJ-2', { generatedAt: '2026-11-02T00:00:00.000Z' }), 2)
    writeEpicSummary(db, 'PROJ', 'fp', summary('PROJ-1', { generatedAt: '2026-11-03T00:00:00.000Z' }), 2)
    writeEpicSummary(db, 'PROJ', 'fp', summary('PROJ-3', { generatedAt: '2026-11-04T00:00:00.000Z' }), 2)
    const keys = (db.prepare("SELECT epic_key FROM jira_epic_summaries ORDER BY epic_key").all() as { epic_key: string }[]).map((r) => r.epic_key)
    expect(keys).toEqual(['PROJ-1', 'PROJ-3'])
  })

  it('전체 저장은 보드에서 사라진 에픽의 요약만 지운다. 증분 저장은 지우지 않는다', () => {
    const db = memoryDb()
    replaceStoredBoard(db, 'PROJ', [issue('PROJ-1'), issue('PROJ-2')], meta())
    writeEpicSummary(db, 'PROJ', 'fp', summary('PROJ-1'))
    writeEpicSummary(db, 'PROJ', 'fp', summary('PROJ-2'))
    writeEpicSummary(db, 'OTHER', 'fp', summary('OTHER-1'))
    upsertStoredIssues(db, 'PROJ', [issue('PROJ-3')], meta())
    expect(countSummaries(db, 'PROJ')).toBe(2)
    replaceStoredBoard(db, 'PROJ', [issue('PROJ-2')], meta())
    expect(readEpicSummary(db, 'PROJ', 'PROJ-1')).toBeNull()
    expect(readEpicSummary(db, 'PROJ', 'PROJ-2')).not.toBeNull()
    expect(countSummaries(db, 'OTHER')).toBe(1)
  })

  it('비우기는 요약도 모두 지운다', () => {
    const db = memoryDb()
    writeEpicSummary(db, 'PROJ', 'fp', summary('PROJ-1'))
    writeEpicSummary(db, 'OTHER', 'fp', summary('OTHER-1'))
    clearStoredBoards(db)
    expect(db.prepare('SELECT COUNT(*) AS n FROM jira_epic_summaries').get()).toEqual({ n: 0 })
  })
})
