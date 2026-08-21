import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
  getDefaultJiraProjectKey: vi.fn()
}))
vi.mock('./jira', () => jira)

import {
  closeDatabase,
  getDatabase,
  initDatabase,
  migrateReleaseNotesDropProject
} from '../db/database'
import type { JiraIssueSummary, JiraVersionSummary } from './jira'
import {
  MAX_ISSUE_FETCH_PER_SYNC,
  getReleaseNote,
  linkReleaseNote,
  listReleaseNotes,
  syncAllReleases,
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
function mockJira(versions: JiraVersionSummary[], defaultKey: string | null = 'ICA'): void {
  jira.getDefaultJiraProjectKey.mockReturnValue(defaultKey)
  jira.listJiraVersions.mockResolvedValue(versions)
  jira.getJiraVersion.mockImplementation(async (versionId: string) => {
    const found = versions.find((v) => v.id === versionId)
    if (!found) throw new Error('Jira에서 프로젝트 또는 버전을 찾을 수 없습니다.')
    return found
  })
  jira.listIssuesByFixVersion.mockResolvedValue({ issues: [issueOf('ICA-1')], truncated: false })
}

/** 릴리스 노트 한 건을 만들고 노트 id를 돌려준다 */
function seedNote(): number {
  return linkReleaseNote('ICA', versionOf()).id
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
      key: 'ICA',
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
    expect(() => linkReleaseNote('ICA', versionOf())).toThrow('이미 목록에 있는 Jira 릴리스입니다.')
    const count = getDatabase().prepare('SELECT COUNT(*) AS c FROM release_notes').get() as {
      c: number
    }
    expect(count.c).toBe(1)
  })

  it('버전 ID가 다르면 따로 저장된다', () => {
    seedNote()
    linkReleaseNote('ICA', versionOf({ id: '10043', name: 'v1.3.0' }))
    expect(listReleaseNotes()).toHaveLength(2)
  })
})

