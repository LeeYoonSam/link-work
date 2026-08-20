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

import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import type { JiraIssueSummary, JiraVersionSummary } from './jira'
import {
  getReleaseNote,
  linkReleaseNote,
  listReleaseNotes,
  syncAllByDeployVersion,
  syncReleaseNote,
  unlinkReleaseNote
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

/** 프로젝트 + 릴리스 노트 한 건을 만들고 노트 id를 돌려준다 */
function seedNote(): number {
  const { id } = linkReleaseNote(seedProject('검색 개편'), 'ICA', versionOf())
  return id
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
  it('연결한 릴리스가 Jira 메타 그대로 저장된다', () => {
    const id = seedNote()
    const note = getReleaseNote(id)
    expect(note).not.toBeNull()
    expect(note!.jira_version_id).toBe('10042')
    expect(note!.version_name).toBe('v1.2.0')
    expect(note!.released).toBe(0)
    expect(note!.release_date).toBe('2026-09-01')
    // 아직 동기화 전이므로 비어 있어야 한다
    expect(note!.last_synced_at).toBeNull()
    expect(note!.items).toEqual([])
  })

  it('같은 프로젝트에 같은 Jira 버전을 두 번 연결할 수 없다', () => {
    const db = getDatabase()
    const id = seedNote()
    const projectId = getReleaseNote(id)!.project_id

    expect(() => linkReleaseNote(projectId, 'ICA', versionOf())).toThrow('이미')
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM release_notes WHERE project_id = ?')
      .get(projectId) as { c: number }
    expect(count.c).toBe(1)
  })

  it('버전 ID가 다르면 같은 프로젝트에도 연결된다', () => {
    const id = seedNote()
    const projectId = getReleaseNote(id)!.project_id
    linkReleaseNote(projectId, 'ICA', versionOf({ id: '10043', name: 'v1.3.0' }))
    expect(listReleaseNotes(projectId)).toHaveLength(2)
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

describe('listReleaseNotes / unlinkReleaseNote', () => {
  it('목록에 항목 수가 함께 나온다', async () => {
    const id = seedNote()
    jira.getJiraVersion.mockResolvedValue(versionOf())
    jira.listIssuesByFixVersion.mockResolvedValue({
      issues: [issueOf('ICA-1'), issueOf('ICA-2')],
      truncated: false
    })
    await syncReleaseNote(id)

    const notes = listReleaseNotes()
    expect(notes).toHaveLength(1)
    expect(notes[0].item_count).toBe(2)
  })

  it('다른 프로젝트의 릴리스 노트는 projectId 필터에서 빠진다', () => {
    const id = seedNote()
    const projectId = getReleaseNote(id)!.project_id
    linkReleaseNote(seedProject('다른 프로젝트'), 'OTH', versionOf({ id: '20001' }))

    expect(listReleaseNotes(projectId)).toHaveLength(1)
    expect(listReleaseNotes()).toHaveLength(2)
  })

  it('목록과 상세에 프로젝트 이름이 함께 나온다', () => {
    const id = seedNote()

    expect(listReleaseNotes()[0].project_name).toBe('검색 개편')
    expect(listReleaseNotes(getReleaseNote(id)!.project_id)[0].project_name).toBe('검색 개편')
    expect(getReleaseNote(id)!.project_name).toBe('검색 개편')
  })

  it('전체 목록은 프로젝트별로 묶이고, 프로젝트 안에서는 릴리스일 내림차순을 유지한다', () => {
    // 이름 순으로 '가 프로젝트' < '나 프로젝트'. 삽입 순서는 일부러 뒤섞는다.
    const na = seedProject('나 프로젝트')
    const ga = seedProject('가 프로젝트')
    linkReleaseNote(na, 'NA', versionOf({ id: '1', name: 'na-old', releaseDate: '2026-01-01' }))
    linkReleaseNote(ga, 'GA', versionOf({ id: '2', name: 'ga-old', releaseDate: '2026-01-01' }))
    linkReleaseNote(na, 'NA', versionOf({ id: '3', name: 'na-new', releaseDate: '2026-09-01' }))
    linkReleaseNote(ga, 'GA', versionOf({ id: '4', name: 'ga-new', releaseDate: '2026-09-01' }))

    expect(listReleaseNotes().map((n) => n.version_name)).toEqual([
      'ga-new',
      'ga-old',
      'na-new',
      'na-old'
    ])
    // 프로젝트별 조회는 프로젝트 키가 상수라 기존 순서(릴리스일 내림차순)와 동일하다.
    expect(listReleaseNotes(na).map((n) => n.version_name)).toEqual(['na-new', 'na-old'])
  })

  it('연결을 끊으면 항목도 함께 사라진다 (unlink)', () => {
    const db = getDatabase()
    const id = seedNote()
    seedItems(id, ['ICA-1', 'ICA-2'])

    unlinkReleaseNote(id)

    expect(getReleaseNote(id)).toBeNull()
    const left = db
      .prepare('SELECT COUNT(*) AS c FROM release_note_items WHERE release_note_id = ?')
      .get(id) as { c: number }
    expect(left.c).toBe(0)
  })
})

describe('syncAllByDeployVersion', () => {
  const V_164 = versionOf({ id: '100', name: '4.164.0' })
  const V_163 = versionOf({ id: '101', name: '4.163.0' })

  it('deploy_version이 일치하는 프로젝트를 자동 연결하고 동기화한다', async () => {
    const projectId = seedProject('가 프로젝트', '4.164.0')
    mockJira([V_164, V_163])

    const result = await syncAllByDeployVersion()

    expect(result.synced).toEqual([
      { projectId, projectName: '가 프로젝트', version: '4.164.0', itemCount: 1 }
    ])
    // 연결은 이름이 아니라 버전 ID로 저장돼야 이후 이름이 바뀌어도 추적이 끊기지 않는다.
    const note = listReleaseNotes(projectId)[0]
    expect(note.jira_version_id).toBe('100')
    expect(note.jira_project_key).toBe('ICA')
    expect(note.last_synced_at).not.toBeNull()
    expect(getReleaseNote(note.id)!.items.map((i) => i.issue_key)).toEqual(['ICA-1'])
  })

  it('매칭되는 Jira 릴리스가 없으면 unmatched에 담고 연결하지 않는다', async () => {
    const projectId = seedProject('작가앱', '2.8.2')
    mockJira([V_164, V_163])

    const result = await syncAllByDeployVersion()

    expect(result.unmatched).toEqual([
      { projectId, projectName: '작가앱', version: '2.8.2' }
    ])
    expect(result.synced).toEqual([])
    expect(listReleaseNotes()).toEqual([])
  })

  it('deploy_version이 비어 있으면 skipped로 센다', async () => {
    seedProject('버전 없음', undefined)
    seedProject('공백만', '   ')
    mockJira([V_164])

    const result = await syncAllByDeployVersion()

    expect(result.skipped).toBe(2)
    expect(result.synced).toEqual([])
    expect(result.unmatched).toEqual([])
  })

  it('한 프로젝트가 실패해도 나머지는 계속 진행되고 failed에 사유가 담긴다', async () => {
    const okId = seedProject('가 프로젝트', '4.164.0')
    const badId = seedProject('나 프로젝트', '4.163.0')
    mockJira([V_164, V_163])
    jira.listIssuesByFixVersion.mockImplementation(async (versionId: string) => {
      if (versionId === '101') throw new Error('해당 Jira 프로젝트에 접근할 권한이 없습니다.')
      return { issues: [issueOf('ICA-1')], truncated: false }
    })

    const result = await syncAllByDeployVersion()

    expect(result.synced.map((s) => s.projectId)).toEqual([okId])
    expect(result.failed).toEqual([
      {
        projectId: badId,
        projectName: '나 프로젝트',
        version: '4.163.0',
        error: '해당 Jira 프로젝트에 접근할 권한이 없습니다.'
      }
    ])
    // 실패한 쪽도 연결과 실패 사유는 남아 사용자가 원인을 볼 수 있어야 한다.
    expect(listReleaseNotes(badId)[0].last_sync_error).toBe(
      '해당 Jira 프로젝트에 접근할 권한이 없습니다.'
    )
    expect(listReleaseNotes(badId)[0].last_synced_at).toBeNull()
  })

  it('이미 연결된 릴리스는 다시 연결하지 않고 동기화만 한다', async () => {
    const projectId = seedProject('가 프로젝트', '4.164.0')
    mockJira([V_164])

    await syncAllByDeployVersion()
    const firstId = listReleaseNotes(projectId)[0].id

    const second = await syncAllByDeployVersion()

    expect(listReleaseNotes(projectId)).toHaveLength(1)
    expect(listReleaseNotes(projectId)[0].id).toBe(firstId)
    expect(second.synced).toHaveLength(1)
  })

  it('기본 프로젝트가 설정되지 않았으면 네트워크를 타지 않고 throw한다', async () => {
    seedProject('가 프로젝트', '4.164.0')
    mockJira([V_164], null)

    await expect(syncAllByDeployVersion()).rejects.toThrow('기본 프로젝트가 설정되지 않았습니다')
    expect(jira.listJiraVersions).not.toHaveBeenCalled()
  })

  it('버전 목록은 프로젝트 수와 무관하게 1회만 조회한다', async () => {
    seedProject('가 프로젝트', '4.164.0')
    seedProject('나 프로젝트', '4.163.0')
    seedProject('다 프로젝트', '4.164.0')
    mockJira([V_164, V_163])

    const result = await syncAllByDeployVersion()

    expect(result.synced).toHaveLength(3)
    expect(jira.listJiraVersions).toHaveBeenCalledTimes(1)
  })

  it('활동 로그는 프로젝트별이 아니라 전체 1건으로만 남는다', async () => {
    seedProject('가 프로젝트', '4.164.0')
    seedProject('나 프로젝트', '4.163.0')
    mockJira([V_164, V_163])

    await syncAllByDeployVersion()

    const logs = getDatabase()
      .prepare("SELECT entity_name, details FROM activity_log WHERE entity_type = 'release_note'")
      .all() as { entity_name: string; details: string }[]
    expect(logs).toHaveLength(1)
    expect(logs[0].entity_name).toContain('일괄 동기화')
    expect(logs[0].details).toContain('동기화 2건')
  })
})
