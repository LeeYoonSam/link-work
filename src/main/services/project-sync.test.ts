import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3 → node:sqlite 교체. 이유는 release-note-sync.test.ts 상단 주석과 같다 —
// initDatabase()의 실제 스키마(신규 jira_issue_key 컬럼 포함)를 그대로 돌려 검증한다.
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  type Args = unknown[]

  class BetterSqlite3Shim {
    private readonly db: InstanceType<typeof DatabaseSync>

    constructor() {
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
  app: { getPath: () => '/linkwork-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))

// Jira REST는 픽스처에서 답한다. 여기서 검증할 것은 "스냅샷을 DB에 어떻게 반영하느냐"다.
const jira = vi.hoisted(() => ({
  getDefaultJiraProjectKey: vi.fn(),
  getJiraMyAccountId: vi.fn(),
  getJiraSiteUrl: vi.fn(),
  listChildIssues: vi.fn(),
  listIssuesByKeys: vi.fn(),
  listMyTodoIssues: vi.fn(),
  listRemoteLinks: vi.fn()
}))
vi.mock('./jira', () => jira)

import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import { ME, SITE_URL, projSnapshot } from './__fixtures__/project-sync/proj-snapshot'
import {
  applyProjectSync,
  applyProjectSyncSnapshot,
  clearProjectSyncCache,
  PREVIEW_EXPIRED_MESSAGE,
  previewProjectSync,
  readProjectSyncDbState
} from './project-sync'
import {
  buildProjectSyncPlan,
  EMPTY_SELECTION_MESSAGE,
  INVALID_SELECTION_MESSAGE,
  localToday,
  PROJECT_CHANGED_MESSAGE,
  UNKNOWN_SELECTION_MESSAGE,
  type JiraSyncSnapshot,
  type ProjectSyncResult
} from './project-sync-plan'

const TODAY = '2026-10-02'

interface ProjectRow {
  id: number
  name: string
  description: string | null
  dev_start_date: string
  dev_end_date: string
  status: string
  priority: string | null
  deploy_version: string | null
  jira_issue_key: string | null
}

interface TaskRow {
  id: number
  project_id: number
  parent_task_id: number | null
  name: string
  status: string
  end_date: string | null
  jira_issue_key: string | null
}

/** 픽스처 스냅샷의 미리보기 항목 전체 */
const ALL_ICA = ['PROJ-1855', 'PROJ-1893', 'PROJ-1895'].map((jiraKey) => ({
  jiraKey,
  force: false,
  projectId: null
}))

/** 현재 DB 기준 미리보기 항목을 전부 선택해 적용한다 (force=false면 보수적 업데이트 R5) */
function applyAll(snapshot: JiraSyncSnapshot, force = false): ProjectSyncResult {
  const selection = buildProjectSyncPlan(snapshot, readProjectSyncDbState(), TODAY).plan.items.map(
    (i) => ({ jiraKey: i.jiraKey, force, projectId: i.projectId })
  )
  return applyProjectSyncSnapshot(snapshot, selection, TODAY)
}

function db() {
  return getDatabase()
}

function projects(): ProjectRow[] {
  return db().prepare('SELECT * FROM projects ORDER BY id').all() as unknown as ProjectRow[]
}

function tasksOf(projectId: number): TaskRow[] {
  return db()
    .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order, id')
    .all(projectId) as unknown as TaskRow[]
}

function docsOf(projectId: number): Array<{ name: string; url: string; type: string }> {
  return db()
    .prepare('SELECT name, url, type FROM documents WHERE project_id = ? ORDER BY sort_order, id')
    .all(projectId) as unknown as Array<{ name: string; url: string; type: string }>
}

function seedProject(
  name: string,
  extra: { description?: string; priority?: string } = {}
): number {
  const res = db()
    .prepare(
      `INSERT INTO projects (name, description, dev_start_date, dev_end_date, qa_start_date, qa_end_date,
                             deploy_date, status, priority, deploy_version)
       VALUES (?, ?, '2026-08-01', '2026-08-20', '2026-08-21', '2026-08-25', '2026-09-01', 'in_progress', ?, '4.170.0')`
    )
    .run(name, extra.description ?? null, extra.priority ?? null)
  return Number(res.lastInsertRowid)
}

function seedTask(projectId: number, name: string, status = 'pending', sortOrder = 0): number {
  const res = db()
    .prepare('INSERT INTO tasks (project_id, name, status, sort_order) VALUES (?, ?, ?, ?)')
    .run(projectId, name, status, sortOrder)
  return Number(res.lastInsertRowid)
}

function seedDoc(projectId: number, name: string, url: string): void {
  db()
    .prepare('INSERT INTO documents (name, url, project_id) VALUES (?, ?, ?)')
    .run(name, url, projectId)
}

function dumpAll(): unknown {
  return {
    projects: db().prepare('SELECT * FROM projects ORDER BY id').all(),
    tasks: db().prepare('SELECT * FROM tasks ORDER BY id').all(),
    documents: db().prepare('SELECT * FROM documents ORDER BY id').all()
  }
}

/** 픽스처 스냅샷에서 Jira 조회 함수들이 답하게 한다 */
function mockJiraFromFixture(): void {
  const snap = projSnapshot()
  const byKey = new Map(snap.issues.map((i) => [i.key, i]))
  jira.getJiraSiteUrl.mockReturnValue(SITE_URL)
  jira.getDefaultJiraProjectKey.mockReturnValue('PROJ')
  jira.getJiraMyAccountId.mockResolvedValue(ME)
  jira.listMyTodoIssues.mockResolvedValue({
    issues: snap.triggerKeys.map((k) => byKey.get(k)),
    truncated: false
  })
  jira.listIssuesByKeys.mockImplementation(async (keys: string[]) => ({
    issues: snap.issues.filter((i) => keys.includes(i.key)),
    truncated: false
  }))
  jira.listChildIssues.mockImplementation(async (parents: string[]) => ({
    issues: snap.issues.filter((i) => i.parentKey !== null && parents.includes(i.parentKey)),
    truncated: false
  }))
  jira.listRemoteLinks.mockImplementation(async (key: string) => snap.remoteLinks[key] ?? [])
}

afterAll(() => {
  closeDatabase()
})

beforeEach(() => {
  closeDatabase()
  initDatabase()
  clearProjectSyncCache()
  for (const fn of Object.values(jira)) fn.mockReset()
  vi.restoreAllMocks()
})

describe('DB 적용', () => {
  it('신규 프로젝트를 만들고 작업 계층·문서를 함께 넣는다', () => {
    const result = applyAll(projSnapshot())

    expect(result).toMatchObject({
      created: 3,
      updated: 0,
      unchanged: 0,
      tasksAdded: 7,
      tasksUpdated: 0,
      documentsAdded: 9
    })
    // 하위 작업(PROJ-1101) 단위 건너뜀은 보고하지 않는다
    expect(result.skipped.map((s) => [s.jiraKey, s.reason])).toEqual([
      ['PROJ-2001', 'qa'],
      ['PROJ-2000', 'no_epic']
    ])

    const rows = projects()
    expect(rows.map((p) => [p.name, p.jira_issue_key, p.status, p.dev_start_date])).toEqual([
      ['알림센터 개편', 'PROJ-1855', 'scheduled', TODAY],
      ['상품 상세 크래시 수정', 'PROJ-1893', 'scheduled', TODAY],
      ['로그 개선', 'PROJ-1895', 'scheduled', TODAY]
    ])

    const epicTasks = tasksOf(rows[0].id)
    const parent = epicTasks.find((t) => t.jira_issue_key === 'PROJ-1856')!
    expect(parent.parent_task_id).toBeNull()
    expect(
      epicTasks
        .filter((t) => t.parent_task_id === parent.id)
        .map((t) => [t.jira_issue_key, t.status])
    ).toEqual([
      ['PROJ-1860', 'done'],
      ['PROJ-1861', 'pending']
    ])
    expect(epicTasks.find((t) => t.jira_issue_key === 'PROJ-1861')?.end_date).toBe('2026-10-20')
    expect(docsOf(rows[0].id).every((d) => d.type === 'link')).toBe(true)
    expect(docsOf(rows[2].id)).toEqual([
      { name: 'Jira 티켓 (PROJ-1895)', url: `${SITE_URL}/browse/PROJ-1895`, type: 'link' }
    ])

    const logs = db()
      .prepare(
        "SELECT entity_id, action FROM activity_log WHERE entity_type = 'project' ORDER BY id"
      )
      .all() as Array<{ entity_id: number; action: string }>
    expect(logs.map((l) => [l.entity_id, l.action])).toEqual(rows.map((p) => [p.id, 'create']))
  })

  it('기존 프로젝트는 보수적으로 업데이트한다 (이름·날짜·상태·우선순위·배포 버전·설명 유지)', () => {
    const id = seedProject('[알림] 알림센터 개편', { description: '내 메모', priority: 'now' })
    seedDoc(id, '에픽', `${SITE_URL}/browse/PROJ-1855/`)
    const modelTask = seedTask(id, 'API 모델 (PROJ-1860)', 'pending', 0)
    const doneTask = seedTask(id, '[PROJ-1857] UI', 'done', 1)
    const before = projects()[0]

    const result = applyAll(projSnapshot())
    expect(result.updated).toBe(1)
    expect(result.created).toBe(2)

    const after = projects().find((p) => p.id === id)!
    expect(after).toMatchObject({
      name: before.name,
      description: '내 메모',
      dev_start_date: before.dev_start_date,
      dev_end_date: before.dev_end_date,
      status: 'in_progress',
      priority: 'now',
      deploy_version: '4.170.0',
      jira_issue_key: 'PROJ-1855'
    })

    const tasks = tasksOf(id)
    const model = tasks.find((t) => t.id === modelTask)!
    expect(model).toMatchObject({
      name: 'API 모델 (PROJ-1860)',
      status: 'done',
      jira_issue_key: 'PROJ-1860'
    })
    // Jira는 처리중이지만 앱에서 완료한 작업은 되돌리지 않는다
    expect(tasks.find((t) => t.id === doneTask)).toMatchObject({
      status: 'done',
      jira_issue_key: 'PROJ-1857'
    })
    expect(tasks.filter((t) => t.jira_issue_key === 'PROJ-1856')).toHaveLength(1)

    // 끝 슬래시만 다른 에픽 링크는 다시 넣지 않는다
    const browse = docsOf(id).filter((d) => d.url.startsWith(`${SITE_URL}/browse/PROJ-1855`))
    expect(browse).toHaveLength(1)
  })

  it('매칭되지 않은 수동 프로젝트·작업·문서는 한 글자도 바뀌지 않는다', () => {
    const manual = seedProject('사내 위키 정리', { description: '수동' })
    seedTask(manual, '목차 잡기')
    seedTask(manual, '[PROJ-1234] 옛 작업', 'in_progress', 1)
    seedDoc(manual, '노션', 'https://www.notion.so/wiki')
    const before = dumpAll() as { projects: unknown[]; tasks: unknown[]; documents: unknown[] }

    applyAll(projSnapshot())

    const after = dumpAll() as typeof before
    expect(after.projects.slice(0, before.projects.length)).toEqual(before.projects)
    expect(after.tasks.slice(0, before.tasks.length)).toEqual(before.tasks)
    expect(after.documents.slice(0, before.documents.length)).toEqual(before.documents)
  })

  it('같은 스냅샷을 두 번 적용하면 두 번째는 생성·추가 0건이고 DB가 그대로다 (멱등)', () => {
    const snapshot = projSnapshot()
    applyAll(snapshot)
    const once = dumpAll()

    const second = applyAll(snapshot)

    expect(second).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 3,
      tasksAdded: 0,
      tasksUpdated: 0,
      documentsAdded: 0
    })
    expect(dumpAll()).toEqual(once)
  })

  it('Sustain 작업이 묶음 프로젝트에서 이미 추적 중이면 새 프로젝트를 만들지 않는다', () => {
    const bundle = seedProject('Android Sus 26-10')
    seedTask(bundle, '로그 개선 (PROJ-1895)')

    const result = applyAll(projSnapshot())

    expect(result.skipped).toContainEqual({
      jiraKey: 'PROJ-1895',
      summary: '로그 개선',
      reason: 'tracked_in_project',
      detail: 'Android Sus 26-10'
    })
    expect(projects().some((p) => p.jira_issue_key === 'PROJ-1895')).toBe(false)
  })
})

describe('이름 매칭은 화면에 보이는 유효 상태로 판정한다', () => {
  // 자동 상태(status_manual=0) 프로젝트는 저장 status가 생성 시점 값 그대로라
  // 날짜로 계산한 상태(applyProjectAutoStatus)를 봐야 "끝난 프로젝트"를 알 수 있다.
  function seedDated(name: string, status: string, statusManual: number): number {
    const res = db()
      .prepare(
        `INSERT INTO projects (name, dev_start_date, dev_end_date, qa_start_date, qa_end_date,
                               deploy_date, status, status_manual)
         VALUES (?, '2020-01-01', '2020-01-10', '2020-01-11', '2020-01-13', '2020-01-14', ?, ?)`
      )
      .run(name, status, statusManual)
    return Number(res.lastInsertRowid)
  }

  it('저장 status가 scheduled여도 배포일이 지난 자동 상태 동명 프로젝트에는 붙지 않는다', () => {
    const old = seedDated('알림센터 개편', 'scheduled', 0)
    const before = db().prepare('SELECT * FROM projects WHERE id = ?').get(old)

    const result = applyAll(projSnapshot())

    expect(result.created).toBe(3)
    expect(result.updated).toBe(0)
    expect(db().prepare('SELECT * FROM projects WHERE id = ?').get(old)).toEqual(before)
    expect(tasksOf(old)).toEqual([])
    expect(projects().filter((p) => p.jira_issue_key === 'PROJ-1855')).toHaveLength(1)
  })

  it('수동으로 진행 중 상태를 고정한 동명 프로젝트에는 날짜가 지났어도 매칭된다', () => {
    const pinned = seedDated('알림센터 개편', 'development', 1)

    const result = applyAll(projSnapshot())

    expect(result.updated).toBe(1)
    expect(result.created).toBe(2)
    expect(projects().find((p) => p.id === pinned)?.jira_issue_key).toBe('PROJ-1855')
  })
})

describe('R9·R10 선택 적용과 강제 업데이트', () => {
  function row(table: 'projects' | 'tasks' | 'documents', id: number): unknown {
    return db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)
  }

  /** 문서 URL로 PROJ-8855에 매칭되는 기존 프로젝트 + Jira 작업·수동 작업·수동 문서 */
  function seedNotice(): { id: number; jiraTask: number; subTask: number; manualTask: number } {
    const id = seedProject('[알림] 알림센터 개편', { description: '내 메모', priority: 'now' })
    db().prepare('UPDATE projects SET status_manual = 1, sort_order = 7 WHERE id = ?').run(id)
    seedDoc(id, '에픽', `${SITE_URL}/browse/PROJ-1855`)
    seedDoc(id, '수동 문서', 'https://www.notion.so/manual')
    const jiraTask = seedTask(id, '내가 고친 이름 (PROJ-1856)', 'done', 0)
    const subTask = seedTask(id, '바인딩 (PROJ-1861)', 'pending', 1)
    db()
      .prepare(
        "UPDATE tasks SET parent_task_id = ?, end_date = '2026-01-01', start_date = '2025-12-01' WHERE id = ?"
      )
      .run(jiraTask, subTask)
    const manualTask = seedTask(id, '수동 작업', 'in_progress', 2)
    return { id, jiraTask, subTask, manualTask }
  }

  it('R9: 선택하지 않은 항목은 프로젝트·작업·문서 어느 것도 쓰지 않는다', () => {
    seedNotice()
    const before = dumpAll()

    const result = applyProjectSyncSnapshot(
      projSnapshot(),
      [{ jiraKey: 'PROJ-1893', force: false, projectId: null }],
      TODAY
    )

    expect(result).toMatchObject({
      created: 1,
      updated: 0,
      unchanged: 0,
      tasksAdded: 2,
      documentsAdded: 1
    })
    const after = dumpAll() as { projects: unknown[]; tasks: unknown[]; documents: unknown[] }
    const prev = before as typeof after
    // 알림센터 프로젝트 행·작업·문서는 한 글자도 바뀌지 않는다(키 백필 포함)
    expect(after.projects.slice(0, prev.projects.length)).toEqual(prev.projects)
    expect(after.tasks.slice(0, prev.tasks.length)).toEqual(prev.tasks)
    expect(after.documents.slice(0, prev.documents.length)).toEqual(prev.documents)
    expect(projects().map((p) => p.jira_issue_key)).toEqual([null, 'PROJ-1893'])
  })

  it('R10: 강제 업데이트는 Jira 원본 필드만 덮어쓰고 날짜·상태·우선순위·수동 작업/문서는 그대로 둔다', () => {
    const w = seedNotice()
    const projectBefore = row('projects', w.id) as Record<string, unknown>
    const manualBefore = row('tasks', w.manualTask)
    const docsBefore = docsOf(w.id)

    const result = applyProjectSyncSnapshot(
      projSnapshot(),
      [{ jiraKey: 'PROJ-1855', force: true, projectId: w.id }],
      TODAY
    )
    expect(result).toMatchObject({ created: 0, updated: 1, tasksUpdated: 2 })

    const p = row('projects', w.id) as Record<string, unknown>
    expect(p.name).toBe('알림센터 개편')
    expect(String(p.description)).toContain('알림센터를 개편한다.')
    expect(p.jira_issue_key).toBe('PROJ-1855')
    for (const col of [
      'dev_start_date',
      'dev_end_date',
      'qa_start_date',
      'qa_end_date',
      'deploy_date',
      'status',
      'status_manual',
      'priority',
      'deploy_version',
      'sort_order',
      'created_at'
    ]) {
      expect(p[col], col).toEqual(projectBefore[col])
    }

    const jiraTask = row('tasks', w.jiraTask) as Record<string, unknown>
    // 상태 역행 허용(done → pending), 이름은 Jira 형식으로
    expect(jiraTask).toMatchObject({
      name: '알림센터 API 연동 (PROJ-1856)',
      status: 'pending',
      jira_issue_key: 'PROJ-1856'
    })
    const sub = row('tasks', w.subTask) as Record<string, unknown>
    expect(sub).toMatchObject({
      name: '화면 바인딩 (PROJ-1861)',
      end_date: '2026-10-20',
      start_date: '2025-12-01',
      parent_task_id: w.jiraTask,
      sort_order: 1
    })
    expect(row('tasks', w.manualTask)).toEqual(manualBefore)
    // 기존 문서는 그대로, 없는 문서만 추가
    expect(docsOf(w.id).slice(0, docsBefore.length)).toEqual(docsBefore)
    expect(docsOf(w.id).length).toBeGreaterThan(docsBefore.length)
  })

  it('R10: 강제 업데이트를 같은 스냅샷으로 두 번 적용하면 두 번째는 DB 변화가 없다', () => {
    const w = seedNotice()
    const selection = [{ jiraKey: 'PROJ-1855', force: true, projectId: w.id }]
    applyProjectSyncSnapshot(projSnapshot(), selection, TODAY)
    const once = dumpAll()

    const second = applyProjectSyncSnapshot(projSnapshot(), selection, TODAY)

    expect(second).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 1,
      tasksAdded: 0,
      tasksUpdated: 0,
      documentsAdded: 0
    })
    expect(dumpAll()).toEqual(once)
  })

  it('R10: 기존 프로젝트 항목이 force=false로 오면 보수적 업데이트(R5)로 적용한다', () => {
    const w = seedNotice()
    applyProjectSyncSnapshot(
      projSnapshot(),
      [{ jiraKey: 'PROJ-1855', force: false, projectId: w.id }],
      TODAY
    )
    expect(row('projects', w.id)).toMatchObject({
      name: '[알림] 알림센터 개편',
      description: '내 메모',
      jira_issue_key: 'PROJ-1855'
    })
    // 상태는 앞으로만 — done은 그대로
    expect(row('tasks', w.jiraTask)).toMatchObject({
      name: '내가 고친 이름 (PROJ-1856)',
      status: 'done'
    })
  })

  it('빈 선택·미리보기에 없는 키는 오류이고 DB를 건드리지 않는다', () => {
    seedNotice()
    const before = dumpAll()
    expect(() => applyProjectSyncSnapshot(projSnapshot(), [], TODAY)).toThrow(
      EMPTY_SELECTION_MESSAGE
    )
    expect(() =>
      applyProjectSyncSnapshot(
        projSnapshot(),
        [{ jiraKey: 'PROJ-1', force: false, projectId: null }],
        TODAY
      )
    ).toThrow(UNKNOWN_SELECTION_MESSAGE)
    expect(dumpAll()).toEqual(before)
  })

  it('R9: 미리보기 이후 매칭 프로젝트가 바뀌었으면 선택된 다른 항목까지 아무것도 쓰지 않는다', () => {
    // 미리보기 때는 PROJ-8855가 신규(projectId null)였는데, 그 사이 같은 문서를 가진 프로젝트가 생김
    seedNotice()
    const before = dumpAll()
    expect(() =>
      applyProjectSyncSnapshot(
        projSnapshot(),
        [
          { jiraKey: 'PROJ-1893', force: false, projectId: null },
          { jiraKey: 'PROJ-1855', force: true, projectId: null }
        ],
        TODAY
      )
    ).toThrow(PROJECT_CHANGED_MESSAGE)
    expect(dumpAll()).toEqual(before)
  })

  it('applyProjectSync는 선택 형식을 캐시 확인보다 먼저 검증한다', async () => {
    await expect(applyProjectSync('PROJ-1855')).rejects.toThrow(INVALID_SELECTION_MESSAGE)
    await expect(applyProjectSync([])).rejects.toThrow(EMPTY_SELECTION_MESSAGE)
  })
})

