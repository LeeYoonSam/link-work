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
import { issue, ME, OTHER, SITE_URL, projSnapshot } from './__fixtures__/project-sync/proj-snapshot'
import type { JiraSyncIssue } from './jira'
import {
  applyProjectSync,
  applyProjectSyncSnapshot,
  clearProjectSyncCache,
  hasFreshPreview,
  PREVIEW_EXPIRED_MESSAGE,
  previewProjectSync,
  readProjectSyncDbState,
  PROJECT_NOT_FOUND_MESSAGE,
  PROJECT_NOT_LINKED_MESSAGE,
  readSyncCreatedKeys,
  refreshAllJiraProjects,
  refreshProjectJiraTasks,
  runAutoProjectSync,
  SYNC_CREATED_KEYS_SETTING,
  TASK_REFRESH_ENTER_INTERVAL_MS
} from './project-sync'
import {
  buildProjectSyncPlan,
  EMPTY_SELECTION_MESSAGE,
  INVALID_SELECTION_MESSAGE,
  localToday,
  PROJECT_CHANGED_MESSAGE,
  TASK_REFRESH_LOG_LABEL,
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

describe('R11 아침 자동 싱크업 (runAutoProjectSync)', () => {
  function createdKeysSetting(): unknown {
    const row = db()
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(SYNC_CREATED_KEYS_SETTING) as { value: string } | undefined
    return row ? JSON.parse(row.value) : null
  }

  /** 사용자가 프로젝트를 지운 상황. 테스트 인메모리 DB 에서만 지운다 */
  function removeProject(id: number): void {
    db().prepare('DELETE FROM tasks WHERE project_id = ?').run(id)
    db().prepare('DELETE FROM documents WHERE project_id = ?').run(id)
    db().prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  it('R11: 새 프로젝트는 만들고 jira_key 기존 프로젝트는 보수 갱신만 한다 (덮어쓰기 없음)', async () => {
    mockJiraFromFixture()
    const keyed = seedProject('[알림] 내가 고친 이름', {
      description: '내 메모',
      priority: 'now'
    })
    db().prepare("UPDATE projects SET jira_issue_key = 'PROJ-1855' WHERE id = ?").run(keyed)
    const doneTask = seedTask(keyed, '내가 고친 작업 (PROJ-1856)', 'done', 0)
    const before = db().prepare('SELECT * FROM projects WHERE id = ?').get(keyed) as Record<
      string,
      unknown
    >

    const outcome = await runAutoProjectSync()

    expect(outcome).toMatchObject({
      status: 'applied',
      result: { created: 2, updated: 1 },
      needsReview: 0,
      previouslyCreated: 0
    })
    const after = db().prepare('SELECT * FROM projects WHERE id = ?').get(keyed) as Record<
      string,
      unknown
    >
    for (const col of [
      'name',
      'description',
      'dev_start_date',
      'dev_end_date',
      'status',
      'priority',
      'deploy_version'
    ]) {
      expect(after[col], col).toEqual(before[col])
    }
    // 보수 경로: 기존 작업 이름은 그대로, 상태는 되돌리지 않는다
    expect(tasksOf(keyed).find((t) => t.id === doneTask)).toMatchObject({
      name: '내가 고친 작업 (PROJ-1856)',
      status: 'done'
    })
    expect(projects().map((p) => p.jira_issue_key)).toEqual(['PROJ-1855', 'PROJ-1893', 'PROJ-1895'])
  })

  it('R11: 이름·문서로 처음 매칭되는 프로젝트는 쓰지 않고 needsReview 로만 센다', async () => {
    mockJiraFromFixture()
    const byName = seedProject('상품 상세 크래시 수정', {
      description: '수동'
    })
    // 자동 상태면 지난 날짜 때문에 끝난 프로젝트로 보여 이름 매칭 후보에서 빠진다(§4). 진행 중으로 고정한다.
    db().prepare('UPDATE projects SET status_manual = 1 WHERE id = ?').run(byName)
    const byDoc = seedProject('문서로만 연결')
    seedDoc(byDoc, '티켓', `${SITE_URL}/browse/PROJ-1895`)
    const before = dumpAll()

    const outcome = await runAutoProjectSync()

    expect(outcome).toMatchObject({
      status: 'applied',
      result: { created: 1, updated: 0 },
      needsReview: 2
    })
    const after = dumpAll() as {
      projects: unknown[]
      tasks: unknown[]
      documents: unknown[]
    }
    const prev = before as typeof after
    // 키 백필도 하지 않는다
    expect(after.projects.slice(0, prev.projects.length)).toEqual(prev.projects)
    expect(after.documents.slice(0, prev.documents.length)).toEqual(prev.documents)
    expect(projects().find((p) => p.id === byName)?.jira_issue_key).toBeNull()
  })

  it('R11: 같은 Jira 상태로 두 번째 실행하면 선택 0건이라 apply 를 부르지 않고 DB 가 그대로다', async () => {
    mockJiraFromFixture()
    await runAutoProjectSync()
    const once = dumpAll()
    const logCount = (
      db().prepare('SELECT COUNT(*) AS n FROM activity_log').get() as {
        n: number
      }
    ).n

    const second = await runAutoProjectSync()

    expect(second).toMatchObject({
      status: 'applied',
      result: {
        created: 0,
        updated: 0,
        unchanged: 0,
        tasksAdded: 0,
        documentsAdded: 0,
        applied: []
      },
      needsReview: 0,
      previouslyCreated: 0
    })
    expect(dumpAll()).toEqual(once)
    expect(
      (
        db().prepare('SELECT COUNT(*) AS n FROM activity_log').get() as {
          n: number
        }
      ).n
    ).toBe(logCount)
  })

  it('R11: 싱크업이 만든 프로젝트를 사용자가 지우면 다시 만들지 않는다', async () => {
    mockJiraFromFixture()
    applyAll(projSnapshot())
    const removed = projects().find((p) => p.jira_issue_key === 'PROJ-1893')!
    removeProject(removed.id)

    const outcome = await runAutoProjectSync()

    expect(outcome).toMatchObject({
      status: 'applied',
      result: { created: 0 },
      previouslyCreated: 1
    })
    expect(projects().some((p) => p.jira_issue_key === 'PROJ-1893')).toBe(false)
  })

  it('R11: app_settings 기록이 없어도 과거 activity_log 생성 행으로 지운 프로젝트를 알아본다', async () => {
    mockJiraFromFixture()
    db()
      .prepare(
        "INSERT INTO activity_log (entity_type, entity_id, entity_name, action, details) VALUES ('project', 99, '로그 개선', 'create', ?)"
      )
      .run('Jira 싱크업 (PROJ-1895): 작업 +0 · 작업 갱신 0 · 문서 +1')
    // 싱크업과 무관한 수동 생성 행은 키로 읽지 않는다
    db()
      .prepare(
        "INSERT INTO activity_log (entity_type, entity_id, entity_name, action, details) VALUES ('project', 98, '수동', 'create', '직접 생성')"
      )
      .run()
    expect(createdKeysSetting()).toBeNull()
    expect([...readSyncCreatedKeys()]).toEqual(['PROJ-1895'])

    const outcome = await runAutoProjectSync()

    expect(outcome).toMatchObject({
      status: 'applied',
      result: { created: 2 },
      previouslyCreated: 1
    })
    expect(projects().some((p) => p.jira_issue_key === 'PROJ-1895')).toBe(false)
  })

  it('R11: 만든 키를 app_settings project_sync_created_keys 에 합쳐 기록한다 (수동·자동 모두)', async () => {
    applyProjectSyncSnapshot(
      projSnapshot(),
      [{ jiraKey: 'PROJ-1893', force: false, projectId: null }],
      TODAY
    )
    expect(createdKeysSetting()).toEqual(['PROJ-1893'])

    mockJiraFromFixture()
    const outcome = await runAutoProjectSync()

    expect(outcome).toMatchObject({ status: 'applied', result: { created: 2 } })
    expect(createdKeysSetting()).toEqual(['PROJ-1855', 'PROJ-1893', 'PROJ-1895'])
    expect([...readSyncCreatedKeys()].sort()).toEqual(['PROJ-1855', 'PROJ-1893', 'PROJ-1895'])
    // 자동 적용 행은 '아침 자동 싱크업' 머리말로 남는다
    const autoLogs = db()
      .prepare(
        "SELECT details FROM activity_log WHERE entity_type = 'project' AND details LIKE '아침 자동 싱크업 (%'"
      )
      .all() as Array<{ details: string }>
    expect(autoLogs).toHaveLength(2)
  })

  it('R11: 10분 안의 미리보기가 있으면 deferred 이고 Jira 조회·쓰기·캐시 변경이 없다', async () => {
    mockJiraFromFixture()
    await previewProjectSync()
    expect(hasFreshPreview()).toBe(true)

    expect(await runAutoProjectSync()).toEqual({ status: 'deferred' })
    expect(jira.listMyTodoIssues).toHaveBeenCalledTimes(1)
    expect(projects()).toEqual([])
    // 사용자가 보던 미리보기는 그대로 적용할 수 있다
    expect((await applyProjectSync(ALL_ICA)).created).toBe(3)
  })

  it('R11: 미리보기가 10분 지났으면 미루지 않고 실행한다', async () => {
    mockJiraFromFixture()
    await previewProjectSync()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000)
    expect(hasFreshPreview()).toBe(false)

    expect(await runAutoProjectSync()).toMatchObject({
      status: 'applied',
      result: { created: 3 }
    })
  })

  it('R11: Jira 미연결·기본 프로젝트 키 없음은 조회 없이 throw 한다 (호출자가 먼저 skipped 로 거른다)', async () => {
    jira.getJiraSiteUrl.mockReturnValue(null)
    await expect(runAutoProjectSync()).rejects.toThrow('Jira에 연결되어 있지 않습니다')

    jira.getJiraSiteUrl.mockReturnValue(SITE_URL)
    jira.getDefaultJiraProjectKey.mockReturnValue(null)
    await expect(runAutoProjectSync()).rejects.toThrow('Jira 기본 프로젝트가 설정되지 않았습니다')
    expect(jira.listMyTodoIssues).not.toHaveBeenCalled()
    expect(projects()).toEqual([])
  })

  it('R11: 자동 실행은 수동 미리보기 캐시를 만들지 않는다 (실행 전후 캐시가 같다)', async () => {
    mockJiraFromFixture()
    expect(hasFreshPreview()).toBe(false)

    await runAutoProjectSync()

    expect(hasFreshPreview()).toBe(false)
    await expect(applyProjectSync(ALL_ICA)).rejects.toThrow(PREVIEW_EXPIRED_MESSAGE)
  })

  it('R11: Jira 조회가 실패하면 throw 하고 DB 를 건드리지 않는다 (호출자가 failed 로 기록)', async () => {
    mockJiraFromFixture()
    jira.listMyTodoIssues.mockRejectedValue(new Error('Jira 토큰이 만료되었습니다.'))

    await expect(runAutoProjectSync()).rejects.toThrow('Jira 토큰이 만료되었습니다.')
    expect(projects()).toEqual([])
  })

  it('R11: applied 는 쓴 항목을 계획 순서로 담고 create 는 새 id 를 갖는다', () => {
    const result = applyAll(projSnapshot())
    const rows = projects()
    expect(result.applied).toEqual(
      rows.map((p) => ({
        jiraKey: p.jira_issue_key,
        action: 'create',
        projectId: p.id,
        projectName: p.name,
        force: false
      }))
    )
  })
})

// ── R12: Jira 연결 작업 새로고침 ──

const ROOT = 'PROJ-9046'

/**
 * R12 시나리오. 에픽 ROOT(처리중) 아래:
 * - 9047 해결됨(done) / 9053 리뷰중(indeterminate) / 9050 할 일(new): DB 에 연결된 작업
 * - 9054 하위 작업(9053 아래, 내 담당): DB 에 없음 → 기존 상위 아래 새 하위 작업
 * - 9060 작업 + 9061 하위 작업: DB 에 없음 → 새 상위·하위
 * - 9055 처리중: DB 에 키 없이 이름에 (PROJ-9055) 만 있음 → 백필 + 상태
 * - 9070 남의 작업: 추가하지 않는다
 */
function r12Issues(): JiraSyncIssue[] {
  return [
    issue(ROOT, 'PDP 소셜 프루프', 'epic', 'doing'),
    issue('PROJ-9047', '랭킹 API', 'task', 'done', { parentKey: ROOT }),
    issue('PROJ-9050', '로그 정의', 'task', 'todo', { parentKey: ROOT }),
    issue('PROJ-9053', '배지 UI', 'task', 'doing', { parentKey: ROOT }),
    issue('PROJ-9054', '배지 애니메이션', 'subtask', 'todo', { parentKey: 'PROJ-9053' }),
    issue('PROJ-9055', '결제 화면', 'task', 'doing', { parentKey: ROOT }),
    issue('PROJ-9060', '카테고리 베스트', 'task', 'todo', { parentKey: ROOT, duedate: '2026-12-01' }),
    issue('PROJ-9061', '베스트 순위 바인딩', 'subtask', 'todo', { parentKey: 'PROJ-9060' }),
    issue('PROJ-9070', '서버 캐시', 'task', 'todo', { parentKey: ROOT, assigneeAccountId: OTHER })
  ]
}

function mockJiraIssues(issues: JiraSyncIssue[]): void {
  jira.getJiraSiteUrl.mockReturnValue(SITE_URL)
  jira.getDefaultJiraProjectKey.mockReturnValue('PROJ')
  jira.getJiraMyAccountId.mockResolvedValue(ME)
  jira.listIssuesByKeys.mockImplementation(async (keys: string[]) => ({
    issues: issues.filter((i) => keys.includes(i.key)),
    truncated: false
  }))
  jira.listChildIssues.mockImplementation(async (parents: string[]) => ({
    issues: issues.filter((i) => i.parentKey !== null && parents.includes(i.parentKey)),
    truncated: false
  }))
}

/** Jira 키가 있는 프로젝트. status_manual=1 로 유효 상태를 날짜와 무관하게 고정한다 */
function seedLinkedProject(name: string, key: string | null, status = 'in_progress'): number {
  const res = db()
    .prepare(
      `INSERT INTO projects (name, description, dev_start_date, dev_end_date, qa_start_date, qa_end_date,
                             deploy_date, status, status_manual, priority, jira_issue_key)
       VALUES (?, '내 메모', '2026-11-01', '2026-11-20', '2026-11-21', '2026-11-25', '2026-12-01', ?, 1, 'now', ?)`
    )
    .run(name, status, key)
  return Number(res.lastInsertRowid)
}

function seedLinkedTask(
  projectId: number,
  name: string,
  status: string,
  key: string | null,
  extra: { sortOrder?: number; endDate?: string | null; parentId?: number | null } = {}
): number {
  const res = db()
    .prepare(
      `INSERT INTO tasks (project_id, name, status, sort_order, jira_issue_key, end_date, parent_task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      projectId,
      name,
      status,
      extra.sortOrder ?? 0,
      key,
      extra.endDate ?? null,
      extra.parentId ?? null
    )
  return Number(res.lastInsertRowid)
}

interface R12Seed {
  projectId: number
  done: number
  review: number
  reverted: number
  byName: number
  manual: number
  gone: number
}

/** ICA-9046 실례를 본뜬 DB. 상태가 Jira 와 어긋나 있다 */
function seedR12(): R12Seed {
  const projectId = seedLinkedProject('PDP 소셜 프루프 넛징', ROOT)
  return {
    projectId,
    done: seedLinkedTask(projectId, '랭킹 API 내가 고친 이름', 'in_progress', 'PROJ-9047', {
      sortOrder: 0,
      endDate: '2026-11-15'
    }),
    review: seedLinkedTask(projectId, '배지 UI (PROJ-9053)', 'pending', 'PROJ-9053', { sortOrder: 1 }),
    reverted: seedLinkedTask(projectId, '로그 정의 (PROJ-9050)', 'done', 'PROJ-9050', { sortOrder: 2 }),
    byName: seedLinkedTask(projectId, '결제 화면 (PROJ-9055)', 'pending', null, { sortOrder: 3 }),
    manual: seedLinkedTask(projectId, '수동 메모', 'in_progress', null, { sortOrder: 4 }),
    gone: seedLinkedTask(projectId, '지워진 이슈 (PROJ-9999)', 'pending', 'PROJ-9999', { sortOrder: 5 })
  }
}

function taskById(id: number): TaskRow & { sort_order: number } {
  return db().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow & {
    sort_order: number
  }
}

function jiraCallCount(): number {
  return (
    jira.listIssuesByKeys.mock.calls.length +
    jira.listChildIssues.mock.calls.length +
    jira.getJiraMyAccountId.mock.calls.length
  )
}

function r12Logs(): Array<{ entity_id: number; action: string; details: string }> {
  return db()
    .prepare(
      "SELECT entity_id, action, details FROM activity_log WHERE entity_type = 'project' ORDER BY id"
    )
    .all() as unknown as Array<{ entity_id: number; action: string; details: string }>
}

describe('R12 Jira 연결 작업 새로고침 (refreshProjectJiraTasks)', () => {
  it('R12: 연결 작업 상태를 역행 포함 Jira 값으로 맞추고 수동 작업·못 찾은 키는 그대로 둔다', async () => {
    mockJiraIssues(r12Issues())
    const seed = seedR12()

    const result = await refreshProjectJiraTasks(seed.projectId, { reason: 'manual' })

    expect(taskById(seed.done).status).toBe('done')
    expect(taskById(seed.review).status).toBe('in_progress')
    // 앱에서 완료했어도 Jira 가 할 일이면 되돌린다
    expect(taskById(seed.reverted).status).toBe('pending')
    expect(taskById(seed.manual)).toMatchObject({ status: 'in_progress', jira_issue_key: null })
    expect(taskById(seed.gone)).toMatchObject({ status: 'pending', jira_issue_key: 'PROJ-9999' })
    expect(result).toMatchObject({
      projectId: seed.projectId,
      skipped: false,
      // 9047·9053·9050 + 이름 매칭 9055
      statusChanged: 4,
      missingKeys: ['PROJ-9999']
    })
    expect(Number.isNaN(Date.parse(result.refreshedAt))).toBe(false)

    const logs = r12Logs()
    expect(logs).toEqual([
      {
        entity_id: seed.projectId,
        action: 'update',
        details: `${TASK_REFRESH_LOG_LABEL} (${ROOT}): 상태 4건, 작업 추가 ${result.tasksAdded}건`
      }
    ])
  })

  it('R12: 이름으로 매칭된 작업은 키를 백필하고 상태도 Jira 값으로 맞춘다', async () => {
    mockJiraIssues(r12Issues())
    const seed = seedR12()

    await refreshProjectJiraTasks(seed.projectId)

    expect(taskById(seed.byName)).toMatchObject({
      name: '결제 화면 (PROJ-9055)',
      jira_issue_key: 'PROJ-9055',
      status: 'in_progress'
    })
  })

  it('R12: Jira 에 새로 생긴 작업·하위 작업을 추가하고 parent 를 연결한다. 남의 작업은 추가하지 않는다', async () => {
    mockJiraIssues(r12Issues())
    const seed = seedR12()

    const result = await refreshProjectJiraTasks(seed.projectId)

    const tasks = tasksOf(seed.projectId)
    const byKey = (k: string): TaskRow | undefined => tasks.find((t) => t.jira_issue_key === k)
    const best = byKey('PROJ-9060')!
    expect(best).toMatchObject({
      name: '카테고리 베스트 (PROJ-9060)',
      status: 'pending',
      end_date: '2026-12-01',
      parent_task_id: null
    })
    // 이번에 함께 만든 상위 작업 아래
    expect(byKey('PROJ-9061')).toMatchObject({
      name: '베스트 순위 바인딩 (PROJ-9061)',
      parent_task_id: best.id
    })
    // 이미 있던 상위 작업 아래
    expect(byKey('PROJ-9054')).toMatchObject({ parent_task_id: seed.review })
    expect(byKey('PROJ-9070')).toBeUndefined()
    expect(result.tasksAdded).toBe(3)
    // 키마다 작업은 하나만 있다
    const keys = tasks.map((t) => t.jira_issue_key).filter((k): k is string => k !== null)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('R12: 기존 작업의 이름·마감일·순서·상위와 프로젝트 필드·문서는 바꾸지 않는다', async () => {
    mockJiraIssues(r12Issues())
    const seed = seedR12()
    seedDoc(seed.projectId, '기획서', 'https://www.notion.so/acme/pdp')
    const projectBefore = db().prepare('SELECT * FROM projects WHERE id = ?').get(seed.projectId)
    const docsBefore = docsOf(seed.projectId)
    const pick = (id: number): unknown => {
      const t = taskById(id)
      return [t.name, t.end_date, t.sort_order, t.parent_task_id]
    }
    const ids = [seed.done, seed.review, seed.reverted, seed.byName, seed.manual, seed.gone]
    const before = ids.map(pick)

    await refreshProjectJiraTasks(seed.projectId)

    expect(ids.map(pick)).toEqual(before)
    expect(taskById(seed.done).name).toBe('랭킹 API 내가 고친 이름')
    expect(taskById(seed.done).end_date).toBe('2026-11-15')
    expect(db().prepare('SELECT * FROM projects WHERE id = ?').get(seed.projectId)).toEqual(
      projectBefore
    )
    expect(docsOf(seed.projectId)).toEqual(docsBefore)
  })

  it('R12: 같은 Jira 값으로 두 번 돌리면 두 번째는 변경 0건이고 DB·활동 로그가 그대로다 (R8 멱등)', async () => {
    mockJiraIssues(r12Issues())
    const seed = seedR12()

    await refreshProjectJiraTasks(seed.projectId)
    const once = dumpAll()
    const logsOnce = r12Logs().length

    const second = await refreshProjectJiraTasks(seed.projectId)
    expect(second).toMatchObject({ skipped: false, statusChanged: 0, tasksAdded: 0 })
    expect(dumpAll()).toEqual(once)
    expect(r12Logs()).toHaveLength(logsOnce)
  })

  it('R12: 다른 프로젝트의 작업은 건드리지 않는다', async () => {
    mockJiraIssues(r12Issues())
    const seed = seedR12()
    const other = seedLinkedProject('다른 프로젝트', 'PROJ-1')
    const otherTask = seedLinkedTask(other, '같은 키 다른 프로젝트', 'pending', 'PROJ-9047')

    await refreshProjectJiraTasks(seed.projectId)

    expect(taskById(otherTask)).toMatchObject({ status: 'pending', jira_issue_key: 'PROJ-9047' })
  })

  it('R12: Jira 키 없는 프로젝트·없는 프로젝트는 오류이고 Jira 를 부르지 않는다', async () => {
    mockJiraIssues(r12Issues())
    const manual = seedLinkedProject('수동 프로젝트', null)

    await expect(refreshProjectJiraTasks(manual)).rejects.toThrow(PROJECT_NOT_LINKED_MESSAGE)
    await expect(refreshProjectJiraTasks(9999)).rejects.toThrow(PROJECT_NOT_FOUND_MESSAGE)
    expect(jiraCallCount()).toBe(0)
  })

  it('R12: Jira 미연결이면 조치를 담은 오류를 던지고 DB 를 건드리지 않는다', async () => {
    mockJiraIssues(r12Issues())
    jira.getJiraSiteUrl.mockReturnValue(null)
    const seed = seedR12()
    const before = dumpAll()

    await expect(refreshProjectJiraTasks(seed.projectId)).rejects.toThrow(/Jira에 연결되어 있지 않습니다/)
    expect(dumpAll()).toEqual(before)
    expect(jiraCallCount()).toBe(0)
  })

  it('R12: Jira 조회가 실패하면 throw 하고 DB 를 건드리지 않는다', async () => {
    mockJiraIssues(r12Issues())
    jira.listChildIssues.mockRejectedValue(new Error('401'))
    const seed = seedR12()
    const before = dumpAll()

    await expect(refreshProjectJiraTasks(seed.projectId)).rejects.toThrow('401')
    expect(dumpAll()).toEqual(before)
  })

  it('R12: enter 는 5분 안 재호출이면 Jira 를 부르지 않고 skipped 다. 5분이 지나면 다시 실행한다', async () => {
    mockJiraIssues(r12Issues())
    const seed = seedR12()
    const t0 = Date.UTC(2026, 10, 11, 0, 0, 0)
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0)

    const first = await refreshProjectJiraTasks(seed.projectId, { reason: 'enter' })
    expect(first.skipped).toBe(false)
    const calls = jiraCallCount()

    now.mockReturnValue(t0 + TASK_REFRESH_ENTER_INTERVAL_MS - 1)
    const second = await refreshProjectJiraTasks(seed.projectId, { reason: 'enter' })
    expect(second).toMatchObject({
      projectId: seed.projectId,
      skipped: true,
      statusChanged: 0,
      tasksAdded: 0,
      missingKeys: [],
      refreshedAt: new Date(t0).toISOString()
    })
    expect(jiraCallCount()).toBe(calls)

    now.mockReturnValue(t0 + TASK_REFRESH_ENTER_INTERVAL_MS)
    const third = await refreshProjectJiraTasks(seed.projectId, { reason: 'enter' })
    expect(third.skipped).toBe(false)
    expect(jiraCallCount()).toBeGreaterThan(calls)
  })

  it('R12: manual 은 5분 안이어도 실행한다. manual 도 진입 새로고침 시각을 기록한다', async () => {
    mockJiraIssues(r12Issues())
    const seed = seedR12()
    const t0 = Date.UTC(2026, 10, 11, 0, 0, 0)
    vi.spyOn(Date, 'now').mockReturnValue(t0)

    await refreshProjectJiraTasks(seed.projectId, { reason: 'manual' })
    const calls = jiraCallCount()
    const again = await refreshProjectJiraTasks(seed.projectId, { reason: 'manual' })
    expect(again.skipped).toBe(false)
    expect(jiraCallCount()).toBeGreaterThan(calls)

    const afterManual = jiraCallCount()
    const enter = await refreshProjectJiraTasks(seed.projectId, { reason: 'enter' })
    expect(enter.skipped).toBe(true)
    expect(jiraCallCount()).toBe(afterManual)
  })

  it('R12: 실패한 새로고침은 시각을 기록하지 않는다. 다음 진입에서 다시 조회한다', async () => {
    mockJiraIssues(r12Issues())
    const seed = seedR12()
    jira.listChildIssues.mockRejectedValueOnce(new Error('network'))

    await expect(refreshProjectJiraTasks(seed.projectId, { reason: 'enter' })).rejects.toThrow('network')
    const again = await refreshProjectJiraTasks(seed.projectId, { reason: 'enter' })
    expect(again.skipped).toBe(false)
  })

  it('R12: Sustain 작업 루트는 그 하위 작업을 최상위 작업으로 추가한다', async () => {
    mockJiraIssues([
      issue('PROJ-1893', '상품 상세 크래시 수정', 'task', 'doing', { parentKey: 'PROJ-1892' }),
      issue('PROJ-1894', '원인 분석', 'subtask', 'done', { parentKey: 'PROJ-1893' }),
      issue('PROJ-1896', '수정 배포', 'subtask', 'todo', { parentKey: 'PROJ-1893' })
    ])
    const projectId = seedLinkedProject('상품 상세 크래시 수정', 'PROJ-1893')
    const existing = seedLinkedTask(projectId, '원인 분석 (PROJ-1894)', 'in_progress', 'PROJ-1894')

    const result = await refreshProjectJiraTasks(projectId)

    expect(result).toMatchObject({ statusChanged: 1, tasksAdded: 1 })
    expect(taskById(existing).status).toBe('done')
    expect(tasksOf(projectId).find((t) => t.jira_issue_key === 'PROJ-1896')).toMatchObject({
      parent_task_id: null,
      status: 'pending'
    })
    // 에픽이 아니면 손자 조회를 하지 않는다
    expect(jira.listChildIssues).toHaveBeenCalledTimes(1)
  })

  it('R12: 루트 이슈를 Jira 에서 못 찾으면 새 작업은 추가하지 않고 연결 작업 상태만 맞춘다', async () => {
    mockJiraIssues(r12Issues().filter((i) => i.key !== ROOT))
    const seed = seedR12()

    const result = await refreshProjectJiraTasks(seed.projectId)

    expect(result.tasksAdded).toBe(0)
    expect(taskById(seed.done).status).toBe('done')
    expect(taskById(seed.reverted).status).toBe('pending')
    expect(jira.listChildIssues).not.toHaveBeenCalled()
  })

  it('R12: 미리보기 캐시를 만들거나 바꾸지 않는다', async () => {
    mockJiraIssues(r12Issues())
    const seed = seedR12()
    await refreshProjectJiraTasks(seed.projectId)
    expect(hasFreshPreview()).toBe(false)

    // 미리보기가 있으면 새로고침 뒤에도 같은 미리보기로 적용할 수 있다
    mockJiraFromFixture()
    const plan = await previewProjectSync()
    const fixtureIssues = projSnapshot().issues
    const merged = [...fixtureIssues, ...r12Issues()]
    jira.listIssuesByKeys.mockImplementation(async (keys: string[]) => ({
      issues: merged.filter((i) => keys.includes(i.key)),
      truncated: false
    }))
    jira.listChildIssues.mockImplementation(async (parents: string[]) => ({
      issues: merged.filter((i) => i.parentKey !== null && parents.includes(i.parentKey)),
      truncated: false
    }))
    jira.listMyTodoIssues.mockClear()

    await refreshProjectJiraTasks(seed.projectId)

    expect(hasFreshPreview()).toBe(true)
    expect(jira.listMyTodoIssues).not.toHaveBeenCalled()
    const result = await applyProjectSync(
      plan.items.map((i) => ({ jiraKey: i.jiraKey, force: false, projectId: i.projectId }))
    )
    expect(result.created).toBe(plan.items.filter((i) => i.action === 'create').length)
  })
})

describe('R12 아침 일괄 새로고침 (refreshAllJiraProjects)', () => {
  it('R12: 끝난 프로젝트(completed·cancelled)와 키 없는 프로젝트는 건너뛰고 합계를 돌려준다', async () => {
    mockJiraIssues(r12Issues())
    const seed = seedR12()
    const completed = seedLinkedProject('끝난 프로젝트', 'PROJ-500', 'completed')
    const cancelled = seedLinkedProject('취소된 프로젝트', 'PROJ-600', 'cancelled')
    seedLinkedProject('수동 프로젝트', null)
    const doneTask = seedLinkedTask(completed, '끝난 작업 (PROJ-9047)', 'pending', 'PROJ-9047')
    const cancelledTask = seedLinkedTask(cancelled, '취소 작업 (PROJ-9047)', 'pending', 'PROJ-9047')

    const total = await refreshAllJiraProjects()

    expect(total).toEqual({ projects: 1, statusChanged: 4, tasksAdded: 3 })
    const rootQueries = jira.listIssuesByKeys.mock.calls.map((c) => c[0] as string[])
    expect(rootQueries.some((keys) => keys.includes('PROJ-500') || keys.includes('PROJ-600'))).toBe(false)
    expect(taskById(doneTask).status).toBe('pending')
    expect(taskById(cancelledTask).status).toBe('pending')
    expect(taskById(seed.done).status).toBe('done')
    // 계정 조회는 한 번만 한다
    expect(jira.getJiraMyAccountId).toHaveBeenCalledTimes(1)
  })

  it('R12: 자동 상태가 날짜로 끝난 프로젝트도 건너뛴다 (유효 상태 기준)', async () => {
    mockJiraIssues(r12Issues())
    // 배포일이 지난 자동 상태 프로젝트 — 화면에는 완료로 보인다
    const past = seedProject('지난 프로젝트')
    db().prepare('UPDATE projects SET jira_issue_key = ? WHERE id = ?').run(ROOT, past)

    const total = await refreshAllJiraProjects()

    expect(total).toEqual({ projects: 0, statusChanged: 0, tasksAdded: 0 })
    expect(jiraCallCount()).toBe(0)
  })

  it('R12: 한 프로젝트가 실패해도 나머지를 계속한다', async () => {
    const issues = r12Issues()
    mockJiraIssues(issues)
    const broken = seedLinkedProject('먼저 실패', 'PROJ-100')
    const seed = seedR12()
    jira.listIssuesByKeys.mockImplementation(async (keys: string[]) => {
      if (keys.includes('PROJ-100')) throw new Error('403')
      return { issues: issues.filter((i) => keys.includes(i.key)), truncated: false }
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const total = await refreshAllJiraProjects()

    expect(errSpy).toHaveBeenCalled()
    expect(total.projects).toBe(1)
    expect(taskById(seed.done).status).toBe('done')
    expect(broken).toBeGreaterThan(0)
  })

  it('R12: 대상이 모두 실패하면 첫 오류를 throw 한다 (호출자가 failed 로 기록)', async () => {
    mockJiraIssues(r12Issues())
    seedR12()
    jira.getJiraMyAccountId.mockRejectedValue(new Error('token expired'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(refreshAllJiraProjects()).rejects.toThrow('token expired')
  })

  it('R12: 대상이 없으면 Jira 를 부르지 않고 0건이다', async () => {
    mockJiraIssues(r12Issues())
    seedLinkedProject('수동 프로젝트', null)

    expect(await refreshAllJiraProjects()).toEqual({ projects: 0, statusChanged: 0, tasksAdded: 0 })
    expect(jiraCallCount()).toBe(0)
  })
})