describe('syncReleaseNote — 실패해도 기존 항목을 보존한다', () => {
  it('이슈 조회가 실패하면 기존 항목이 그대로 남는다', async () => {
    const id = seedNote()
    seedItems(id, ['ICA-1', 'ICA-2', 'ICA-3'])

    jira.getJiraVersion.mockResolvedValue(versionOf())
    jira.listIssuesByFixVersion.mockRejectedValue(
      new Error('Jira 토큰이 만료됐거나 유효하지 않습니다.')
    )

    await expect(syncReleaseNote(id)).rejects.toThrow('만료')

    const note = getReleaseNote(id)!
    expect(note.items.map((i) => i.issue_key)).toEqual(['ICA-1', 'ICA-2', 'ICA-3'])
  })

  it('버전 메타 조회가 실패해도 기존 항목이 그대로 남는다', async () => {
    const id = seedNote()
    seedItems(id, ['ICA-1', 'ICA-2'])

    jira.getJiraVersion.mockRejectedValue(new Error('Jira에서 프로젝트 또는 버전을 찾을 수 없습니다.'))
    jira.listIssuesByFixVersion.mockResolvedValue({ issues: [], truncated: false })

    await expect(syncReleaseNote(id)).rejects.toThrow('찾을 수 없습니다')

    const note = getReleaseNote(id)!
    expect(note.items.map((i) => i.issue_key)).toEqual(['ICA-1', 'ICA-2'])
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
    seedItems(id, ['ICA-1', 'ICA-2', 'ICA-3'])

    jira.getJiraVersion.mockResolvedValue(versionOf({ name: 'v1.2.1', released: true }))
    jira.listIssuesByFixVersion.mockResolvedValue({
      issues: [issueOf('ICA-7'), issueOf('ICA-8', { issueType: 'Bug' })],
      truncated: false
    })

    const result = await syncReleaseNote(id)
    expect(result).toEqual({ itemCount: 2, truncated: false })

    const note = getReleaseNote(id)!
    expect(note.items.map((i) => i.issue_key)).toEqual(['ICA-7', 'ICA-8'])
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
        issueOf('ICA-30'),
        issueOf('ICA-11', { issueType: 'Bug' }),
        issueOf('ICA-22', { parentKey: 'ICA-30' })
      ],
      truncated: false
    })

    await syncReleaseNote(id)

    const items = getReleaseNote(id)!.items
    expect(items.map((i) => [i.issue_key, i.sort_order])).toEqual([
      ['ICA-30', 0],
      ['ICA-11', 1],
      ['ICA-22', 2]
    ])
    expect(items[2].parent_key).toBe('ICA-30')
  })

  it('0건 결과도 정상으로 반영하고 itemCount 0을 돌려준다', async () => {
    const id = seedNote()
    seedItems(id, ['ICA-1'])

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

    jira.listIssuesByFixVersion.mockResolvedValue({ issues: [issueOf('ICA-9')], truncated: false })
    await syncReleaseNote(id)
    expect(getReleaseNote(id)!.last_sync_error).toBeNull()
  })

  it('500건 상한에 걸린 경우 truncated를 그대로 전달한다', async () => {
    const id = seedNote()
    jira.getJiraVersion.mockResolvedValue(versionOf())
    jira.listIssuesByFixVersion.mockResolvedValue({
      issues: [issueOf('ICA-1'), issueOf('ICA-2')],
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
      issues: [issueOf('ICA-1'), issueOf('ICA-2')],
      truncated: false
    })

    await syncReleaseNote(id)

    const notes = listReleaseNotes()
    expect(notes).toHaveLength(1)
    expect(notes[0].item_count).toBe(2)
  })

  it('버전 번호 내림차순으로 세운다', () => {
    // 사전순이면 4.46.0이 4.166.0보다 커서 낮은 버전이 꼭대기에 앉는다
    linkReleaseNote('ICA', versionOf({ id: '1', name: '4.46.0' }))
    linkReleaseNote('ICA', versionOf({ id: '2', name: '4.166.0' }))
    linkReleaseNote('ICA', versionOf({ id: '3', name: '4.100.0' }))

    expect(listReleaseNotes().map((n) => n.version_name)).toEqual([
      '4.166.0',
      '4.100.0',
      '4.46.0'
    ])
  })

  it('릴리스일이 없어도 버전 번호로 제자리에 선다', () => {
    // 화면 꼭대기에 앉아 있던 4.46.0이 이 경우다 — 릴리스일이 비었다고 목록 맨 위로 튀면 안 된다.
    const v = (id: string, name: string, releaseDate: string | null): void => {
      linkReleaseNote('ICA', versionOf({ id, name, releaseDate }))
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
    linkReleaseNote('ICA', versionOf({ id: '1', name: '4.164.0' }))
    linkReleaseNote('ICA', versionOf({ id: '2', name: '4.155.0' }))

    expect(listReleaseNotes('4.155.0').map((n) => n.version_name)).toEqual(['4.155.0'])
    expect(listReleaseNotes('9.9.9')).toEqual([])
  })

  it('배포 버전 한 칸에 여러 버전이 적혀 있어도 각각 찾는다', () => {
    // 실제 데이터의 '2.8.1 , 4.155.0' — 통째로 비교하면 어느 쪽과도 맞지 않았다
    linkReleaseNote('ICA', versionOf({ id: '1', name: '4.155.0' }))
    linkReleaseNote('ICA', versionOf({ id: '2', name: '2.8.1' }))
    linkReleaseNote('ICA', versionOf({ id: '3', name: '4.164.0' }))

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
    linkReleaseNote('ICA', versionOf({ id: '1', name: '4.155.0' }))

    expect(listReleaseNotes()).toHaveLength(1)
    expect(listReleaseNotes('4.155.0')).toHaveLength(1)
  })

  it('프로젝트를 지워도 릴리스 노트는 남는다 — 프로젝트에 딸린 데이터가 아니다', () => {
    const projectId = seedProject('가 프로젝트', '4.155.0')
    const id = linkReleaseNote('ICA', versionOf({ id: '1', name: '4.155.0' })).id
    seedItems(id, ['ICA-1'])

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
    expect(note.jira_project_key).toBe('ICA')
    expect(note.last_synced_at).not.toBeNull()
    expect(getReleaseNote(note.id)!.items.map((i) => i.issue_key)).toEqual(['ICA-1'])
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
      return { issues: [issueOf('ICA-1')], truncated: false }
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
         VALUES (?, ?, 'ICA', '100', '4.164.0', '2026-08-25', ?)`
      )
      .run(id, projectId, syncedAt)
  }

  it('릴리스 노트와 이슈를 하나도 잃지 않고 옮긴다', () => {
    const db = getDatabase()
    seedLegacySchema()
    insertLegacyNote(7, seedProject('검색 개편', '4.164.0'), '2026-08-25 10:00:00')
    seedItems(7, ['ICA-1', 'ICA-2', 'ICA-3'])

    migrateReleaseNotesDropProject(db)

    const note = getReleaseNote(7)!
    expect(note.version_name).toBe('4.164.0')
    expect(note.last_synced_at).toBe('2026-08-25 10:00:00')
    // DROP TABLE이 CASCADE로 이슈를 쓸어 가지 않아야 한다 — 여기가 이 마이그레이션의 급소다
    expect(note.items.map((i) => i.issue_key)).toEqual(['ICA-1', 'ICA-2', 'ICA-3'])
  })

  it('같은 릴리스를 가리키던 여러 행을 한 줄로 합친다', () => {
    const db = getDatabase()
    seedLegacySchema()
    insertLegacyNote(1, seedProject('가 프로젝트', '4.164.0'), '2026-08-25 10:00:00')
    insertLegacyNote(2, seedProject('나 프로젝트', '4.164.0'), '2026-08-25 10:00:00')
    insertLegacyNote(3, seedProject('다 프로젝트', '4.164.0'), null)
    seedItems(1, ['ICA-1'])
    seedItems(2, ['ICA-1', 'ICA-2', 'ICA-3'])

    migrateReleaseNotesDropProject(db)

    const notes = listReleaseNotes()
    expect(notes).toHaveLength(1)
    // 이슈가 가장 많은 행을 남긴다 — 상한에 걸려 메타만 있는 행이 이기면 알맹이를 잃는다
    expect(notes[0].id).toBe(2)
    expect(getReleaseNote(2)!.items.map((i) => i.issue_key)).toEqual(['ICA-1', 'ICA-2', 'ICA-3'])
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

    linkReleaseNote('ICA', versionOf({ id: '101', name: '4.163.0' }))
    expect(() => linkReleaseNote('ICA', versionOf({ id: '101', name: '4.163.0' }))).toThrow(
      '이미 목록에 있는 Jira 릴리스입니다.'
    )
  })

  it('이미 옮겨졌으면 아무것도 하지 않는다 (두 번 실행해도 안전)', () => {
    const db = getDatabase()
    const { id } = linkReleaseNote('ICA', versionOf())

    migrateReleaseNotesDropProject(db)
    migrateReleaseNotesDropProject(db)

    expect(getReleaseNote(id)!.version_name).toBe('v1.2.0')
  })
})
