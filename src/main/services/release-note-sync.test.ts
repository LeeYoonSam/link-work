import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3는 electron-builder가 Electron ABI로 빌드해 두므로 vitest가 도는 Node에서는
// 네이티브 모듈을 로드할 수 없다(NODE_MODULE_VERSION 불일치). Node용으로 재빌드하면 앱이 깨지기
// 때문에, 테스트에서만 Node 내장 node:sqlite로 갈아끼운다. SQLite 엔진은 같으므로
// initDatabase()의 **실제 스키마**를 그대로 돌려 검증할 수 있다(DDL을 테스트에 복사하지 않는다).
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  type Args = unknown[]

  class BetterSqlite3Shim {
    private readonly db: InstanceType<typeof DatabaseSync>

    constructor() {
      // 경로는 무시하고 항상 인메모리로 연다 — 테스트가 디스크에 파일을 남기지 않게.
      this.db = new DatabaseSync(':memory:')
    }

    pragma(statement: string): void {
      this.db.exec(`PRAGMA ${statement}`)
    }

    exec(sql: string): void {
      this.db.exec(sql)
    }

    prepare(sql: string): unknown {
      return this.db.prepare(sql)
    }

    // node:sqlite에는 transaction 헬퍼가 없어 better-sqlite3와 같은 의미(실패 시 롤백)로 감싼다.
    transaction<T>(fn: (...args: Args) => T): (...args: Args) => T {
      return (...args: Args): T => {
        this.db.exec('BEGIN')
        try {
          const result = fn(...args)
          this.db.exec('COMMIT')
          return result
        } catch (e) {
          this.db.exec('ROLLBACK')
          throw e
        }
      }
    }

    close(): void {
      this.db.close()
    }
  }

  return { default: BetterSqlite3Shim }
})