describe('preview / apply', () => {
  it('preview는 Jira에서 트리거·조상·자손을 모아 계획을 돌려주고 DB는 건드리지 않는다', async () => {
    mockJiraFromFixture()

    const plan = await previewProjectSync()

    const expected = buildProjectSyncPlan(
      projSnapshot(),
      { projects: [], tasks: [], documents: [] },
      localToday()
    )
    expect(plan.items).toEqual(expected.plan.items)
    expect(plan.skipped).toEqual(expected.plan.skipped)
    expect(projects()).toEqual([])
    // 조상(부모 작업 → 에픽) 두 단계, 자손(루트 → 작업 → 하위 작업) 두 단계
    expect(jira.listIssuesByKeys).toHaveBeenCalledTimes(2)
    expect(jira.listChildIssues).toHaveBeenCalledTimes(2)
  })

  it('apply는 10분 안이면 preview의 스냅샷을 재사용하고 Jira를 다시 조회하지 않는다', async () => {
    mockJiraFromFixture()
    await previewProjectSync()
    expect(jira.listMyTodoIssues).toHaveBeenCalledTimes(1)

    const result = await applyProjectSync(ALL_ICA)
    expect(result.created).toBe(3)
    expect(jira.listMyTodoIssues).toHaveBeenCalledTimes(1)
  })

  it('apply는 미리보기가 없거나 10분이 지났으면 다시 조회하지 않고 만료 오류를 던진다', async () => {
    mockJiraFromFixture()
    await expect(applyProjectSync(ALL_ICA)).rejects.toThrow(PREVIEW_EXPIRED_MESSAGE)

    await previewProjectSync()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000)
    await expect(applyProjectSync(ALL_ICA)).rejects.toThrow(
      '미리보기가 만료되었습니다. 다시 불러온 뒤 적용해 주세요.'
    )
    expect(jira.listMyTodoIssues).toHaveBeenCalledTimes(1)
    expect(projects()).toEqual([])
  })

  it('clearProjectSyncCache 뒤의 apply는 미리보기를 다시 요구한다', async () => {
    mockJiraFromFixture()
    await previewProjectSync()
    clearProjectSyncCache()
    await expect(applyProjectSync(ALL_ICA)).rejects.toThrow(PREVIEW_EXPIRED_MESSAGE)
    expect(projects()).toEqual([])
  })

  it('미연결·기본 프로젝트 미설정이면 조치를 담은 한국어 오류를 던진다', async () => {
    jira.getJiraSiteUrl.mockReturnValue(null)
    await expect(previewProjectSync()).rejects.toThrow('Jira에 연결되어 있지 않습니다')

    jira.getJiraSiteUrl.mockReturnValue(SITE_URL)
    jira.getDefaultJiraProjectKey.mockReturnValue(null)
    await expect(previewProjectSync()).rejects.toThrow('Jira 기본 프로젝트가 설정되지 않았습니다')
    expect(jira.listMyTodoIssues).not.toHaveBeenCalled()
  })
})