vi.mock('electron', () => ({
  // 위 shim이 경로를 쓰지 않으므로 값 자체는 의미가 없다.
  app: { getPath: () => '/linkwork-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))

// Jira REST는 전부 대체한다. 여기서 검증할 것은 "조회 결과를 DB에 어떻게 반영하느냐"뿐이다.
const jira = vi.hoisted(() => ({
  getJiraVersion: vi.fn(),
  listIssuesByFixVersion: vi.fn(),
  getJiraIssueUrl: vi.fn(),
  listJiraVersions: vi.fn(),
  getDefaultJiraProjectKey: vi.fn(),
  listUpdatedReleaseIssues: vi.fn(),
  MAX_UPDATED_MINUTES: 7 * 24 * 60 + 10
}))
vi.mock('./jira', () => jira)

import {
  closeDatabase,
  getDatabase,
  initDatabase,
  migrateReleaseNotesDropProject
} from '../db/database'
import type { JiraIssueSummary, JiraReleaseChangeIssue, JiraVersionSummary } from './jira'
import {
  MAX_ISSUE_FETCH_PER_SYNC,
  RELEASE_SYNC_CHECKED_KEY,
  clearReleaseSyncCheckpoint,
  getReleaseNote,
  linkReleaseNote,
  listReleaseNotes,
  planReleaseChanges,
  syncAllReleases,
  syncReleaseChanges,
  syncReleaseNote
} from './release-note-sync'

function versionOf(overrides: Partial<JiraVersionSummary> = {}): JiraVersionSummary {
  return {
    id: '10042',
    name: 'v1.2.0',
    description: '검색 개편',
    released: false,
    archived: false,
    releaseDate: '2026-09-01',
    startDate: null,
    ...overrides
  }
}

function issueOf(key: string, overrides: Partial<JiraIssueSummary> = {}): JiraIssueSummary {
  return {
    key,
    issueType: 'Story',
    status: '완료',
    resolution: '해결됨',
    summary: `${key} 요약`,
    parentKey: null,
    ...overrides
  }
}

function seedProject(name: string, deployVersion?: string): number {
  const result = getDatabase()
    .prepare(
      `INSERT INTO projects (name, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date, deploy_version)
       VALUES (?, '2026-08-01', '2026-08-20', '2026-08-21', '2026-08-25', '2026-09-01', ?)`
    )
    .run(name, deployVersion ?? null)
  return Number(result.lastInsertRowid)
}

/** 기본 프로젝트 키 + 버전 목록을 세팅하고, 단건 조회도 같은 목록에서 답하게 한다 */
function mockJira(versions: JiraVersionSummary[], defaultKey: string | null = 'PROJ'): void {
  jira.getDefaultJiraProjectKey.mockReturnValue(defaultKey)
  jira.listJiraVersions.mockResolvedValue(versions)
  jira.getJiraVersion.mockImplementation(async (versionId: string) => {
    const found = versions.find((v) => v.id === versionId)
    if (!found) throw new Error('Jira에서 프로젝트 또는 버전을 찾을 수 없습니다.')
    return found
  })
  jira.listIssuesByFixVersion.mockResolvedValue({ issues: [issueOf('PROJ-1')], truncated: false })
}

/** 릴리스 노트 한 건을 만들고 노트 id를 돌려준다 */
function seedNote(): number {
  return linkReleaseNote('PROJ', versionOf()).id
}

/** 동기화 실패 상황을 만들기 위해 항목을 미리 채워 둔다 */
function seedItems(noteId: number, keys: string[]): void {
  const db = getDatabase()
  const insert = db.prepare(
    `INSERT INTO release_note_items
       (release_note_id, issue_key, issue_type, summary, sort_order)
     VALUES (?, ?, 'Story', ?, ?)`
  )
  keys.forEach((key, i) => insert.run(noteId, key, `${key} 기존 요약`, i))
}

afterAll(() => {
  closeDatabase()
})

beforeEach(() => {
  // 인메모리라 닫고 다시 열면 그대로 빈 DB가 된다 — 테스트 간 상태가 새지 않는다.
  closeDatabase()
  initDatabase()
  jira.getJiraVersion.mockReset()
  jira.listIssuesByFixVersion.mockReset()
  jira.listJiraVersions.mockReset()
  jira.getDefaultJiraProjectKey.mockReset()
  jira.listUpdatedReleaseIssues.mockReset()
})

describe('linkReleaseNote', () => {
  it('가져온 릴리스가 Jira 메타 그대로 저장된다', () => {
    const id = seedNote()
    const note = getReleaseNote(id)!
    expect({
      key: note.jira_project_key,
      versionId: note.jira_version_id,
      name: note.version_name,
      released: note.released,
      releaseDate: note.release_date
    }).toEqual({
      key: 'PROJ',
      versionId: '10042',
      name: 'v1.2.0',
      released: 0,
      releaseDate: '2026-09-01'
    })
    // 릴리스 노트는 Jira 릴리스의 미러라 LinkWork 프로젝트를 가리키는 칸이 아예 없다
    expect(Object.keys(note)).not.toContain('project_id')
  })

  it('같은 Jira 버전을 두 번 가져올 수 없다', () => {
    seedNote()
    expect(() => linkReleaseNote('PROJ', versionOf())).toThrow('이미 목록에 있는 Jira 릴리스입니다.')
    const count = getDatabase().prepare('SELECT COUNT(*) AS c FROM release_notes').get() as {
      c: number
    }
    expect(count.c).toBe(1)
  })

  it('버전 ID가 다르면 따로 저장된다', () => {
    seedNote()
    linkReleaseNote('PROJ', versionOf({ id: '10043', name: 'v1.3.0' }))
    expect(listReleaseNotes()).toHaveLength(2)
  })
})

describe('syncReleaseNote — 실패해도 기존 항목을 보존한다', () => {
  it('이슈 조회가 실패하면 기존 항목이 그대로 남는다', async () => {
    const id = seedNote()
    seedItems(id, ['PROJ-1', 'PROJ-2', 'PROJ-3'])

    jira.getJiraVersion.mockResolvedValue(versionOf())
    jira.listIssuesByFixVersion.mockRejectedValue(
      new Error('Jira 토큰이 만료됐거나 유효하지 않습니다.')
    )

    await expect(syncReleaseNote(id)).rejects.toThrow('만료')

    const note = getReleaseNote(id)!
    expect(note.items.map((i) => i.issue_key)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3'])
  })

  it('버전 메타 조회가 실패해도 기존 항목이 그대로 남는다', async () => {
    const id = seedNote()
    seedItems(id, ['PROJ-1', 'PROJ-2'])

    jira.getJiraVersion.mockRejectedValue(new Error('Jira에서 프로젝트 또는 버전을 찾을 수 없습니다.'))
    jira.listIssuesByFixVersion.mockResolvedValue({ issues: [], truncated: false })

    await expect(syncReleaseNote(id)).rejects.toThrow('찾을 수 없습니다')

    const note = getReleaseNote(id)!
    expect(note.items.map((i) => i.issue_key)).toEqual(['PROJ-1', 'PROJ-2'])
    // 버전 조회가 먼저 실패했으므로 이슈 조회까지 가지 않는다
    expect(jira.listIssuesByFixVersion).not.toHaveBeenCalled()
  })

  it('실패하면 last_synced_at은 그대로고 last_sync_error에 사유가 남는다', async () => {
    const id = seedNote()
    getDatabase()
      .prepare("UPDATE release_notes SET last_synced_at = '2026-08-01 09:00:00' WHERE id = ?")
      .run(id)

    jira.getJiraVersion.mockResolvedValue(versionOf())
    jira.listIssuesByFixVersion.mockRejectedValue(new Error('Jira API 요청 한도에 도달했습니다.'))

    await expect(syncReleaseNote(id)).rejects.toThrow('한도')

    const note = getReleaseNote(id)!
    expect(note.last_synced_at).toBe('2026-08-01 09:00:00')
    expect(note.last_sync_error).toBe('Jira API 요청 한도에 도달했습니다.')
  })

  it('없는 릴리스 노트를 동기화하면 Jira를 호출하지 않고 throw한다', async () => {
    await expect(syncReleaseNote(9999)).rejects.toThrow('찾을 수 없습니다')
    expect(jira.getJiraVersion).not.toHaveBeenCalled()
  })
})

describe('syncReleaseNote — 성공 경로', () => {
  it('항목이 전체 교체되고 이전 항목은 하나도 남지 않는다', async () => {
    const id = seedNote()
    seedItems(id, ['PROJ-1', 'PROJ-2', 'PROJ-3'])

    jira.getJiraVersion.mockResolvedValue(versionOf({ name: 'v1.2.1', released: true }))
    jira.listIssuesByFixVersion.mockResolvedValue({
      issues: [issueOf('PROJ-7'), issueOf('PROJ-8', { issueType: 'Bug' })],
      truncated: false
    })

    const result = await syncReleaseNote(id)
    expect(result).toEqual({ itemCount: 2, truncated: false })

    const note = getReleaseNote(id)!
    expect(note.items.map((i) => i.issue_key)).toEqual(['PROJ-7', 'PROJ-8'])
    // 버전 메타도 Jira 값으로 갱신된다 (이름이 바뀌어도 ID로 연결돼 있어 따라간다)
    expect(note.version_name).toBe('v1.2.1')
    expect(note.released).toBe(1)
    expect(note.last_synced_at).not.toBeNull()
    expect(note.last_sync_error).toBeNull()
  })

  it('sort_order가 Jira가 준 순서대로 0..n-1로 매겨진다', async () => {
    const id = seedNote()
    jira.getJiraVersion.mockResolvedValue(versionOf())
    jira.listIssuesByFixVersion.mockResolvedValue({
      issues: [
        issueOf('PROJ-30'),
        issueOf('PROJ-11', { issueType: 'Bug' }),
        issueOf('PROJ-22', { parentKey: 'PROJ-30' })
      ],
      truncated: false
    })

    await syncReleaseNote(id)

    const items = getReleaseNote(id)!.items
    expect(items.map((i) => [i.issue_key, i.sort_order])).toEqual([
      ['PROJ-30', 0],
      ['PROJ-11', 1],
      ['PROJ-22', 2]
    ])
    expect(items[2].parent_key).toBe('PROJ-30')
  })

  it('0건 결과도 정상으로 반영하고 itemCount 0을 돌려준다', async () => {
    const id = seedNote()
    seedItems(id, ['PROJ-1'])

    jira.getJiraVersion.mockResolvedValue(versionOf())
    jira.listIssuesByFixVersion.mockResolvedValue({ issues: [], truncated: false })

    const result = await syncReleaseNote(id)
    // 0건은 실패가 아니다 — 아직 릴리스에 이슈를 붙이지 않았을 수 있다.
    expect(result).toEqual({ itemCount: 0, truncated: false })

    const note = getReleaseNote(id)!
    expect(note.items).toEqual([])
    expect(note.last_synced_at).not.toBeNull()
    expect(note.last_sync_error).toBeNull()
  })

  it('직전 실패 사유는 성공하면 지워진다', async () => {
    const id = seedNote()
    jira.getJiraVersion.mockResolvedValue(versionOf())
    jira.listIssuesByFixVersion.mockRejectedValueOnce(new Error('네트워크 오류'))
    await expect(syncReleaseNote(id)).rejects.toThrow('네트워크')
    expect(getReleaseNote(id)!.last_sync_error).toBe('네트워크 오류')

    jira.listIssuesByFixVersion.mockResolvedValue({ issues: [issueOf('PROJ-9')], truncated: false })
    await syncReleaseNote(id)
    expect(getReleaseNote(id)!.last_sync_error).toBeNull()
  })

  it('500건 상한에 걸린 경우 truncated를 그대로 전달한다', async () => {
    const id = seedNote()
    jira.getJiraVersion.mockResolvedValue(versionOf())
    jira.listIssuesByFixVersion.mockResolvedValue({
      issues: [issueOf('PROJ-1'), issueOf('PROJ-2')],
      truncated: true
    })

    const result = await syncReleaseNote(id)
    expect(result.truncated).toBe(true)
  })
})

describe('listReleaseNotes', () => {
  it('목록에 항목 수가 함께 나온다', async () => {
    const id = seedNote()
    mockJira([versionOf()])
    jira.listIssuesByFixVersion.mockResolvedValue({
      issues: [issueOf('PROJ-1'), issueOf('PROJ-2')],
      truncated: false
    })

    await syncReleaseNote(id)

    const notes = listReleaseNotes()
    expect(notes).toHaveLength(1)
    expect(notes[0].item_count).toBe(2)
  })

  it('버전 번호 내림차순으로 세운다', () => {
    // 사전순이면 4.46.0이 4.166.0보다 커서 낮은 버전이 꼭대기에 앉는다
    linkReleaseNote('PROJ', versionOf({ id: '1', name: '4.46.0' }))
    linkReleaseNote('PROJ', versionOf({ id: '2', name: '4.166.0' }))
    linkReleaseNote('PROJ', versionOf({ id: '3', name: '4.100.0' }))

    expect(listReleaseNotes().map((n) => n.version_name)).toEqual([
      '4.166.0',
      '4.100.0',
      '4.46.0'
    ])
  })

  it('릴리스일이 없어도 버전 번호로 제자리에 선다', () => {
    // 화면 꼭대기에 앉아 있던 4.46.0이 이 경우다 — 릴리스일이 비었다고 목록 맨 위로 튀면 안 된다.
    const v = (id: string, name: string, releaseDate: string | null): void => {
      linkReleaseNote('PROJ', versionOf({ id, name, releaseDate }))
    }
    v('1', '4.166.0', '2026-09-08')
    v('2', '4.46.0', null)
    v('3', '4.100.0', '2026-01-01')

    expect(listReleaseNotes().map((n) => n.version_name)).toEqual([
      '4.166.0',
      '4.100.0',
      '4.46.0'
    ])
  })

  it('배포 버전을 주면 이름이 같은 릴리스만 돌려준다', () => {
    linkReleaseNote('PROJ', versionOf({ id: '1', name: '4.164.0' }))
    linkReleaseNote('PROJ', versionOf({ id: '2', name: '4.155.0' }))

    expect(listReleaseNotes('4.155.0').map((n) => n.version_name)).toEqual(['4.155.0'])
    expect(listReleaseNotes('9.9.9')).toEqual([])
  })

  it('배포 버전 한 칸에 여러 버전이 적혀 있어도 각각 찾는다', () => {
    // 실제 데이터의 '2.8.1 , 4.155.0' — 통째로 비교하면 어느 쪽과도 맞지 않았다
    linkReleaseNote('PROJ', versionOf({ id: '1', name: '4.155.0' }))
    linkReleaseNote('PROJ', versionOf({ id: '2', name: '2.8.1' }))
    linkReleaseNote('PROJ', versionOf({ id: '3', name: '4.164.0' }))

    expect(listReleaseNotes('2.8.1 , 4.155.0').map((n) => n.version_name)).toEqual([
      '4.155.0',
      '2.8.1'
    ])
  })

  it('같은 배포 버전을 쓰는 프로젝트가 여럿이어도 릴리스는 한 줄이다', () => {
    // 이 파일의 핵심 — 예전에는 프로젝트마다 한 행을 만들어 같은 버전이 목록에 세 번 떴다
    seedProject('가 프로젝트', '4.155.0')
    seedProject('나 프로젝트', '4.155.0')
    seedProject('다 프로젝트', '4.155.0')
    linkReleaseNote('PROJ', versionOf({ id: '1', name: '4.155.0' }))

    expect(listReleaseNotes()).toHaveLength(1)
    expect(listReleaseNotes('4.155.0')).toHaveLength(1)
  })

  it('프로젝트를 지워도 릴리스 노트는 남는다 — 프로젝트에 딸린 데이터가 아니다', () => {
    const projectId = seedProject('가 프로젝트', '4.155.0')
    const id = linkReleaseNote('PROJ', versionOf({ id: '1', name: '4.155.0' })).id
    seedItems(id, ['PROJ-1'])

    getDatabase().prepare('DELETE FROM projects WHERE id = ?').run(projectId)

    expect(listReleaseNotes()).toHaveLength(1)
    expect(getReleaseNote(id)!.items).toHaveLength(1)
  })
})

describe('syncAllReleases — Jira 릴리스 전체를 가져온다', () => {
  const V_164 = versionOf({ id: '100', name: '4.164.0', releaseDate: '2026-08-25' })
  const V_163 = versionOf({ id: '101', name: '4.163.0', releaseDate: '2026-08-20' })

  it('Jira의 릴리스를 모두 가져와 동기화한다', async () => {
    mockJira([V_164, V_163])

    const result = await syncAllReleases()

    expect(result.synced.map((s) => [s.version, s.itemCount])).toEqual([
      ['4.164.0', 1],
      ['4.163.0', 1]
    ])
    const note = listReleaseNotes()[0]
    expect(note.jira_version_id).toBe('100')
    expect(note.jira_project_key).toBe('PROJ')
    expect(note.last_synced_at).not.toBeNull()
    expect(getReleaseNote(note.id)!.items.map((i) => i.issue_key)).toEqual(['PROJ-1'])
  })

  it('LinkWork 프로젝트를 전혀 보지 않는다 — 프로젝트가 없어도 다 가져온다', async () => {
    mockJira([V_164, V_163])

    await syncAllReleases()

    expect(listReleaseNotes().map((n) => n.version_name)).toEqual(['4.164.0', '4.163.0'])
  })

  it('같은 배포 버전의 프로젝트가 여럿이어도 릴리스는 한 줄만 만든다', async () => {
    seedProject('가 프로젝트', '4.164.0')
    seedProject('나 프로젝트', '4.164.0')
    mockJira([V_164])

    await syncAllReleases()

    expect(listReleaseNotes()).toHaveLength(1)
  })

  it('다시 동기화해도 중복으로 생기지 않는다', async () => {
    mockJira([V_164])

    await syncAllReleases()
    const firstId = listReleaseNotes()[0].id
    const second = await syncAllReleases()

    expect(listReleaseNotes()).toHaveLength(1)
    expect(listReleaseNotes()[0].id).toBe(firstId)
    expect(second.synced).toHaveLength(1)
  })

  it('Jira에서 보관한 릴리스는 새로 가져오지 않는다', async () => {
    mockJira([versionOf({ id: '200', name: '4.100.0', archived: true })])

    const result = await syncAllReleases()

    expect(listReleaseNotes()).toEqual([])
    expect(result.synced).toEqual([])
  })

  it('한 릴리스가 실패해도 나머지는 계속 진행되고 failed에 사유가 담긴다', async () => {
    mockJira([V_164, V_163])
    jira.listIssuesByFixVersion.mockImplementation(async (versionId: string) => {
      if (versionId === '101') throw new Error('해당 Jira 프로젝트에 접근할 권한이 없습니다.')
      return { issues: [issueOf('PROJ-1')], truncated: false }
    })

    const result = await syncAllReleases()

    expect(result.synced.map((s) => s.version)).toEqual(['4.164.0'])
    expect(result.failed).toEqual([
      {
        version: '4.163.0',
        error: '해당 Jira 프로젝트에 접근할 권한이 없습니다.'
      }
    ])
    // 실패한 쪽도 릴리스와 실패 사유는 남아 사용자가 원인을 볼 수 있어야 한다.
    const failed = listReleaseNotes().find((n) => n.version_name === '4.163.0')!
    expect(failed.last_sync_error).toBe('해당 Jira 프로젝트에 접근할 권한이 없습니다.')
    expect(failed.last_synced_at).toBeNull()
  })

  it('버전이 높은 것부터 상한까지만 이슈를 받고 나머지는 metaOnly로 미룬다', async () => {
    const many = Array.from({ length: MAX_ISSUE_FETCH_PER_SYNC + 3 }, (_, i) =>
      versionOf({ id: String(500 + i), name: `9.${100 - i}.0` })
    )
    mockJira(many)

    const result = await syncAllReleases()

    expect(result.synced).toHaveLength(MAX_ISSUE_FETCH_PER_SYNC)
    expect(result.metaOnly).toHaveLength(3)
    // 미룬 것도 목록에는 들어간다 — 릴리스 자체가 빠지면 원래 문제로 돌아간다
    expect(listReleaseNotes()).toHaveLength(MAX_ISSUE_FETCH_PER_SYNC + 3)
    // 이슈를 미룬 릴리스는 "아직 동기화하지 않았습니다" 상태로 남아 개별 동기화가 가능하다
    const pending = listReleaseNotes().filter((n) => n.last_synced_at === null)
    expect(pending.map((n) => n.version_name)).toEqual(result.metaOnly.map((m) => m.version))
    // 미룬 것은 버전이 가장 낮은 쪽이어야 한다
    expect(result.synced[0].version).toBe('9.100.0')
  })

  it('상한은 다시 실행해도 같다 — 받아 둔 릴리스가 쌓여도 느려지지 않는다', async () => {
    const many = Array.from({ length: MAX_ISSUE_FETCH_PER_SYNC + 2 }, (_, i) =>
      versionOf({ id: String(800 + i), name: `8.${100 - i}.0` })
    )
    mockJira(many)

    await syncAllReleases()
    jira.listIssuesByFixVersion.mockClear()
    const second = await syncAllReleases()

    expect(second.synced).toHaveLength(MAX_ISSUE_FETCH_PER_SYNC)
    expect(second.metaOnly).toHaveLength(2)
    expect(jira.listIssuesByFixVersion).toHaveBeenCalledTimes(MAX_ISSUE_FETCH_PER_SYNC)
  })

  it('기본 프로젝트가 설정되지 않았으면 네트워크를 타지 않고 throw한다', async () => {
    mockJira([V_164], null)

    await expect(syncAllReleases()).rejects.toThrow('기본 프로젝트가 설정되지 않았습니다')
    expect(jira.listJiraVersions).not.toHaveBeenCalled()
  })

  it('버전 목록은 릴리스 수와 무관하게 1회만 조회한다', async () => {
    mockJira([V_164, V_163])

    await syncAllReleases()

    expect(jira.listJiraVersions).toHaveBeenCalledTimes(1)
  })

  it('활동 로그는 릴리스별이 아니라 전체 1건으로만 남는다', async () => {
    mockJira([V_164, V_163])

    await syncAllReleases()

    const logs = getDatabase()
      .prepare("SELECT entity_name, details FROM activity_log WHERE entity_type = 'release_note'")
      .all() as { entity_name: string; details: string }[]
    expect(logs).toHaveLength(1)
    expect(logs[0].entity_name).toContain('일괄 동기화')
    expect(logs[0].details).toContain('동기화 2건')
  })

  it('linked 는 이번 실행에서 새로 목록에 넣은 릴리스 수다', async () => {
    mockJira([V_164])
    const first = await syncAllReleases()
    expect(first.linked).toBe(1)

    mockJira([V_164, V_163])
    const second = await syncAllReleases()
    // 4.164.0 은 이미 있으므로 새로 들어온 것은 4.163.0 하나다
    expect(second.linked).toBe(1)
    expect(second.synced).toHaveLength(2)

    const third = await syncAllReleases()
    expect(third).toEqual({
      synced: [
        { noteId: expect.any(Number), version: '4.164.0', itemCount: 1 },
        { noteId: expect.any(Number), version: '4.163.0', itemCount: 1 }
      ],
      metaOnly: [],
      failed: [],
      linked: 0
    })
  })

  it('동시에 두 번 부르면 같은 실행을 공유해 버전 목록을 1번만 조회한다', async () => {
    mockJira([V_164, V_163])

    const [a, b] = await Promise.all([syncAllReleases(), syncAllReleases()])

    expect(jira.listJiraVersions).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(a.linked).toBe(2)
    expect(a.failed).toEqual([])
    expect(listReleaseNotes()).toHaveLength(2)
  })

  it('실행이 끝나면 공유를 비워 다음 호출은 새로 조회한다 (실패해도 같다)', async () => {
    mockJira([V_164])
    jira.listJiraVersions.mockRejectedValueOnce(new Error('네트워크 오류'))

    await expect(syncAllReleases()).rejects.toThrow('네트워크 오류')
    const next = await syncAllReleases()

    expect(jira.listJiraVersions).toHaveBeenCalledTimes(2)
    expect(next.linked).toBe(1)
  })
})

// ── 변경분 동기화 (syncReleaseChanges) ──

function changeOf(
  key: string,
  fixVersionIds: string[],
  overrides: Partial<JiraIssueSummary> = {}
): JiraReleaseChangeIssue {
  return { ...issueOf(key), ...overrides, fixVersionIds }
}

describe('planReleaseChanges — 변경분 계획(순수)', () => {
  const target = (noteId: number, versionId: string, keys: string[]) => ({
    noteId,
    versionId,
    items: keys.map((k) => ({
      issue_key: k,
      issue_type: 'Story',
      status: '완료',
      resolution: '해결됨',
      summary: `${k} 요약`,
      parent_key: null
    }))
  })

  it('값이 같은 항목은 넣지 않고, 바뀌었거나 없는 항목만 upsert 한다', () => {
    const plans = planReleaseChanges(
      [changeOf('A-1', ['100']), changeOf('A-2', ['100'], { status: '진행 중' }), changeOf('A-3', ['100'])],
      [target(1, '100', ['A-1', 'A-2'])]
    )
    expect(plans).toEqual([
      { noteId: 1, upserts: [issueOf('A-2', { status: '진행 중' }), issueOf('A-3')], removes: [] }
    ])
  })

  it('다른 버전으로 옮기면 원래 릴리스에서 지우고 새 릴리스에 넣는다. fixVersion 이 비면 지운다', () => {
    const plans = planReleaseChanges(
      [changeOf('A-1', ['200']), changeOf('A-2', [])],
      [target(1, '100', ['A-1', 'A-2']), target(2, '200', [])]
    )
    expect(plans).toEqual([
      { noteId: 1, upserts: [], removes: ['A-1', 'A-2'] },
      { noteId: 2, upserts: [issueOf('A-1')], removes: [] }
    ])
  })

  it('같은 키가 여러 번 오면 처음 것(최근 갱신)만 쓰고, 바뀐 것이 없으면 빈 배열이다', () => {
    expect(
      planReleaseChanges(
        [changeOf('A-9', ['100'], { summary: '최신' }), changeOf('A-9', ['100'], { summary: '옛' })],
        [target(1, '100', [])]
      )[0].upserts.map((i) => i.summary)
    ).toEqual(['최신'])
    expect(planReleaseChanges([changeOf('Z-1', ['999'])], [target(1, '100', ['A-1'])])).toEqual([])
  })
})

describe('syncReleaseChanges — 변경분 동기화', () => {
  const V_A = versionOf({ id: '100', name: '4.2.0', releaseDate: '2026-11-20' })
  const V_B = versionOf({ id: '101', name: '4.1.0', releaseDate: '2026-11-10' })
  const T0 = new Date('2026-11-18T01:00:00.000Z')
  const itemsByVersion: Record<string, JiraIssueSummary[]> = {}

  function setNow(at: Date | number): void {
    vi.setSystemTime(at)
  }

  /** 기준 시각(ISO). 값은 { projectKey, at } JSON 이다. 다른 프로젝트 것이면 undefined */
  function checkedAt(projectKey = 'PROJ'): string | undefined {
    const row = getDatabase()
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(RELEASE_SYNC_CHECKED_KEY) as { value: string } | undefined
    if (!row) return undefined
    const v = JSON.parse(row.value) as { projectKey: string; at: string }
    return v.projectKey === projectKey ? v.at : undefined
  }

  function setCheckedAt(value: string): void {
    getDatabase()
      .prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)")
      .run(RELEASE_SYNC_CHECKED_KEY, value)
  }

  function noteRow(versionId: string): { last_sync_error: string | null; last_synced_at: string | null } {
    return getDatabase()
      .prepare('SELECT last_sync_error, last_synced_at FROM release_notes WHERE jira_version_id = ?')
      .get(versionId) as { last_sync_error: string | null; last_synced_at: string | null }
  }

  function noteOf(versionId: string): ReturnType<typeof getReleaseNote> {
    const row = getDatabase()
      .prepare('SELECT id FROM release_notes WHERE jira_version_id = ?')
      .get(versionId) as { id: number } | undefined
    return row ? getReleaseNote(row.id) : null
  }

  function itemKeys(versionId: string): string[] {
    return noteOf(versionId)!.items.map((i) => i.issue_key)
  }

  function logCount(): number {
    return (
      getDatabase()
        .prepare("SELECT COUNT(*) AS c FROM activity_log WHERE entity_name LIKE 'Jira 변경분 동기화%'")
        .get() as { c: number }
    ).c
  }

  /** 두 릴리스를 전체 동기화로 받아 둔다(기준 시각 = T0) */
  async function seedSynced(versions: JiraVersionSummary[] = [V_A, V_B]): Promise<void> {
    itemsByVersion['100'] = [issueOf('A-1'), issueOf('A-2')]
    itemsByVersion['101'] = [issueOf('B-1')]
    jira.getDefaultJiraProjectKey.mockReturnValue('PROJ')
    jira.listJiraVersions.mockResolvedValue(versions)
    jira.getJiraVersion.mockImplementation(async (id: string) => versions.find((v) => v.id === id))
    jira.listIssuesByFixVersion.mockImplementation(async (id: string) => ({
      issues: itemsByVersion[id] ?? [],
      truncated: false
    }))
    jira.listUpdatedReleaseIssues.mockResolvedValue({ issues: [], truncated: false })
    setNow(T0)
    await syncAllReleases()
    jira.listJiraVersions.mockClear()
    jira.listIssuesByFixVersion.mockClear()
    jira.getJiraVersion.mockClear()
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('변경분: 전체 동기화가 기준 시각(시작 시각)을 저장하고, 10분 이내면 Jira 없이 생략한다 (force 는 생략하지 않는다)', async () => {
    await seedSynced()
    expect(checkedAt()).toBe(T0.toISOString())

    setNow(T0.getTime() + 9 * 60_000)
    expect(await syncReleaseChanges()).toEqual({ mode: 'skipped', changed: [], linked: 0, metaUpdated: 0 })
    expect(jira.listJiraVersions).not.toHaveBeenCalled()
    expect(jira.listUpdatedReleaseIssues).not.toHaveBeenCalled()

    const forced = await syncReleaseChanges({ force: true })
    expect(forced.mode).toBe('incremental')
    expect(jira.listUpdatedReleaseIssues).toHaveBeenCalledWith('PROJ', 19)
  })

  it('변경분: 기준 시각이 없으면 전체 동기화로 넘어간다', async () => {
    await seedSynced()
    clearReleaseSyncCheckpoint()
    setNow(T0.getTime() + 60 * 60_000)

    const r = await syncReleaseChanges()

    expect(r.mode).toBe('full')
    expect(r.full?.synced).toHaveLength(2)
    expect(jira.listUpdatedReleaseIssues).not.toHaveBeenCalled()
    expect(checkedAt()).toBe(new Date(T0.getTime() + 60 * 60_000).toISOString())
  })

  it('변경분: 기준 시각이 7일보다 오래되면 전체 동기화로 넘어간다', async () => {
    await seedSynced()
    setNow(T0.getTime() + 7 * 24 * 60 * 60_000 + 60_000)
    expect((await syncReleaseChanges()).mode).toBe('full')
    expect(jira.listUpdatedReleaseIssues).not.toHaveBeenCalled()
  })

  it('변경분: 바뀐 이슈 조회가 상한에 걸리면 전체 동기화로 넘어간다', async () => {
    await seedSynced()
    setNow(T0.getTime() + 30 * 60_000)
    jira.listUpdatedReleaseIssues.mockResolvedValue({ issues: [changeOf('A-1', ['100'])], truncated: true })
    const r = await syncReleaseChanges()
    expect(r.mode).toBe('full')
    expect(jira.listIssuesByFixVersion).toHaveBeenCalled()
  })

  it('변경분 조회가 실패하면 전체로 넘어가지 않고 throw 하며 DB 와 기준 시각은 그대로다', async () => {
    await seedSynced()
    const before = noteOf('100')
    setNow(T0.getTime() + 30 * 60_000)
    jira.listUpdatedReleaseIssues.mockRejectedValue(new Error('Jira API 오류 (500)'))

    await expect(syncReleaseChanges()).rejects.toThrow('500')

    expect(noteOf('100')).toEqual(before)
    expect(checkedAt()).toBe(T0.toISOString())
    expect(jira.listIssuesByFixVersion).not.toHaveBeenCalled()
  })

  it('변경분 upsert: 바뀐 항목은 갱신하고 새 항목은 sort_order 최댓값 + 1 로 붙이며 기준 시각을 옮긴다', async () => {
    await seedSynced()
    const start = T0.getTime() + 15 * 60_000 + 1
    setNow(start)
    jira.listUpdatedReleaseIssues.mockResolvedValue({
      issues: [changeOf('A-1', ['100'], { status: '진행 중', summary: '새 요약' }), changeOf('A-3', ['100'])],
      truncated: false
    })

    const r = await syncReleaseChanges()

    // 15분 0.001초 → ceil 16분 + 여유 10분
    expect(jira.listUpdatedReleaseIssues).toHaveBeenCalledWith('PROJ', 26)
    expect(r).toEqual({
      mode: 'incremental',
      changed: [{ noteId: noteOf('100')!.id, version: '4.2.0', upserted: 2, removed: 0 }],
      linked: 0,
      metaUpdated: 0
    })
    const items = noteOf('100')!.items
    expect(items.map((i) => [i.issue_key, i.status, i.summary, i.sort_order])).toEqual([
      ['A-1', '진행 중', '새 요약', 0],
      ['A-2', '완료', 'A-2 요약', 1],
      ['A-3', '완료', 'A-3 요약', 2]
    ])
    expect(checkedAt()).toBe(new Date(start).toISOString())
    // 버전 목록 1회 + 바뀐 이슈 1회. 릴리스별 이슈 재조회는 없다
    expect(jira.listJiraVersions).toHaveBeenCalledTimes(1)
    expect(jira.listIssuesByFixVersion).not.toHaveBeenCalled()
  })

  it('변경분: 다른 버전으로 옮긴 이슈는 원래 릴리스에서 지우고 새 릴리스에 넣는다', async () => {
    await seedSynced()
    setNow(T0.getTime() + 20 * 60_000)
    jira.listUpdatedReleaseIssues.mockResolvedValue({ issues: [changeOf('A-2', ['101'])], truncated: false })

    const r = await syncReleaseChanges()

    expect(itemKeys('100')).toEqual(['A-1'])
    expect(itemKeys('101')).toEqual(['B-1', 'A-2'])
    expect(r.changed.map((c) => [c.version, c.upserted, c.removed])).toEqual([
      ['4.2.0', 0, 1],
      ['4.1.0', 1, 0]
    ])
  })

  it('변경분: fixVersion 이 비워진 이슈는 항목에서 지운다', async () => {
    await seedSynced()
    setNow(T0.getTime() + 20 * 60_000)
    jira.listUpdatedReleaseIssues.mockResolvedValue({ issues: [changeOf('B-1', [])], truncated: false })
    await syncReleaseChanges()
    expect(itemKeys('101')).toEqual([])
    expect(itemKeys('100')).toEqual(['A-1', 'A-2'])
  })

  it('변경분: 이슈를 아직 받지 않은 릴리스는 건드리지 않고, 받아 둔 릴리스는 변경이 없어도 최신으로 표시한다 (직전 실패 릴리스는 제외)', async () => {
    const V_C = versionOf({ id: '102', name: '4.0.0' })
    await seedSynced([V_A, V_B])
    const pending = linkReleaseNote('PROJ', V_C).id
    jira.listJiraVersions.mockResolvedValue([V_A, V_B, V_C])
    const db = getDatabase()
    db.prepare("UPDATE release_notes SET last_synced_at = '2000-01-01 00:00:00' WHERE jira_version_id = '100'").run()
    db.prepare("UPDATE release_notes SET last_synced_at = '2000-01-01 00:00:00', last_sync_error = '옛 오류' WHERE jira_version_id = '101'").run()
    setNow(T0.getTime() + 20 * 60_000)
    jira.listUpdatedReleaseIssues.mockResolvedValue({ issues: [changeOf('C-1', ['102'])], truncated: false })

    const r = await syncReleaseChanges()

    expect(getReleaseNote(pending)!.items).toEqual([])
    expect(getReleaseNote(pending)!.last_synced_at).toBeNull()
    expect(r.changed).toEqual([])
    expect(noteOf('100')!.last_synced_at).not.toBe('2000-01-01 00:00:00')
    // 직전 동기화가 실패한 릴리스는 오류와 시각을 그대로 둔다(행 동기화·전체 동기화가 정리)
    expect(noteRow('101')).toEqual({ last_sync_error: '옛 오류', last_synced_at: '2000-01-01 00:00:00' })
  })

  it('변경분: 목록에 없던 버전은 연결해 그 릴리스만 전체로 받는다. 보관 버전은 가져오지 않는다', async () => {
    await seedSynced()
    const V_NEW = versionOf({ id: '103', name: '4.3.0' })
    const V_OLD = versionOf({ id: '104', name: '3.0.0', archived: true })
    itemsByVersion['103'] = [issueOf('N-1')]
    jira.listJiraVersions.mockResolvedValue([V_NEW, V_A, V_B, V_OLD])
    jira.getJiraVersion.mockImplementation(async (id: string) => [V_NEW, V_A, V_B, V_OLD].find((v) => v.id === id))
    setNow(T0.getTime() + 20 * 60_000)

    const r = await syncReleaseChanges()

    expect(r.linked).toBe(1)
    expect(itemKeys('103')).toEqual(['N-1'])
    expect(noteOf('104')).toBeNull()
    expect(jira.listIssuesByFixVersion.mock.calls).toEqual([['103']])
  })

  it('변경분: 이미 있는 릴리스의 메타만 바뀌면 메타만 갱신하고 이슈는 다시 받지 않는다', async () => {
    await seedSynced()
    jira.listJiraVersions.mockResolvedValue([{ ...V_A, name: '4.2.0 (hotfix)', released: true }, V_B])
    setNow(T0.getTime() + 20 * 60_000)

    const r = await syncReleaseChanges()

    expect(r).toMatchObject({ mode: 'incremental', metaUpdated: 1, changed: [], linked: 0 })
    const a = noteOf('100')!
    expect([a.version_name, a.released]).toEqual(['4.2.0 (hotfix)', 1])
    expect(a.items.map((i) => i.issue_key)).toEqual(['A-1', 'A-2'])
    expect(jira.listIssuesByFixVersion).not.toHaveBeenCalled()
    expect(jira.getJiraVersion).not.toHaveBeenCalled()
  })

  it('변경분: 변경이 없으면 활동 로그를 남기지 않고, 변경이 있으면 1건만 남긴다', async () => {
    await seedSynced()
    setNow(T0.getTime() + 20 * 60_000)
    await syncReleaseChanges()
    expect(logCount()).toBe(0)

    setNow(T0.getTime() + 40 * 60_000)
    jira.listUpdatedReleaseIssues.mockResolvedValue({
      issues: [changeOf('A-1', ['100'], { status: '보류' }), changeOf('B-1', [])],
      truncated: false
    })
    await syncReleaseChanges()
    expect(logCount()).toBe(1)
    const log = getDatabase()
      .prepare("SELECT details FROM activity_log WHERE entity_name LIKE 'Jira 변경분 동기화%'")
      .get() as { details: string }
    expect(log.details).toContain('릴리스 2개')
    expect(log.details).toContain('항목 갱신 1건')
    expect(log.details).toContain('삭제 1건')
  })

  it('변경분과 전체 동기화는 겹치지 않는다 — 전체가 도는 중이면 그 결과를 함께 쓴다', async () => {
    await seedSynced()
    clearReleaseSyncCheckpoint()
    setNow(T0.getTime() + 60_000)
    const full = syncAllReleases()
    const changes = syncReleaseChanges({ force: true })
    const [f, c] = await Promise.all([full, changes])
    expect(c).toEqual({ mode: 'full', changed: [], linked: f.linked, metaUpdated: 0, full: f })
    expect(jira.listJiraVersions).toHaveBeenCalledTimes(1)
    expect(jira.listUpdatedReleaseIssues).not.toHaveBeenCalled()
  })

  it('변경분 동기화가 도는 중에 전체 동기화를 부르면 끝난 뒤에 시작한다', async () => {
    await seedSynced()
    setNow(T0.getTime() + 20 * 60_000)
    let release: () => void = () => undefined
    jira.listUpdatedReleaseIssues.mockImplementation(
      () => new Promise((r) => (release = () => r({ issues: [], truncated: false })))
    )
    const changes = syncReleaseChanges()
    const full = syncAllReleases()
    await vi.waitFor(() => expect(jira.listUpdatedReleaseIssues).toHaveBeenCalledTimes(1))
    // 변경분이 버전 목록 1회를 썼고 전체는 아직 시작하지 않았다
    expect(jira.listJiraVersions).toHaveBeenCalledTimes(1)
    release()
    await changes
    await full
    expect(jira.listJiraVersions).toHaveBeenCalledTimes(2)
  })

  /** 이미 받아 둔 릴리스 40개(상한)를 만든다. 가장 낮은 버전 id 는 '300' */
  function fortyVersions(): JiraVersionSummary[] {
    return Array.from({ length: MAX_ISSUE_FETCH_PER_SYNC }, (_, i) =>
      versionOf({ id: String(300 + MAX_ISSUE_FETCH_PER_SYNC - 1 - i), name: `9.${MAX_ISSUE_FETCH_PER_SYNC - i}.0` })
    )
  }
  const LOWEST = '300'
  const HIGHER = versionOf({ id: '999', name: '99.0.0' })

  /** 받아 둔 40개 위에 더 높은 버전을 끼워 가장 낮은 릴리스를 상한 밖(metaOnly)으로 민다 */
  async function seedFortyThenPushLowestOut(): Promise<void> {
    const forty = fortyVersions()
    itemsByVersion[LOWEST] = [issueOf('L-1')]
    await seedSynced(forty)
    jira.listJiraVersions.mockResolvedValue([HIGHER, ...forty])
    jira.getJiraVersion.mockImplementation(async (id: string) => [HIGHER, ...forty].find((v) => v.id === id))
  }

  it('변경분 R1: 이미 받아 둔 릴리스가 전체 동기화에서 실패하면 건너뛴 구간을 따로 메우고 기준 시각은 옮긴다. 변경분은 그 릴리스의 오류를 지우지 않는다', async () => {
    await seedSynced()
    jira.listIssuesByFixVersion.mockImplementation(async (id: string) => {
      if (id === '101') throw new Error('timeout')
      return { issues: itemsByVersion[id] ?? [], truncated: false }
    })
    const fullAt = T0.getTime() + 24 * 60 * 60_000
    setNow(fullAt)
    jira.listUpdatedReleaseIssues.mockResolvedValue({
      issues: [changeOf('B-2', ['101'])],
      truncated: false
    })
    const full = await syncAllReleases()

    expect(full.failed.map((f) => f.version)).toEqual(['4.1.0'])
    // 구간(T0 ~ 이번 시작) 조회 1회. 하루 + 여유 10분
    expect(jira.listUpdatedReleaseIssues).toHaveBeenCalledTimes(1)
    expect(jira.listUpdatedReleaseIssues).toHaveBeenCalledWith('PROJ', 24 * 60 + 10)
    expect(itemKeys('101')).toEqual(['B-1', 'B-2'])
    // 실패 릴리스는 오류가 남아 "최신"으로 보이지 않는다
    expect(noteRow('101').last_sync_error).toBe('timeout')
    // 기준 시각은 항상 이번 시작 시각으로 옮긴다
    expect(checkedAt()).toBe(new Date(fullAt).toISOString())

    const bBefore = noteRow('101')
    setNow(fullAt + 11 * 60_000)
    jira.listUpdatedReleaseIssues.mockResolvedValue({ issues: [], truncated: false })
    const r = await syncReleaseChanges()
    expect(r.mode).toBe('incremental')
    expect(noteRow('101')).toEqual(bBefore)
    expect(noteRow('100').last_sync_error).toBeNull()
  })

  it('변경분 (b): 기준 시각 1일 전 + 받아 둔 릴리스가 보류(metaOnly)되면 구간 조회 1회로 그 릴리스의 변경을 반영하고 최신으로 둔다', async () => {
    await seedFortyThenPushLowestOut()
    const fullAt = T0.getTime() + 24 * 60 * 60_000
    setNow(fullAt)
    jira.listUpdatedReleaseIssues.mockResolvedValue({
      issues: [changeOf('L-1', [LOWEST], { status: '보류' }), changeOf('L-2', [LOWEST]), changeOf('X-9', ['301'])],
      truncated: false
    })
    getDatabase().prepare("UPDATE release_notes SET last_synced_at = '2000-01-01 00:00:00' WHERE jira_version_id = ?").run(LOWEST)

    const full = await syncAllReleases()

    expect(full.metaOnly.map((m) => m.version)).toEqual(['9.1.0'])
    expect(jira.listUpdatedReleaseIssues).toHaveBeenCalledTimes(1)
    expect(jira.listUpdatedReleaseIssues).toHaveBeenCalledWith('PROJ', 24 * 60 + 10)
    const lowest = noteOf(LOWEST)!
    expect(lowest.items.map((i) => [i.issue_key, i.status])).toEqual([
      ['L-1', '보류'],
      ['L-2', '완료']
    ])
    expect(lowest.last_synced_at).not.toBe('2000-01-01 00:00:00')
    // 구간 조회는 보류된 릴리스에만 적용한다(301 은 이번에 전체로 다시 받았다)
    expect(itemKeys('301')).not.toContain('X-9')
    expect(checkedAt()).toBe(new Date(fullAt).toISOString())
  })

  it('변경분 (c): 구간 조회가 실패하면 그 릴리스를 변경분 대상에서 빼고(최신 아님) 항목은 남긴다', async () => {
    await seedFortyThenPushLowestOut()
    setNow(T0.getTime() + 60 * 60_000)
    jira.listUpdatedReleaseIssues.mockRejectedValueOnce(new Error('Jira API 오류 (500)'))
    await syncAllReleases()

    const lowest = noteOf(LOWEST)!
    expect(lowest.last_synced_at).toBeNull()
    expect(lowest.last_sync_error).toBeNull()
    expect(lowest.items.map((i) => i.issue_key)).toEqual(['L-1'])

    // 다음 변경분은 그 릴리스를 건드리지 않는다
    setNow(T0.getTime() + 60 * 60_000 + 11 * 60_000)
    jira.listUpdatedReleaseIssues.mockResolvedValue({ issues: [changeOf('L-9', [LOWEST])], truncated: false })
    await syncReleaseChanges()
    expect(itemKeys(LOWEST)).toEqual(['L-1'])
    expect(noteOf(LOWEST)!.last_synced_at).toBeNull()
  })

  it('변경분 (c): 옛 기준 시각이 없으면 구간 조회 없이 그 릴리스를 변경분 대상에서 뺀다', async () => {
    await seedFortyThenPushLowestOut()
    clearReleaseSyncCheckpoint()
    setNow(T0.getTime() + 60 * 60_000)
    await syncAllReleases()
    expect(jira.listUpdatedReleaseIssues).not.toHaveBeenCalled()
    expect(noteOf(LOWEST)!.last_synced_at).toBeNull()
    expect(itemKeys(LOWEST)).toEqual(['L-1'])
    expect(checkedAt()).toBe(new Date(T0.getTime() + 60 * 60_000).toISOString())
  })

  it('변경분 (a): 기준 시각 8일 전 + 받아 둔 41번째 릴리스가 있어도 고착되지 않는다 — 두 번째 호출은 full 이 아니다', async () => {
    await seedFortyThenPushLowestOut()
    const start = T0.getTime() + 8 * 24 * 60 * 60_000
    setNow(start)
    const first = await syncReleaseChanges()
    expect(first.mode).toBe('full')
    // 8일 전 기준은 메울 수 없다 → 최신 아님으로 드러낸다(항목은 남는다)
    expect(noteOf(LOWEST)!.last_synced_at).toBeNull()
    expect(itemKeys(LOWEST)).toEqual(['L-1'])

    setNow(start + 5 * 60_000)
    expect((await syncReleaseChanges()).mode).toBe('skipped')
    expect((await syncReleaseChanges({ force: true })).mode).toBe('incremental')
  })

  it('변경분 (d): 계속 실패하는 버전이 있어도 고착되지 않는다', async () => {
    await seedSynced()
    jira.listIssuesByFixVersion.mockImplementation(async (id: string) => {
      if (id === '101') throw new Error('권한 없음')
      return { issues: itemsByVersion[id] ?? [], truncated: false }
    })
    const start = T0.getTime() + 8 * 24 * 60 * 60_000
    setNow(start)
    expect((await syncReleaseChanges()).mode).toBe('full')
    expect(noteRow('101').last_sync_error).toBe('권한 없음')
    setNow(start + 11 * 60_000)
    expect((await syncReleaseChanges()).mode).toBe('incremental')
    setNow(start + 22 * 60_000)
    expect((await syncReleaseChanges()).mode).toBe('incremental')
  })

  it('변경분 (e): 기다린 변경분이 전체로 넘어가 끝났으면 전체 동기화는 그 결과를 그대로 쓴다', async () => {
    await seedSynced()
    setNow(T0.getTime() + 30 * 60_000)
    let release: () => void = () => undefined
    jira.listUpdatedReleaseIssues.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ issues: [], truncated: true })))
    )
    const changes = syncReleaseChanges()
    await vi.waitFor(() => expect(jira.listUpdatedReleaseIssues).toHaveBeenCalledTimes(1))
    const full = syncAllReleases()
    release()
    const [c, f] = await Promise.all([changes, full])

    expect(c.mode).toBe('full')
    expect(f).toBe(c.full)
    // 변경분의 버전 목록 1회 + 전체 1회. 전체가 두 번 돌지 않는다
    expect(jira.listJiraVersions).toHaveBeenCalledTimes(2)
  })

  it('변경분: 기준 시각이 없으면 전체 동기화가 실패를 담아도 시작 시각을 기준으로 둔다', async () => {
    jira.getDefaultJiraProjectKey.mockReturnValue('PROJ')
    jira.listJiraVersions.mockResolvedValue([V_A])
    jira.getJiraVersion.mockRejectedValue(new Error('403'))
    jira.listIssuesByFixVersion.mockResolvedValue({ issues: [], truncated: false })
    setNow(T0)
    const full = await syncAllReleases()
    expect(full.failed).toHaveLength(1)
    expect(checkedAt()).toBe(T0.toISOString())
  })

  it('변경분: 기준 시각이 다른 프로젝트 것이거나 옛 형식이면 없는 것으로 보고 전체로 넘어간다', async () => {
    await seedSynced()
    setNow(T0.getTime() + 30 * 60_000)
    setCheckedAt(JSON.stringify({ projectKey: 'OTHER', at: T0.toISOString() }))
    expect((await syncReleaseChanges()).mode).toBe('full')

    setNow(T0.getTime() + 60 * 60_000)
    setCheckedAt(T0.toISOString())
    expect((await syncReleaseChanges()).mode).toBe('full')
    expect(jira.listUpdatedReleaseIssues).not.toHaveBeenCalled()
  })

  it('변경분: 기준 시각을 지운 뒤 끝난 옛 동기화는 기준 시각을 되살리지 않는다', async () => {
    await seedSynced()
    clearReleaseSyncCheckpoint()
    setNow(T0.getTime() + 60_000)
    let release: () => void = () => undefined
    jira.listJiraVersions.mockImplementationOnce(() => new Promise((r) => (release = () => r([V_A, V_B]))))
    const run = syncAllReleases()
    await vi.waitFor(() => expect(jira.listJiraVersions).toHaveBeenCalledTimes(1))
    clearReleaseSyncCheckpoint()
    release()
    await run
    expect(checkedAt()).toBeUndefined()
  })

  it('변경분 R2: 변경분이 전체로 넘어간 동안 들어온 전체 동기화는 같은 실행을 함께 쓴다', async () => {
    jira.getDefaultJiraProjectKey.mockReturnValue('PROJ')
    let release: () => void = () => undefined
    jira.listJiraVersions.mockImplementation(() => new Promise((r) => (release = () => r([V_A]))))
    jira.getJiraVersion.mockResolvedValue(V_A)
    jira.listIssuesByFixVersion.mockResolvedValue({ issues: [], truncated: false })
    setNow(T0)

    const changes = syncReleaseChanges() // 기준 없음 → 전체
    const full = syncAllReleases()
    await vi.waitFor(() => expect(jira.listJiraVersions).toHaveBeenCalledTimes(1))
    release()
    const [c, f] = await Promise.all([changes, full])

    expect(c.mode).toBe('full')
    expect(c.full).toBe(f)
    expect(jira.listJiraVersions).toHaveBeenCalledTimes(1)
    expect(jira.getJiraVersion).toHaveBeenCalledTimes(1)
  })

  it('변경분 R3: 기준 시각이 미래면(시계가 뒤로 감) 조회 기간을 믿지 않고 전체로 넘어간다', async () => {
    await seedSynced()
    setCheckedAt(JSON.stringify({ projectKey: 'PROJ', at: new Date(T0.getTime() + 60 * 60_000).toISOString() }))
    setNow(T0)
    const r = await syncReleaseChanges({ force: true })
    expect(r.mode).toBe('full')
    expect(jira.listUpdatedReleaseIssues).not.toHaveBeenCalled()
  })
})

// 기존 사용자의 DB는 릴리스 노트가 프로젝트에 묶여 있었다. 이 마이그레이션은 중복 행을 합치고
// 테이블을 다시 만들므로, 조용히 깨지면 사용자가 쌓아 둔 릴리스 노트와 이슈가 사라진다.
describe('migrateReleaseNotesDropProject', () => {
  /** 마이그레이션 이전 스키마(project_id 있음)로 되돌려 놓는다 */
  function seedLegacySchema(): void {
    const db = getDatabase()
    db.pragma('foreign_keys = OFF')
    db.exec(`
      DROP TABLE IF EXISTS release_notes;
      CREATE TABLE release_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        jira_project_key TEXT NOT NULL,
        jira_version_id TEXT NOT NULL,
        version_name TEXT NOT NULL,
        description TEXT,
        released INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        release_date TEXT,
        start_date TEXT,
        last_synced_at TEXT,
        last_sync_error TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        UNIQUE (project_id, jira_version_id)
      );
    `)
    db.pragma('foreign_keys = ON')
  }

  /** 구 스키마에 릴리스 노트 한 행을 직접 넣는다 */
  function insertLegacyNote(id: number, projectId: number | null, syncedAt: string | null): void {
    getDatabase()
      .prepare(
        `INSERT INTO release_notes (id, project_id, jira_project_key, jira_version_id, version_name,
                                    release_date, last_synced_at)
         VALUES (?, ?, 'PROJ', '100', '4.164.0', '2026-08-25', ?)`
      )
      .run(id, projectId, syncedAt)
  }

  it('릴리스 노트와 이슈를 하나도 잃지 않고 옮긴다', () => {
    const db = getDatabase()
    seedLegacySchema()
    insertLegacyNote(7, seedProject('검색 개편', '4.164.0'), '2026-08-25 10:00:00')
    seedItems(7, ['PROJ-1', 'PROJ-2', 'PROJ-3'])

    migrateReleaseNotesDropProject(db)

    const note = getReleaseNote(7)!
    expect(note.version_name).toBe('4.164.0')
    expect(note.last_synced_at).toBe('2026-08-25 10:00:00')
    // DROP TABLE이 CASCADE로 이슈를 쓸어 가지 않아야 한다 — 여기가 이 마이그레이션의 급소다
    expect(note.items.map((i) => i.issue_key)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3'])
  })

  it('같은 릴리스를 가리키던 여러 행을 한 줄로 합친다', () => {
    const db = getDatabase()
    seedLegacySchema()
    insertLegacyNote(1, seedProject('가 프로젝트', '4.164.0'), '2026-08-25 10:00:00')
    insertLegacyNote(2, seedProject('나 프로젝트', '4.164.0'), '2026-08-25 10:00:00')
    insertLegacyNote(3, seedProject('다 프로젝트', '4.164.0'), null)
    seedItems(1, ['PROJ-1'])
    seedItems(2, ['PROJ-1', 'PROJ-2', 'PROJ-3'])

    migrateReleaseNotesDropProject(db)

    const notes = listReleaseNotes()
    expect(notes).toHaveLength(1)
    // 이슈가 가장 많은 행을 남긴다 — 상한에 걸려 메타만 있는 행이 이기면 알맹이를 잃는다
    expect(notes[0].id).toBe(2)
    expect(getReleaseNote(2)!.items.map((i) => i.issue_key)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3'])
    // 버려진 행의 이슈도 함께 정리돼 고아로 남지 않아야 한다
    const orphans = db
      .prepare(
        `SELECT COUNT(*) AS c FROM release_note_items i
         WHERE NOT EXISTS (SELECT 1 FROM release_notes r WHERE r.id = i.release_note_id)`
      )
      .get() as { c: number }
    expect(orphans.c).toBe(0)
  })

  it('마이그레이션 뒤에는 같은 릴리스를 두 번 넣을 수 없다', () => {
    const db = getDatabase()
    seedLegacySchema()

    migrateReleaseNotesDropProject(db)

    linkReleaseNote('PROJ', versionOf({ id: '101', name: '4.163.0' }))
    expect(() => linkReleaseNote('PROJ', versionOf({ id: '101', name: '4.163.0' }))).toThrow(
      '이미 목록에 있는 Jira 릴리스입니다.'
    )
  })

  it('이미 옮겨졌으면 아무것도 하지 않는다 (두 번 실행해도 안전)', () => {
    const db = getDatabase()
    const { id } = linkReleaseNote('PROJ', versionOf())

    migrateReleaseNotesDropProject(db)
    migrateReleaseNotesDropProject(db)

    expect(getReleaseNote(id)!.version_name).toBe('v1.2.0')
  })
})
