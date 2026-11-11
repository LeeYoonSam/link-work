import { describe, expect, it } from 'vitest'
import {
  ME,
  OTHER,
  SITE_URL,
  NOTICE_DESCRIPTION,
  projSnapshot,
  issue
} from './__fixtures__/project-sync/proj-snapshot'
import {
  REFRESH_PROJECT_ID,
  REFRESH_ROOT_KEY,
  refreshIssues,
  refreshSnapshot,
  refreshTask,
  refreshTasks
} from './__fixtures__/project-sync/task-refresh-snapshot'
import type { JiraSyncIssue } from './jira'
import { adfToPlainText, extractAdfLinks, guessLinkName } from './project-sync-adf'
import {
  browseKeyOf,
  buildProjectSyncPlan,
  buildTaskRefreshPlan,
  EMPTY_SELECTION_MESSAGE,
  INVALID_SELECTION_MESSAGE,
  normalizeProjectName,
  parseProjectSyncSelection,
  parseSyncCreatedKey,
  PROJECT_CHANGED_MESSAGE,
  selectAutoSyncSelection,
  selectProjectSyncOps,
  SYNC_LOG_LABELS,
  TASK_REFRESH_LOG_LABEL,
  UNKNOWN_SELECTION_MESSAGE,
  type DbSyncState,
  type DbTaskRow,
  type JiraSyncSnapshot,
  type ProjectSyncComputation,
  type ProjectSyncOp,
  type ProjectSyncSelection,
  type TaskRefreshPlan
} from './project-sync-plan'

const TODAY = '2026-10-02'

function emptyDb(): DbSyncState {
  return { projects: [], tasks: [], documents: [] }
}

function plan(snapshot: JiraSyncSnapshot, db: DbSyncState = emptyDb()): ProjectSyncComputation {
  return buildProjectSyncPlan(snapshot, db, TODAY)
}

function opFor(c: ProjectSyncComputation, key: string): ProjectSyncOp {
  const op = c.ops.find((o) => o.item.jiraKey === key)
  if (!op) throw new Error(`op 없음: ${key}`)
  return op
}

/** 최소 스냅샷: 주어진 이슈와 트리거만 */
function snapshotOf(issues: JiraSyncIssue[], triggerKeys: string[]): JiraSyncSnapshot {
  return {
    siteUrl: SITE_URL,
    myAccountId: ME,
    triggerKeys,
    issues,
    remoteLinks: {},
    truncated: false,
    fetchedAt: '2026-10-02T00:00:00.000Z'
  }
}

/** 계획을 인메모리 DB 상태에 적용한다 — project-sync.ts의 writeOps와 같은 의미 */
/** 계획의 모든 항목을 같은 force로 고른 선택 */
function selectAll(c: ProjectSyncComputation, force = false): ProjectSyncSelection[] {
  return c.plan.items.map((i) => ({ jiraKey: i.jiraKey, force, projectId: i.projectId }))
}

/**
 * 계획을 인메모리 DB 상태에 적용한다 — project-sync.ts의 writeOps와 같은 의미.
 * selection을 안 주면 전 항목을 보수적(force=false)으로 적용한다.
 */
function applyInMemory(
  db: DbSyncState,
  c: ProjectSyncComputation,
  selection: ProjectSyncSelection[] = selectAll(c)
): DbSyncState {
  const next: DbSyncState = {
    projects: db.projects.map((p) => ({ ...p })),
    tasks: db.tasks.map((t) => ({ ...t })),
    documents: db.documents.map((d) => ({ ...d }))
  }
  if (selection.length === 0) return next
  let id = 1000
  for (const { op, force, action } of selectProjectSyncOps(c, selection)) {
    if (action === 'unchanged') continue
    let projectId: number
    if (op.project.kind === 'create') {
      projectId = id++
      next.projects.push({
        id: projectId,
        name: op.project.values.name,
        description: op.project.values.description,
        jira_issue_key: op.project.values.jira_issue_key,
        status: op.project.values.status
      })
    } else {
      projectId = op.project.id
      const p = next.projects.find((x) => x.id === projectId)!
      if (op.project.backfillKey) p.jira_issue_key = op.item.jiraKey
      if (force && op.force) {
        if (op.force.name !== null) p.name = op.force.name
        if (op.force.description !== null) p.description = op.force.description
      } else if (op.project.description !== null) {
        p.description = op.project.description
      }
    }
    const newIds = new Map<string, number>()
    for (const t of op.newTasks) {
      const taskId = id++
      newIds.set(t.jiraKey, taskId)
      next.tasks.push({
        id: taskId,
        project_id: projectId,
        parent_task_id: t.parentTaskId ?? (t.parentJiraKey ? newIds.get(t.parentJiraKey)! : null),
        name: t.name,
        status: t.status,
        sort_order: t.sortOrder,
        jira_issue_key: t.jiraKey,
        end_date: t.endDate
      })
    }
    if (force && op.force) {
      for (const o of op.force.taskOverwrites) {
        const t = next.tasks.find((x) => x.id === o.taskId)!
        t.name = o.name
        t.status = o.status
        if (o.endDate !== null) t.end_date = o.endDate
        if (o.backfillKey) t.jira_issue_key = o.jiraKey
      }
    } else {
      for (const u of op.taskUpdates) {
        const t = next.tasks.find((x) => x.id === u.taskId)!
        if (u.status) t.status = u.status
        if (u.backfillKey) t.jira_issue_key = u.jiraKey
      }
    }
    for (const d of op.newDocuments) {
      next.documents.push({
        id: id++,
        project_id: projectId,
        name: d.name,
        url: d.url,
        sort_order: d.sortOrder
      })
    }
  }
  return next
}

describe('R1 에픽 = 프로젝트', () => {
  it('R1: 같은 에픽 아래 트리거가 여럿이어도 프로젝트는 하나다', () => {
    const c = plan(projSnapshot())
    const epicItems = c.plan.items.filter((i) => i.kind === 'epic')
    expect(epicItems).toHaveLength(1)
    expect(epicItems[0]).toMatchObject({
      jiraKey: 'PROJ-1855',
      summary: '알림센터 개편',
      action: 'create',
      projectId: null,
      projectName: '알림센터 개편',
      matchedBy: null
    })
  })

  it('R1: 에픽 자체가 트리거여도 프로젝트가 된다', () => {
    const c = plan(snapshotOf([issue('PROJ-1', '검색 개편', 'epic', 'todo')], ['PROJ-1']))
    expect(c.plan.items.map((i) => [i.jiraKey, i.kind, i.action])).toEqual([
      ['PROJ-1', 'epic', 'create']
    ])
  })
})

describe('R2 Sustain 작업 = 개별 프로젝트', () => {
  it('R2: Sustain 에픽 아래 할 일 작업 각각이 프로젝트가 되고 에픽 자체는 아무것도 만들지 않는다', () => {
    const c = plan(projSnapshot())
    const sustain = c.plan.items.filter((i) => i.kind === 'sustain').map((i) => i.jiraKey)
    expect(sustain).toEqual(['PROJ-1893', 'PROJ-1895'])
    expect(c.plan.items.some((i) => i.jiraKey === 'PROJ-1892')).toBe(false)
    expect(c.plan.skipped.some((s) => s.jiraKey === 'PROJ-1892')).toBe(false)
  })

  it('R2: Sustain 작업의 하위 작업이 트리거면 부모 작업이 프로젝트가 된다', () => {
    const issues = [
      issue('PROJ-10', '[iOS/Sustain] Sprint 1', 'epic', 'doing'),
      issue('PROJ-11', '푸시 오류', 'task', 'doing', { parentKey: 'PROJ-10' }),
      issue('PROJ-12', '재현', 'subtask', 'todo', { parentKey: 'PROJ-11' })
    ]
    const c = plan(snapshotOf(issues, ['PROJ-12']))
    expect(c.plan.items).toHaveLength(1)
    expect(c.plan.items[0]).toMatchObject({ jiraKey: 'PROJ-11', kind: 'sustain', newTasks: 1 })
  })

  it('R2: Sustain 패턴은 단어 경계로만 본다 (suspend는 Sustain이 아니다)', () => {
    const issues = [
      issue('PROJ-20', '계정 suspend 정책', 'epic', 'doing'),
      issue('PROJ-21', '정지 화면', 'task', 'todo', { parentKey: 'PROJ-20' })
    ]
    const c = plan(snapshotOf(issues, ['PROJ-21']))
    expect(c.plan.items.map((i) => [i.jiraKey, i.kind])).toEqual([['PROJ-20', 'epic']])
  })
})

describe('R3 QA 제외', () => {
  it('R3: QA 에픽의 하위, QA 타입 이슈는 제외한다 (하위 작업 단위는 skipped에 넣지 않는다)', () => {
    const c = plan(projSnapshot())
    const qa = c.plan.skipped.filter((s) => s.reason === 'qa').map((s) => s.jiraKey)
    // PROJ-8101은 QA 에픽 아래 하위 작업이라 제외되지만 미리보기에는 프로젝트 단위만 보고한다
    expect(qa).toEqual(['PROJ-2001'])
    expect(c.plan.items.some((i) => i.jiraKey === 'PROJ-1054')).toBe(false)
  })

  it('R3: QA 라벨 작업과 그 하위 작업은 제외하고, 요약만 QA인 작업은 가져온다', () => {
    const c = plan(projSnapshot())
    const keys = opFor(c, 'PROJ-1855').newTasks.map((t) => t.jiraKey)
    expect(keys).toContain('PROJ-1859') // [포인트] 셀프 QA — 일반 작업
    expect(keys).not.toContain('PROJ-1862') // labels: qa

    const issues = [
      issue('PROJ-30', '결제 개편', 'epic', 'doing'),
      issue('PROJ-31', '결제 검수', 'task', 'doing', { parentKey: 'PROJ-30', labels: ['QA'] }),
      issue('PROJ-32', '검수 체크리스트', 'subtask', 'todo', { parentKey: 'PROJ-31' })
    ]
    const c2 = plan(snapshotOf(issues, ['PROJ-32']))
    expect(c2.plan.items).toEqual([])
    // 하위 작업 트리거라 skipped에도 남지 않는다
    expect(c2.plan.skipped).toEqual([])
  })

  it('R3: QA 에픽 자체가 트리거여도 제외한다', () => {
    const c = plan(snapshotOf([issue('PROJ-40', 'iOSQA-2026', 'epic', 'todo')], ['PROJ-40']))
    expect(c.plan.items).toEqual([])
    expect(c.plan.skipped[0]).toMatchObject({ jiraKey: 'PROJ-40', reason: 'qa' })
  })
})

describe('에픽 없는 작업', () => {
  it('에픽 없는 비-Sustain 트리거 작업은 skipped(no_epic)', () => {
    const c = plan(projSnapshot())
    expect(c.plan.skipped.filter((s) => s.reason === 'no_epic').map((s) => s.jiraKey)).toEqual([
      'PROJ-2000'
    ])
  })
})

describe('R4 수동 프로젝트 보존', () => {
  it('R4: 매칭되지 않은 기존 프로젝트·작업·문서는 계획에 등장하지 않는다', () => {
    const db: DbSyncState = {
      projects: [
        {
          id: 1,
          name: '수동 프로젝트',
          description: '직접 만듦',
          jira_issue_key: null,
          status: 'in_progress'
        }
      ],
      tasks: [
        {
          id: 10,
          project_id: 1,
          parent_task_id: null,
          name: '아무 작업',
          status: 'pending',
          sort_order: 0,
          jira_issue_key: null,
          end_date: null
        }
      ],
      documents: [
        { id: 20, project_id: 1, name: '노션', url: 'https://notion.so/x', sort_order: 0 }
      ]
    }
    const c = plan(projSnapshot(), db)
    for (const op of c.ops) {
      expect(op.item.projectId).not.toBe(1)
      expect(op.taskUpdates.map((u) => u.taskId)).not.toContain(10)
    }
    // 새 상태에서도 수동 행은 그대로다
    const after = applyInMemory(db, c)
    expect(after.projects.find((p) => p.id === 1)).toEqual(db.projects[0])
    expect(after.tasks.find((t) => t.id === 10)).toEqual(db.tasks[0])
    expect(after.documents.find((d) => d.id === 20)).toEqual(db.documents[0])
  })

  it('R4: 매칭된 프로젝트도 이름·기존 작업 이름·설명(값이 있으면)은 바꾸지 않는다', () => {
    const db: DbSyncState = {
      projects: [
        {
          id: 1,
          name: '[알림] 알림센터 개편',
          description: '내 메모',
          jira_issue_key: null,
          status: 'in_progress'
        }
      ],
      tasks: [
        {
          id: 10,
          project_id: 1,
          parent_task_id: null,
          name: '내가 고친 이름 (PROJ-1856)',
          status: 'pending',
          sort_order: 3,
          jira_issue_key: null,
          end_date: null
        }
      ],
      documents: []
    }
    const c = plan(projSnapshot(), db)
    const op = opFor(c, 'PROJ-1855')
    expect(op.project).toEqual({ kind: 'existing', id: 1, backfillKey: true, description: null })
    const after = applyInMemory(db, c)
    expect(after.projects[0].name).toBe('[알림] 알림센터 개편')
    expect(after.projects[0].description).toBe('내 메모')
    expect(after.tasks.find((t) => t.id === 10)?.name).toBe('내가 고친 이름 (PROJ-1856)')
  })
})

describe('R5 기존 프로젝트 매칭', () => {
  const base = (overrides: Partial<DbSyncState['projects'][0]>): DbSyncState['projects'][0] => ({
    id: 1,
    name: '다른 이름',
    description: null,
    jira_issue_key: null,
    status: 'in_progress',
    ...overrides
  })

  it('R5: jira_issue_key 일치가 문서 URL·이름보다 우선한다', () => {
    const db: DbSyncState = {
      projects: [
        base({ id: 1, name: '알림센터 개편' }),
        base({ id: 2, name: '무관한 이름', jira_issue_key: 'PROJ-1855' })
      ],
      tasks: [],
      documents: []
    }
    const item = opFor(plan(projSnapshot(), db), 'PROJ-1855').item
    expect(item).toMatchObject({ action: 'update', projectId: 2, matchedBy: 'jira_key' })
    expect(item.projectName).toBe('무관한 이름')
  })

  it('R5: 문서 URL이 /browse/<키>로 끝나면 매칭하고 키를 백필한다 (쿼리·해시 무시, 다른 키 불일치)', () => {
    const db: DbSyncState = {
      projects: [base({ id: 1 }), base({ id: 2 })],
      tasks: [],
      documents: [
        // 접두사만 같은 다른 키 — 매칭되면 안 된다
        { id: 1, project_id: 1, name: 'x', url: `${SITE_URL}/browse/PROJ-18551`, sort_order: 0 },
        {
          id: 2,
          project_id: 2,
          name: 'Epic (PROJ-1855) 알림센터 개편',
          url: `${SITE_URL}/browse/PROJ-1855?focusedCommentId=1#c`,
          sort_order: 0
        }
      ]
    }
    const op = opFor(plan(projSnapshot(), db), 'PROJ-1855')
    expect(op.item).toMatchObject({ projectId: 2, matchedBy: 'document_url', action: 'update' })
    expect(op.project).toMatchObject({ kind: 'existing', backfillKey: true })
    expect(browseKeyOf(`${SITE_URL}/browse/PROJ-1855/`)).toBe('PROJ-1855')
  })

  it('R5: 이름은 선두 [태그] 제거·대소문자·공백을 정규화해 비교한다', () => {
    expect(normalizeProjectName('[Android] [알림]  알림센터   개편 ')).toBe('알림센터 개편')
    const db: DbSyncState = {
      projects: [base({ id: 7, name: '[Android]  알림센터   개편' })],
      tasks: [],
      documents: []
    }
    expect(opFor(plan(projSnapshot(), db), 'PROJ-1855').item).toMatchObject({
      projectId: 7,
      matchedBy: 'name'
    })
  })

  it('R5: 다른 키가 이미 묶인 프로젝트는 이름이 같아도 매칭하지 않는다', () => {
    const db: DbSyncState = {
      projects: [base({ id: 1, name: '알림센터 개편', jira_issue_key: 'PROJ-1' })],
      tasks: [],
      documents: []
    }
    expect(opFor(plan(projSnapshot(), db), 'PROJ-1855').item.action).toBe('create')
  })

  it('R5: 설명은 비어 있을 때만 채운다', () => {
    const db: DbSyncState = {
      projects: [base({ id: 1, name: '알림센터 개편', description: '  ' })],
      tasks: [],
      documents: []
    }
    const op = opFor(plan(projSnapshot(), db), 'PROJ-1855')
    expect(op.project.kind === 'existing' && op.project.description).toContain(
      '알림센터를 개편한다.'
    )
  })

  it('R5: Sustain 작업이 묶음 프로젝트의 작업 이름에 (KEY)/[KEY]로 있으면 tracked_in_project로 건너뛴다', () => {
    const db: DbSyncState = {
      projects: [base({ id: 3, name: 'Android Sus 26-10' })],
      tasks: [
        {
          id: 30,
          project_id: 3,
          parent_task_id: null,
          name: '로그 개선 (PROJ-1895)',
          status: 'pending',
          sort_order: 0,
          jira_issue_key: null,
          end_date: null
        },
        {
          id: 31,
          project_id: 3,
          parent_task_id: null,
          name: '[PROJ-1893] 크래시',
          status: 'pending',
          sort_order: 1,
          jira_issue_key: null,
          end_date: null
        }
      ],
      documents: []
    }
    const c = plan(projSnapshot(), db)
    expect(c.plan.items.some((i) => i.kind === 'sustain')).toBe(false)
    const tracked = c.plan.skipped.filter((s) => s.reason === 'tracked_in_project')
    expect(tracked).toEqual([
      {
        jiraKey: 'PROJ-1893',
        summary: '상품 상세 크래시 수정',
        reason: 'tracked_in_project',
        detail: 'Android Sus 26-10'
      },
      {
        jiraKey: 'PROJ-1895',
        summary: '로그 개선',
        reason: 'tracked_in_project',
        detail: 'Android Sus 26-10'
      }
    ])
  })
})

describe('R6 작업·문서·링크 가져오기', () => {
  it('R6: 에픽의 작업(내게 할당+미할당)과 그 하위 작업을 계층으로 가져온다', () => {
    const op = opFor(plan(projSnapshot()), 'PROJ-1855')
    expect(
      op.newTasks.map((t) => [t.jiraKey, t.name, t.status, t.parentJiraKey, t.endDate])
    ).toEqual([
      ['PROJ-1856', '알림센터 API 연동 (PROJ-1856)', 'pending', null, null],
      ['PROJ-1860', 'API 모델 정의 (PROJ-1860)', 'done', 'PROJ-1856', null],
      ['PROJ-1861', '화면 바인딩 (PROJ-1861)', 'pending', 'PROJ-1856', '2026-10-20'],
      ['PROJ-1857', '알림센터 UI (PROJ-1857)', 'in_progress', null, null],
      ['PROJ-1859', '[포인트] 셀프 QA (PROJ-1859)', 'pending', null, null]
    ])
    // 남에게 할당된 작업(PROJ-1858)은 가져오지 않는다
    expect(op.newTasks.some((t) => t.jiraKey === 'PROJ-1858')).toBe(false)
  })

  it('R6: 남의 작업이라도 그 아래 내 트리거 하위 작업이 있으면 부모로 함께 가져온다', () => {
    const issues = [
      issue('PROJ-50', '정산 개편', 'epic', 'doing'),
      issue('PROJ-51', '정산 API', 'task', 'doing', {
        parentKey: 'PROJ-50',
        assigneeAccountId: OTHER
      }),
      issue('PROJ-52', '앱 연동', 'subtask', 'todo', { parentKey: 'PROJ-51' })
    ]
    const op = opFor(plan(snapshotOf(issues, ['PROJ-52'])), 'PROJ-50')
    expect(op.newTasks.map((t) => [t.jiraKey, t.parentJiraKey])).toEqual([
      ['PROJ-51', null],
      ['PROJ-52', 'PROJ-51']
    ])
  })

  it('R6: Sustain 프로젝트는 작업의 하위 작업을 최상위 작업으로 가져온다', () => {
    const op = opFor(plan(projSnapshot()), 'PROJ-1893')
    expect(op.newTasks.map((t) => [t.jiraKey, t.status, t.parentJiraKey, t.parentTaskId])).toEqual([
      ['PROJ-1894', 'done', null, null],
      ['PROJ-1896', 'pending', null, null]
    ])
    expect(op.newDocuments).toEqual([
      { name: 'Jira 티켓 (PROJ-1893)', url: `${SITE_URL}/browse/PROJ-1893`, sortOrder: 0 }
    ])
  })

  it('R6: 문서는 이슈 자신·원격 링크·이슈 링크·설명 속 URL을 모으고 URL 끝 슬래시로 중복을 거른다', () => {
    const op = opFor(plan(projSnapshot()), 'PROJ-1855')
    expect(op.newDocuments.map((d) => [d.name, d.url])).toEqual([
      ['Epic (PROJ-1855) 알림센터 개편', `${SITE_URL}/browse/PROJ-1855`],
      ['알림센터 PRD', 'https://www.notion.so/acme/notice-prd'],
      ['Relates (PROJ-1700) 알림 기획', `${SITE_URL}/browse/PROJ-1700`],
      ['기획서', 'https://www.notion.so/acme/notice-spec'],
      ['Figma', 'https://www.figma.com/design/abc123/Notice'],
      ['Google 문서', 'https://docs.google.com/document/d/xyz/edit'],
      ['Confluence', 'https://acme.atlassian.net/wiki/spaces/APP/pages/1']
    ])
  })

  it('R6: 기존 작업은 키 또는 이름 속 (KEY)로 매칭해 키를 백필하고 상태는 앞으로만 옮긴다', () => {
    const db: DbSyncState = {
      projects: [
        {
          id: 1,
          name: '알림센터 개편',
          description: null,
          jira_issue_key: 'PROJ-1855',
          status: 'in_progress'
        }
      ],
      tasks: [
        // 이름 매칭 + Jira가 done → pending에서 전진
        {
          id: 10,
          project_id: 1,
          parent_task_id: null,
          name: 'API 모델 (PROJ-1860)',
          status: 'pending',
          sort_order: 0,
          jira_issue_key: null,
          end_date: null
        },
        // 앱에서 done 처리 — Jira는 처리중이지만 되돌리지 않는다
        {
          id: 11,
          project_id: 1,
          parent_task_id: null,
          name: 'UI',
          status: 'done',
          sort_order: 1,
          jira_issue_key: 'PROJ-1857',
          end_date: null
        },
        // 선두 대괄호 형태도 매칭
        {
          id: 12,
          project_id: 1,
          parent_task_id: null,
          name: '[PROJ-1856] 연동',
          status: 'in_progress',
          sort_order: 2,
          jira_issue_key: null,
          end_date: null
        }
      ],
      documents: [
        { id: 1, project_id: 1, name: '에픽', url: `${SITE_URL}/browse/PROJ-1855/`, sort_order: 5 }
      ]
    }
    const op = opFor(plan(projSnapshot(), db), 'PROJ-1855')
    expect(op.taskUpdates).toEqual([
      { taskId: 12, jiraKey: 'PROJ-1856', status: null, backfillKey: true },
      { taskId: 10, jiraKey: 'PROJ-1860', status: 'done', backfillKey: true }
    ])
    // 기존 상위(PROJ-1856=12) 아래로 새 하위 작업을 붙이고 정렬은 기존 최대 뒤로
    const sub = op.newTasks.find((t) => t.jiraKey === 'PROJ-1861')
    expect(sub).toMatchObject({ parentTaskId: 12, parentJiraKey: null })
    expect(op.newTasks.map((t) => t.sortOrder)).toEqual([3, 4])
    // 에픽 browse 문서는 끝 슬래시만 달라 이미 있는 것으로 본다
    expect(op.newDocuments.some((d) => d.url === `${SITE_URL}/browse/PROJ-1855`)).toBe(false)
    expect(op.newDocuments[0].sortOrder).toBe(6)
    expect(op.item).toMatchObject({ action: 'update', updatedTasks: 2, newTasks: 2 })
  })
})

describe('R7 신규 프로젝트 기본값', () => {
  it('R7: 이름=요약, 설명=ADF 평문, 키, 개발 시작=오늘, 종료=미래 duedate, 상태 scheduled', () => {
    const op = opFor(plan(projSnapshot()), 'PROJ-1855')
    expect(op.project.kind).toBe('create')
    if (op.project.kind !== 'create') return
    expect(op.project.values).toMatchObject({
      name: '알림센터 개편',
      jira_issue_key: 'PROJ-1855',
      dev_start_date: TODAY,
      dev_end_date: '2099-12-31',
      status: 'scheduled',
      priority: null
    })
    expect(op.project.values.description).toContain('알림센터를 개편한다.')
    expect(op.project.values.qa_start_date > op.project.values.dev_end_date).toBe(true)
  })

  it('R7: duedate가 없거나 지났으면 종료일은 오늘+13일, 설명이 없으면 null', () => {
    const issues = [
      issue('PROJ-60', '지난 마감', 'epic', 'todo', { duedate: '2026-01-01' }),
      issue('PROJ-61', '마감 없음', 'epic', 'todo')
    ]
    const c = plan(snapshotOf(issues, ['PROJ-60', 'PROJ-61']))
    for (const key of ['PROJ-60', 'PROJ-61']) {
      const p = opFor(c, key).project
      expect(p.kind === 'create' && p.values.dev_end_date).toBe('2026-10-15')
      expect(p.kind === 'create' && p.values.description).toBeNull()
    }
  })
})

describe('R8 멱등성', () => {
  it('R8: 같은 스냅샷을 두 번 적용하면 두 번째는 전부 unchanged이고 추가 0건이다', () => {
    const snapshot = projSnapshot()
    const first = plan(snapshot)
    expect(first.plan.items.map((i) => i.action)).toEqual(['create', 'create', 'create'])

    const afterFirst = applyInMemory(emptyDb(), first)
    const second = plan(snapshot, afterFirst)
    expect(second.plan.items.map((i) => i.action)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    for (const op of second.ops) {
      expect(op.newTasks).toEqual([])
      expect(op.taskUpdates).toEqual([])
      expect(op.newDocuments).toEqual([])
    }
  })

  it('R8: 이름·문서로 매칭돼 백필된 뒤 다시 돌려도 unchanged다', () => {
    const db: DbSyncState = {
      projects: [
        {
          id: 1,
          name: '알림센터 개편',
          description: 'x',
          jira_issue_key: null,
          status: 'in_progress'
        }
      ],
      tasks: [
        {
          id: 10,
          project_id: 1,
          parent_task_id: null,
          name: '연동 (PROJ-1856)',
          status: 'pending',
          sort_order: 0,
          jira_issue_key: null,
          end_date: null
        }
      ],
      documents: []
    }
    const snapshot = projSnapshot()
    const once = applyInMemory(db, plan(snapshot, db))
    const again = plan(snapshot, once)
    expect(opFor(again, 'PROJ-1855').item).toMatchObject({
      action: 'unchanged',
      matchedBy: 'jira_key',
      newTasks: 0,
      updatedTasks: 0,
      newDocuments: 0
    })
  })
})

describe('ADF 해석', () => {
  it('평문으로 바꾸고 비어 있으면 null', () => {
    const text = adfToPlainText(NOTICE_DESCRIPTION)
    expect(text?.split('\n')[0]).toBe('알림센터를 개편한다.')
    expect(text).toContain('기획서 / 디자인 https://www.figma.com/design/abc123/Notice')
    expect(adfToPlainText(null)).toBeNull()
    expect(
      adfToPlainText({ type: 'doc', content: [{ type: 'paragraph', content: [] }] })
    ).toBeNull()
  })

  it('목록은 - 머리표로 펼친다', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '하나' }] }]
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '둘' }] }]
            }
          ]
        }
      ]
    }
    expect(adfToPlainText(doc)).toBe('- 하나\n- 둘')
  })

  it('http(s) 링크만 모으고 링크 텍스트가 URL이면 호스트로 이름을 추정한다', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'https://www.notion.so/p',
              marks: [{ type: 'link', attrs: { href: 'https://www.notion.so/p' } }]
            },
            {
              type: 'text',
              text: '나쁜 링크',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]
            },
            { type: 'blockCard', attrs: { url: 'https://example.com/a' } },
            { type: 'text', text: '중복 https://example.com/a' }
          ]
        }
      ]
    }
    expect(extractAdfLinks(doc)).toEqual([
      { name: 'Notion 문서', url: 'https://www.notion.so/p' },
      { name: 'example.com', url: 'https://example.com/a' }
    ])
    expect(guessLinkName(`${SITE_URL}/browse/PROJ-1`)).toBe('Jira 티켓 (PROJ-1)')
  })
})

describe('리뷰 결함 회귀', () => {
  const proj = (
    id: number,
    name: string,
    extra: Partial<DbSyncState['projects'][0]> = {}
  ): DbSyncState['projects'][0] => ({
    id,
    name,
    description: null,
    jira_issue_key: null,
    status: 'in_progress',
    ...extra
  })

  it('R5: 양쪽 모두 선두 태그가 있으면 태그 집합이 같아야 이름 매칭한다', () => {
    const issues = [issue('PROJ-70', '[Android] 크래시 수정', 'epic', 'todo')]
    const other = plan(snapshotOf(issues, ['PROJ-70']), {
      projects: [proj(1, '[iOS] 크래시 수정')],
      tasks: [],
      documents: []
    })
    expect(other.plan.items[0]).toMatchObject({ action: 'create', matchedBy: null })

    const same = plan(snapshotOf(issues, ['PROJ-70']), {
      projects: [proj(1, '[ android ]  크래시 수정')],
      tasks: [],
      documents: []
    })
    expect(same.plan.items[0]).toMatchObject({ projectId: 1, matchedBy: 'name' })
  })

  it('R5: 한쪽만 선두 태그가 있으면 제목만으로 매칭한다', () => {
    const issues = [issue('PROJ-71', 'd+머니 충전', 'epic', 'todo')]
    const c = plan(snapshotOf(issues, ['PROJ-71']), {
      projects: [proj(1, '[구매자] d+머니 충전')],
      tasks: [],
      documents: []
    })
    expect(c.plan.items[0]).toMatchObject({ projectId: 1, matchedBy: 'name' })
  })

  it('R5: 완료·취소된 프로젝트는 이름 매칭 후보가 아니다 (키·문서 매칭은 상태 무관)', () => {
    const issues = [issue('PROJ-72', '검색 개편', 'epic', 'todo')]
    for (const status of ['completed', 'cancelled']) {
      const c = plan(snapshotOf(issues, ['PROJ-72']), {
        projects: [proj(1, '검색 개편', { status })],
        tasks: [],
        documents: []
      })
      expect(c.plan.items[0].action, status).toBe('create')
    }
    const byDoc = plan(snapshotOf(issues, ['PROJ-72']), {
      projects: [proj(1, '검색 개편', { status: 'completed' })],
      tasks: [],
      documents: [
        { id: 1, project_id: 1, name: 'e', url: `${SITE_URL}/browse/PROJ-72`, sort_order: 0 }
      ]
    })
    expect(byDoc.plan.items[0]).toMatchObject({ projectId: 1, matchedBy: 'document_url' })
  })

  it('R5: Sustain은 jira_key 다음에 tracked_in_project를 문서·이름 매칭보다 먼저 본다', () => {
    const issues = [
      issue('PROJ-299', '[Android/Sus] Sprint 1', 'epic', 'doing'),
      issue('PROJ-300', '크래시', 'task', 'todo', { parentKey: 'PROJ-299' })
    ]
    const db: DbSyncState = {
      projects: [proj(1, 'Android Sus 묶음')],
      tasks: [
        {
          id: 10,
          project_id: 1,
          parent_task_id: null,
          name: '크래시 (PROJ-300)',
          status: 'pending',
          sort_order: 0,
          jira_issue_key: null,
          end_date: null
        }
      ],
      documents: [
        { id: 1, project_id: 1, name: 't', url: `${SITE_URL}/browse/PROJ-300`, sort_order: 0 }
      ]
    }
    const c = plan(snapshotOf(issues, ['PROJ-300']), db)
    expect(c.plan.items).toEqual([])
    expect(c.plan.skipped).toEqual([
      {
        jiraKey: 'PROJ-300',
        summary: '크래시',
        reason: 'tracked_in_project',
        detail: 'Android Sus 묶음'
      }
    ])

    // jira_key가 이미 이 프로젝트면 그대로 업데이트 대상이다
    db.projects[0].jira_issue_key = 'PROJ-300'
    expect(plan(snapshotOf(issues, ['PROJ-300']), db).plan.items[0]).toMatchObject({
      projectId: 1,
      matchedBy: 'jira_key'
    })
  })

  it('R6: 같은 사이트의 browse 문서는 쿼리·해시가 달라도 같은 문서로 본다', () => {
    const issues = [issue('PROJ-50', '정산 개편', 'epic', 'todo')]
    const c = plan(snapshotOf(issues, ['PROJ-50']), {
      projects: [proj(1, '다른 이름', { jira_issue_key: 'PROJ-50' })],
      tasks: [],
      documents: [
        {
          id: 1,
          project_id: 1,
          name: 'e',
          url: `${SITE_URL}/browse/PROJ-50?atlOrigin=abc#x`,
          sort_order: 0
        }
      ]
    })
    expect(c.ops[0].newDocuments).toEqual([])
    expect(c.plan.items[0].action).toBe('unchanged')
  })

  it('ADF: URL 안에서 짝이 맞는 괄호는 포함하고 짝 없는 끝 괄호·문장부호만 뗀다', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '참고 https://ko.wikipedia.org/wiki/Foo_(bar). 그리고 (https://example.com/a), 끝'
            }
          ]
        }
      ]
    }
    expect(extractAdfLinks(doc).map((l) => l.url)).toEqual([
      'https://ko.wikipedia.org/wiki/Foo_(bar)',
      'https://example.com/a'
    ])
  })
})

describe('R9 선택 적용', () => {
  it('R9: 선택한 항목의 op만 남고, 선택 안 된 항목은 계획 순서에서 빠진다', () => {
    const c = plan(projSnapshot())
    const selected = selectProjectSyncOps(c, [
      { jiraKey: 'PROJ-1895', force: false, projectId: null },
      { jiraKey: 'PROJ-1855', force: false, projectId: null }
    ])
    // 쓰기 순서는 선택 순서가 아니라 계획 순서
    expect(selected.map((s) => s.op.item.jiraKey)).toEqual(['PROJ-1855', 'PROJ-1895'])

    const after = applyInMemory(emptyDb(), c, [
      { jiraKey: 'PROJ-1893', force: false, projectId: null }
    ])
    expect(after.projects.map((p) => p.jira_issue_key)).toEqual(['PROJ-1893'])
  })

  it('R9: 선택 안 된 기존 프로젝트 항목은 키 백필도 하지 않는다', () => {
    const db: DbSyncState = {
      projects: [
        {
          id: 1,
          name: '알림센터 개편',
          description: null,
          jira_issue_key: null,
          status: 'development'
        }
      ],
      tasks: [],
      documents: []
    }
    const c = plan(projSnapshot(), db)
    expect(opFor(c, 'PROJ-1855').item.projectId).toBe(1)
    const after = applyInMemory(db, c, [{ jiraKey: 'PROJ-1893', force: false, projectId: null }])
    expect(after.projects[0]).toEqual(db.projects[0])
  })

  it('R9: 빈 선택·미리보기에 없는 키는 오류다', () => {
    const c = plan(projSnapshot())
    expect(() => selectProjectSyncOps(c, [])).toThrow(EMPTY_SELECTION_MESSAGE)
    // PROJ-9000은 스냅샷에 있지만 항목이 아니다(no_epic)
    expect(() =>
      selectProjectSyncOps(c, [{ jiraKey: 'PROJ-2000', force: false, projectId: null }])
    ).toThrow(UNKNOWN_SELECTION_MESSAGE)
  })

  it('R9: IPC 선택 입력을 검증한다 (배열·키 형식·force boolean)', () => {
    expect(parseProjectSyncSelection([{ jiraKey: 'PROJ-1', force: true, projectId: null }])).toEqual(
      [{ jiraKey: 'PROJ-1', force: true, projectId: null }]
    )
    // 같은 키가 두 번 오면 마지막 값 하나로 합친다
    expect(
      parseProjectSyncSelection([
        { jiraKey: 'PROJ-1', force: true, projectId: null },
        { jiraKey: 'PROJ-1', force: false, projectId: null }
      ])
    ).toEqual([{ jiraKey: 'PROJ-1', force: false, projectId: null }])
    expect(() => parseProjectSyncSelection([])).toThrow(EMPTY_SELECTION_MESSAGE)
    const bad: unknown[] = [
      undefined,
      null,
      'PROJ-1',
      { jiraKey: 'PROJ-1', force: false },
      [null],
      ['PROJ-1'],
      [{ jiraKey: 'proj-1', force: false }],
      [{ jiraKey: 'PROJ-1) OR project = X', force: false }],
      [{ jiraKey: 'PROJ-1', force: 'true' }],
      [{ jiraKey: 'PROJ-1' }]
    ]
    for (const input of bad) {
      expect(() => parseProjectSyncSelection(input), JSON.stringify(input)).toThrow(
        INVALID_SELECTION_MESSAGE
      )
    }
  })
})

describe('R10 기존 프로젝트 강제 업데이트', () => {
  // 기존 프로젝트(이름 매칭) + Jira와 어긋난 작업들 + Jira와 무관한 수동 작업
  function forcedDb(): DbSyncState {
    return {
      projects: [
        {
          id: 1,
          name: '[알림] 알림센터 개편',
          description: '내 메모',
          jira_issue_key: null,
          status: 'development'
        }
      ],
      tasks: [
        // 앱에서 done — Jira는 할 일(pending). 강제면 되돌린다
        {
          id: 10,
          project_id: 1,
          parent_task_id: null,
          name: '내가 고친 이름 (PROJ-1856)',
          status: 'done',
          sort_order: 0,
          jira_issue_key: null,
          end_date: null
        },
        // 이름·상태 같고 마감일만 다름 — 이름/상태 변화로는 세지 않는다
        {
          id: 11,
          project_id: 1,
          parent_task_id: 10,
          name: '화면 바인딩 (PROJ-1861)',
          status: 'pending',
          sort_order: 1,
          jira_issue_key: 'PROJ-1861',
          end_date: '2026-01-01'
        },
        // 이름만 다름. Jira에 마감일이 없으니 end_date는 유지
        {
          id: 12,
          project_id: 1,
          parent_task_id: null,
          name: '[PROJ-1857] UI',
          status: 'in_progress',
          sort_order: 2,
          jira_issue_key: null,
          end_date: '2026-05-05'
        },
        // Jira와 매칭되지 않는 수동 작업
        {
          id: 13,
          project_id: 1,
          parent_task_id: null,
          name: '수동 작업',
          status: 'pending',
          sort_order: 3,
          jira_issue_key: null,
          end_date: null
        }
      ],
      documents: []
    }
  }

  it('R10: 덮어쓸 대상과 forceChanges를 계산한다 (상태 역행 허용, 마감일은 있을 때만)', () => {
    const op = opFor(plan(projSnapshot(), forcedDb()), 'PROJ-1855')
    expect(op.force?.name).toBe('알림센터 개편')
    expect(op.force?.description).toContain('알림센터를 개편한다.')
    expect(op.force?.taskOverwrites).toEqual([
      {
        taskId: 10,
        jiraKey: 'PROJ-1856',
        name: '알림센터 API 연동 (PROJ-1856)',
        status: 'pending',
        endDate: null,
        backfillKey: true
      },
      {
        taskId: 11,
        jiraKey: 'PROJ-1861',
        name: '화면 바인딩 (PROJ-1861)',
        status: 'pending',
        endDate: '2026-10-20',
        backfillKey: false
      },
      {
        taskId: 12,
        jiraKey: 'PROJ-1857',
        name: '알림센터 UI (PROJ-1857)',
        status: 'in_progress',
        endDate: null,
        backfillKey: true
      }
    ])
    // name 1 + description 1 + 이름·상태·마감일 중 하나라도 바뀌는 작업 3(10, 11, 12)
    // — 11은 마감일만 바뀌지만 실제로 덮어쓰므로 센다
    expect(op.item.forceChanges).toBe(5)
    expect(op.item.forceTasks).toEqual([
      { before: '내가 고친 이름 (PROJ-1856)', after: '알림센터 API 연동 (PROJ-1856)' },
      { before: '화면 바인딩 (PROJ-1861)', after: '화면 바인딩 (PROJ-1861)' },
      { before: '[PROJ-1857] UI', after: '알림센터 UI (PROJ-1857)' }
    ])
    // 보수적 경로는 그대로 — 키 백필 2건, 상태 역행 없음
    expect(op.taskUpdates.every((u) => u.status === null)).toBe(true)
  })

  it('R10: 강제 적용은 Jira 원본이 있는 필드만 덮어쓰고 수동 작업·날짜류는 건드리지 않는다', () => {
    const db = forcedDb()
    const c = plan(projSnapshot(), db)
    const [selected] = selectProjectSyncOps(c, [{ jiraKey: 'PROJ-1855', force: true, projectId: 1 }])
    expect(selected).toMatchObject({ force: true, action: 'update', tasksUpdated: 3 })

    const after = applyInMemory(db, c, [{ jiraKey: 'PROJ-1855', force: true, projectId: 1 }])
    expect(after.projects[0]).toEqual({
      ...db.projects[0],
      name: '알림센터 개편',
      description: expect.stringContaining('알림센터를 개편한다.'),
      jira_issue_key: 'PROJ-1855'
    })
    const byId = (id: number) => after.tasks.find((t) => t.id === id)
    expect(byId(10)).toMatchObject({ status: 'pending', parent_task_id: null, sort_order: 0 })
    expect(byId(11)).toMatchObject({ end_date: '2026-10-20', parent_task_id: 10 })
    expect(byId(12)).toMatchObject({ name: '알림센터 UI (PROJ-1857)', end_date: '2026-05-05' })
    expect(byId(13)).toEqual(db.tasks[3])
  })

  it('R10: Jira 본문이 비어 있으면 기존 설명을 유지한다', () => {
    const issues = [issue('PROJ-80', '검색 개편', 'epic', 'todo')]
    const c = plan(snapshotOf(issues, ['PROJ-80']), {
      projects: [
        {
          id: 1,
          name: '검색',
          description: '내 설명',
          jira_issue_key: 'PROJ-80',
          status: 'development'
        }
      ],
      tasks: [],
      documents: []
    })
    expect(c.ops[0].force).toMatchObject({ name: '검색 개편', description: null })
    expect(c.ops[0].item.forceChanges).toBe(1)
  })

  it('R10: 신규 생성 항목의 force는 무시하고 forceChanges는 0이다', () => {
    const c = plan(projSnapshot())
    expect(c.plan.items.every((i) => i.forceChanges === 0)).toBe(true)
    const selected = selectProjectSyncOps(c, selectAll(c, true))
    expect(selected.every((s) => s.force === false && s.action === 'create')).toBe(true)
  })

  it('R10: 강제 업데이트도 멱등이다 — 같은 스냅샷 두 번째는 unchanged, forceChanges 0', () => {
    const snapshot = projSnapshot()
    const db = forcedDb()
    const once = applyInMemory(db, plan(snapshot, db), [
      { jiraKey: 'PROJ-1855', force: true, projectId: 1 }
    ])
    const again = plan(snapshot, once)
    const [selected] = selectProjectSyncOps(again, [
      { jiraKey: 'PROJ-1855', force: true, projectId: 1 }
    ])
    expect(selected.action).toBe('unchanged')
    expect(selected.op.item.forceChanges).toBe(0)
    expect(
      applyInMemory(once, again, [{ jiraKey: 'PROJ-1855', force: true, projectId: 1 }])
    ).toEqual(once)
  })
})

describe('미리보기는 프로젝트 단위만 보고한다', () => {
  it('triggerCount와 skipped에서 하위 작업 트리거를 뺀다', () => {
    const c = plan(projSnapshot())
    // 트리거 8건 중 하위 작업 2건(PROJ-1861, PROJ-1101) 제외
    expect(c.plan.triggerCount).toBe(6)
    expect(c.plan.skipped.some((s) => s.jiraKey === 'PROJ-1101' || s.jiraKey === 'PROJ-1861')).toBe(
      false
    )
    // 가져오기 자체는 그대로 — 하위 작업은 자식 task로 들어간다
    expect(opFor(c, 'PROJ-1855').newTasks.some((t) => t.jiraKey === 'PROJ-1861')).toBe(true)
  })
})

describe('2차 리뷰 결함 회귀', () => {
  it('R10: 키 백필만 일어나는 작업은 forceTasks·forceChanges에 넣지 않는다', () => {
    const issues = [
      issue('PROJ-90', '정산', 'epic', 'todo'),
      issue('PROJ-91', '정산 API', 'task', 'todo', { parentKey: 'PROJ-90' })
    ]
    const c = plan(snapshotOf(issues, ['PROJ-91']), {
      projects: [
        { id: 1, name: '정산', description: null, jira_issue_key: 'PROJ-90', status: 'development' }
      ],
      tasks: [
        {
          id: 5,
          project_id: 1,
          parent_task_id: null,
          name: '정산 API (PROJ-91)',
          status: 'pending',
          sort_order: 0,
          jira_issue_key: null,
          end_date: null
        }
      ],
      documents: []
    })
    expect(c.ops[0].force?.taskOverwrites).toHaveLength(1)
    expect(c.plan.items[0]).toMatchObject({ forceTasks: [], forceChanges: 0 })
  })

  it('R10: create 항목의 forceTasks는 빈 배열이다', () => {
    expect(plan(projSnapshot()).plan.items.every((i) => i.forceTasks.length === 0)).toBe(true)
  })

  it('R9: 미리보기의 projectId와 재계획 결과가 다르면 아무것도 고르지 않고 오류다', () => {
    const db: DbSyncState = {
      projects: [
        {
          id: 1,
          name: '알림센터 개편',
          description: null,
          jira_issue_key: null,
          status: 'development'
        }
      ],
      tasks: [],
      documents: []
    }
    const c = plan(projSnapshot(), db)
    // 미리보기 때는 새로 만들 항목이었는데(null) 지금은 프로젝트 1에 매칭됨
    expect(() =>
      selectProjectSyncOps(c, [
        { jiraKey: 'PROJ-1893', force: false, projectId: null },
        { jiraKey: 'PROJ-1855', force: false, projectId: null }
      ])
    ).toThrow(PROJECT_CHANGED_MESSAGE)
    // 다른 프로젝트 id로 본 경우도 같다
    expect(() =>
      selectProjectSyncOps(c, [{ jiraKey: 'PROJ-1855', force: true, projectId: 2 }])
    ).toThrow(PROJECT_CHANGED_MESSAGE)
    expect(
      selectProjectSyncOps(c, [{ jiraKey: 'PROJ-1855', force: true, projectId: 1 }])
    ).toHaveLength(1)
  })

  it('R9: 선택 입력의 projectId는 양의 정수 또는 null만 허용한다', () => {
    expect(parseProjectSyncSelection([{ jiraKey: 'PROJ-1', force: false, projectId: 3 }])).toEqual([
      { jiraKey: 'PROJ-1', force: false, projectId: 3 }
    ])
    for (const projectId of [undefined, 0, -1, 1.5, '1', Number.NaN]) {
      expect(
        () => parseProjectSyncSelection([{ jiraKey: 'PROJ-1', force: false, projectId }]),
        String(projectId)
      ).toThrow(INVALID_SELECTION_MESSAGE)
    }
  })
})

describe('R11 아침 자동 싱크업 — 안전 자동 적용 선택', () => {
  const NONE: ReadonlySet<string> = new Set()
  const row = (overrides: Partial<DbSyncState['projects'][0]>): DbSyncState['projects'][0] => ({
    id: 1,
    name: '다른 이름',
    description: null,
    jira_issue_key: null,
    status: 'in_progress',
    ...overrides
  })

  it('R11: 기존 프로젝트가 없으면 create 항목 전부를 force=false·projectId=null 로 고른다', () => {
    const input = plan(projSnapshot()).plan
    const copy = JSON.parse(JSON.stringify(input)) as typeof input
    const auto = selectAutoSyncSelection(input, NONE)
    // 입력 계획을 바꾸지 않는다
    expect(input).toEqual(copy)
    expect(auto.selection).toEqual([
      { jiraKey: 'PROJ-1855', force: false, projectId: null },
      { jiraKey: 'PROJ-1893', force: false, projectId: null },
      { jiraKey: 'PROJ-1895', force: false, projectId: null }
    ])
    expect(auto.previouslyCreated).toBe(0)
    expect(auto.needsReview).toBe(0)
  })

  it('R11: 전에 싱크업이 만든 키의 create 는 고르지 않는다 (지운 프로젝트를 되살리지 않는다)', () => {
    const auto = selectAutoSyncSelection(plan(projSnapshot()).plan, new Set(['PROJ-1893']))
    expect(auto.selection.map((s) => s.jiraKey)).toEqual(['PROJ-1855', 'PROJ-1895'])
    expect(auto.previouslyCreated).toBe(1)
  })

  it('R11: update 는 jira_key 매칭만 force=false 로 고르고 name·document_url 매칭은 needsReview 로 센다', () => {
    const db: DbSyncState = {
      projects: [
        row({ id: 1, name: '무관한 이름', jira_issue_key: 'PROJ-1855' }),
        row({ id: 2, name: '상품 상세 크래시 수정' }),
        row({ id: 3, name: '문서로만 연결' })
      ],
      tasks: [],
      documents: [
        {
          id: 1,
          project_id: 3,
          name: '티켓',
          url: `${SITE_URL}/browse/PROJ-1895`,
          sort_order: 0
        }
      ]
    }
    const c = plan(projSnapshot(), db)
    expect(c.plan.items.map((i) => [i.jiraKey, i.matchedBy])).toEqual([
      ['PROJ-1855', 'jira_key'],
      ['PROJ-1893', 'name'],
      ['PROJ-1895', 'document_url']
    ])

    const auto = selectAutoSyncSelection(c.plan, NONE)
    expect(auto.selection).toEqual([{ jiraKey: 'PROJ-1855', force: false, projectId: 1 }])
    expect(auto.needsReview).toBe(2)
  })

  it('R11: 어떤 계획에서도 force=true 선택을 만들지 않는다', () => {
    const db: DbSyncState = {
      projects: [row({ id: 1, name: '내가 고친 이름', jira_issue_key: 'PROJ-1855' })],
      tasks: [],
      documents: []
    }
    for (const c of [plan(projSnapshot()), plan(projSnapshot(), db)]) {
      const auto = selectAutoSyncSelection(c.plan, NONE)
      expect(auto.selection.length).toBeGreaterThan(0)
      expect(auto.selection.every((s) => s.force === false)).toBe(true)
    }
  })

  it('R11: 고른 선택은 selectProjectSyncOps 를 그대로 통과하고 강제 경로를 타지 않는다', () => {
    const db: DbSyncState = {
      projects: [row({ id: 1, name: '내가 고친 이름', jira_issue_key: 'PROJ-1855' })],
      tasks: [],
      documents: []
    }
    const c = plan(projSnapshot(), db)
    const auto = selectAutoSyncSelection(c.plan, NONE)
    const selected = selectProjectSyncOps(c, auto.selection)
    expect(selected.map((s) => [s.op.item.jiraKey, s.force, s.action])).toEqual([
      ['PROJ-1855', false, 'update'],
      ['PROJ-1893', false, 'create'],
      ['PROJ-1895', false, 'create']
    ])
    // 보수 경로이므로 이름은 덮어쓰지 않는다
    const after = applyInMemory(db, c, auto.selection)
    expect(after.projects.find((p) => p.id === 1)?.name).toBe('내가 고친 이름')
  })

  it('R11: 적용 뒤 같은 스냅샷으로 다시 고르면 unchanged 라 선택이 0건이다', () => {
    const first = plan(projSnapshot())
    const db = applyInMemory(emptyDb(), first, selectAutoSyncSelection(first.plan, NONE).selection)
    const second = plan(projSnapshot(), db)
    expect(second.plan.items.every((i) => i.action === 'unchanged')).toBe(true)
    expect(selectAutoSyncSelection(second.plan, NONE).selection).toEqual([])
  })

  it('R11: parseSyncCreatedKey 는 수동·강제·자동 3접두의 키를 꺼내고 그 외는 null 이다', () => {
    expect(
      parseSyncCreatedKey(`${SYNC_LOG_LABELS.manual} (PROJ-1855): 작업 +3 · 작업 갱신 0 · 문서 +2`)
    ).toBe('PROJ-1855')
    expect(
      parseSyncCreatedKey(`${SYNC_LOG_LABELS.force} (PROJ-12): 작업 +0 · 작업 갱신 1 · 문서 +0`)
    ).toBe('PROJ-12')
    expect(
      parseSyncCreatedKey(`${SYNC_LOG_LABELS.auto} (AB_2-7): 작업 +1 · 작업 갱신 0 · 문서 +1`)
    ).toBe('AB_2-7')
    expect(SYNC_LOG_LABELS).toEqual({
      manual: 'Jira 싱크업',
      force: '강제 업데이트',
      auto: '아침 자동 싱크업'
    })
    for (const bad of [
      null,
      undefined,
      '',
      '수동 생성',
      'Jira 싱크업 PROJ-1: 작업 +1',
      'Jira 싱크업 (proj-1): 작업 +1',
      '메모 Jira 싱크업 (PROJ-1): 작업 +1'
    ]) {
      expect(parseSyncCreatedKey(bad), String(bad)).toBeNull()
    }
  })
})

describe('R12 Jira 연결 작업 새로고침', () => {
  const refresh = (
    tasks: DbTaskRow[] = refreshTasks(),
    issues: JiraSyncIssue[] = refreshIssues()
  ): TaskRefreshPlan => buildTaskRefreshPlan(refreshSnapshot(issues), REFRESH_PROJECT_ID, tasks)

  /** 계획을 작업 배열에 적용한다 — project-sync.ts 의 R12 쓰기와 같은 의미 */
  function applyRefresh(tasks: DbTaskRow[], p: TaskRefreshPlan): DbTaskRow[] {
    const next = tasks.map((t) => ({ ...t }))
    for (const b of p.backfills) {
      const t = next.find((x) => x.id === b.taskId)!
      if (!t.jira_issue_key) t.jira_issue_key = b.jiraKey
    }
    for (const c of p.statusChanges) {
      const t = next.find((x) => x.id === c.taskId)!
      if (t.jira_issue_key === c.jiraKey) t.status = c.to
    }
    let id = 1000
    const newIds = new Map<string, number>()
    for (const t of p.newTasks) {
      const taskId = id++
      newIds.set(t.jiraKey, taskId)
      next.push({
        id: taskId,
        project_id: p.projectId,
        parent_task_id: t.parentTaskId ?? (t.parentJiraKey ? newIds.get(t.parentJiraKey)! : null),
        name: t.name,
        status: t.status,
        sort_order: t.sortOrder,
        jira_issue_key: t.jiraKey,
        end_date: t.endDate
      })
    }
    return next
  }

  const statusOf = (issues: JiraSyncIssue[], key: string, patch: Partial<JiraSyncIssue>): void => {
    Object.assign(issues.find((i) => i.key === key)!, patch)
  }

  it('R12: 연결 작업의 상태를 Jira 값으로 맞춘다 (in_progress → done, pending → in_progress)', () => {
    const p = refresh()
    expect(p.projectId).toBe(REFRESH_PROJECT_ID)
    expect(p.rootKey).toBe(REFRESH_ROOT_KEY)
    expect(p.statusChanges).toEqual([
      { taskId: 101, jiraKey: 'ICA-9047', from: 'in_progress', to: 'done' },
      { taskId: 103, jiraKey: 'ICA-9049', from: 'in_progress', to: 'done' },
      { taskId: 104, jiraKey: 'ICA-9051', from: 'in_progress', to: 'done' },
      { taskId: 105, jiraKey: 'ICA-9052', from: 'in_progress', to: 'done' },
      { taskId: 106, jiraKey: 'ICA-9053', from: 'pending', to: 'in_progress' }
    ])
    expect(p.backfills).toEqual([])
    expect(p.missingKeys).toEqual([])
    expect(TASK_REFRESH_LOG_LABEL).toBe('Jira 상태 동기화')
  })

  it('R12: Jira 에서 되돌린 상태도 맞춘다 (done → in_progress 역행)', () => {
    const issues = refreshIssues()
    statusOf(issues, 'ICA-9048', { status: '처리중', statusCategory: 'indeterminate' })
    statusOf(issues, 'ICA-9047', { status: '할 일', statusCategory: 'new' })
    const tasks = refreshTasks().map((t) => (t.id === 101 ? { ...t, status: 'done' } : t))
    const p = refresh(tasks, issues)
    expect(p.statusChanges).toEqual(
      expect.arrayContaining([
        { taskId: 101, jiraKey: 'ICA-9047', from: 'done', to: 'pending' },
        { taskId: 102, jiraKey: 'ICA-9048', from: 'done', to: 'in_progress' }
      ])
    )
  })

  it('R12: 같은 값이면 statusChanges 0건이고, 적용 뒤 다시 계획하면 변경 0건이다 (멱등)', () => {
    const first = refresh()
    const after = applyRefresh(refreshTasks(), first)
    const second = refresh(after)
    expect(second.statusChanges).toEqual([])
    expect(second.backfills).toEqual([])
    expect(second.newTasks).toEqual([])
    expect(second.missingKeys).toEqual([])
  })

  it('R12: 수동 작업(키 없음, 이름에 키 없음)은 statusChanges·backfills 에 없다', () => {
    const p = refresh()
    const touched = [...p.statusChanges, ...p.backfills].map((x) => x.taskId)
    expect(touched).not.toContain(107)
  })

  it('R12: 이름에 (KEY) 가 있는 키 없는 작업은 backfills 에 들어가고 상태도 맞춘다', () => {
    const tasks = [...refreshTasks(), refreshTask(108, '순위 배지 UI (ICA-9050)', 'pending')]
    const p = refresh(tasks)
    expect(p.backfills).toEqual([{ taskId: 108, jiraKey: 'ICA-9050' }])
    expect(p.statusChanges).toContainEqual({
      taskId: 108,
      jiraKey: 'ICA-9050',
      from: 'pending',
      to: 'in_progress'
    })
    expect(p.newTasks.map((t) => t.jiraKey)).not.toContain('ICA-9050')
    // 새 하위 작업의 부모는 백필된 기존 작업이다
    expect(p.newTasks.find((t) => t.jiraKey === 'ICA-9055')).toMatchObject({
      parentTaskId: 108,
      parentJiraKey: null
    })
  })

  it('R12: 에픽 루트에 새로 생긴 작업·하위 작업을 newTasks 로 낸다 (부모가 기존이면 parentTaskId, 새것이면 parentJiraKey)', () => {
    const p = refresh()
    expect(p.newTasks).toEqual([
      {
        jiraKey: 'ICA-9054',
        name: '에러 처리 (ICA-9054)',
        status: 'pending',
        endDate: null,
        parentJiraKey: null,
        parentTaskId: 101,
        sortOrder: 8
      },
      {
        jiraKey: 'ICA-9050',
        name: '순위 배지 UI (ICA-9050)',
        status: 'in_progress',
        endDate: '2026-11-20',
        parentJiraKey: null,
        parentTaskId: null,
        sortOrder: 9
      },
      {
        jiraKey: 'ICA-9055',
        name: '배지 애니메이션 (ICA-9055)',
        status: 'pending',
        endDate: null,
        parentJiraKey: 'ICA-9050',
        parentTaskId: null,
        sortOrder: 10
      }
    ])
  })

  it('R12: 기존 상위가 이미 하위 작업이면 1단계 계층을 지켜 그 최상위 아래에 둔다', () => {
    // ICA-9047 이 수동 작업 107 아래에 있으면 새 하위 ICA-9054 의 부모는 107 이다 (R6 와 같다)
    const tasks = refreshTasks().map((t) => (t.id === 101 ? { ...t, parent_task_id: 107 } : t))
    const p = refresh(tasks)
    expect(p.newTasks.find((t) => t.jiraKey === 'ICA-9054')?.parentTaskId).toBe(107)
  })

  it('R12: Sustain 루트(level standard)는 하위 작업만 최상위 newTasks 로 낸다 (QA·남의 하위 작업 제외)', () => {
    const issues: JiraSyncIssue[] = [
      issue('ICA-9100', '상품 상세 크래시 수정', 'task', 'doing'),
      issue('ICA-9101', '원인 분석', 'subtask', 'done', { parentKey: 'ICA-9100' }),
      issue('ICA-9102', '수정 배포', 'subtask', 'todo', { parentKey: 'ICA-9100' }),
      issue('ICA-9103', '서버 확인', 'subtask', 'todo', {
        parentKey: 'ICA-9100',
        assigneeAccountId: OTHER
      }),
      issue('ICA-9104', '회귀 확인', 'subtask', 'todo', {
        parentKey: 'ICA-9100',
        issueType: 'QA'
      })
    ]
    const tasks = [
      refreshTask(201, '원인 분석 (ICA-9101)', 'in_progress', { jira_issue_key: 'ICA-9101' })
    ]
    const p = buildTaskRefreshPlan(
      { myAccountId: ME, rootKey: 'ICA-9100', issues },
      REFRESH_PROJECT_ID,
      tasks
    )
    expect(p.statusChanges).toEqual([
      { taskId: 201, jiraKey: 'ICA-9101', from: 'in_progress', to: 'done' }
    ])
    expect(p.newTasks).toEqual([
      {
        jiraKey: 'ICA-9102',
        name: '수정 배포 (ICA-9102)',
        status: 'pending',
        endDate: null,
        parentJiraKey: null,
        parentTaskId: null,
        sortOrder: 102
      }
    ])
  })

  it('R12: QA 작업은 추가하지 않는다', () => {
    const keys = refresh().newTasks.map((t) => t.jiraKey)
    expect(keys).not.toContain('ICA-9056')
  })

  it('R12: DB 에 연결됐지만 스냅샷에 없는 키는 missingKeys 로 내고 상태는 그대로 둔다', () => {
    const tasks = [
      ...refreshTasks(),
      refreshTask(109, '사라진 작업 (ICA-10001)', 'in_progress', { jira_issue_key: 'ICA-10001' }),
      refreshTask(110, '권한 없는 작업 (ICA-9999)', 'pending', { jira_issue_key: 'ICA-9999' })
    ]
    const p = refresh(tasks)
    expect(p.missingKeys).toEqual(['ICA-9999', 'ICA-10001'])
    const touched = [...p.statusChanges, ...p.backfills].map((x) => x.taskId)
    expect(touched).not.toContain(109)
    expect(touched).not.toContain(110)
  })

  it('R12: 남에게 할당된 이슈는 새로 추가하지 않지만, 이미 연결된 작업이면 상태는 맞춘다', () => {
    const p = refresh()
    expect(p.newTasks.map((t) => t.jiraKey)).not.toContain('ICA-9057')
    // ICA-9052 는 담당자가 남으로 바뀌었지만 연결돼 있다
    expect(p.statusChanges).toContainEqual({
      taskId: 105,
      jiraKey: 'ICA-9052',
      from: 'in_progress',
      to: 'done'
    })
    // 담당자 필터와 무관하게 스냅샷에만 있는 연결 작업도 맞춘다 (자손이 아닌 이슈)
    const issues = [
      ...refreshIssues(),
      issue('ICA-8000', '다른 에픽으로 옮겨진 작업', 'task', 'done', {
        parentKey: 'ICA-7000',
        assigneeAccountId: OTHER
      })
    ]
    const tasks = [
      ...refreshTasks(),
      refreshTask(111, '옮겨진 작업 (ICA-8000)', 'pending', { jira_issue_key: 'ICA-8000' })
    ]
    expect(refresh(tasks, issues).statusChanges).toContainEqual({
      taskId: 111,
      jiraKey: 'ICA-8000',
      from: 'pending',
      to: 'done'
    })
  })

  it('R12: 기존 작업의 name·end_date 는 계획에 나오지 않는다', () => {
    const issues = refreshIssues()
    statusOf(issues, 'ICA-9051', { summary: 'Jira 에서 바뀐 요약', duedate: '2026-12-31' })
    const p = refresh(refreshTasks(), issues)
    expect(Object.keys(p).sort()).toEqual(
      ['backfills', 'missingKeys', 'newTasks', 'projectId', 'rootKey', 'statusChanges'].sort()
    )
    for (const c of p.statusChanges) {
      expect(Object.keys(c).sort()).toEqual(['from', 'jiraKey', 'taskId', 'to'])
    }
    for (const b of p.backfills) expect(Object.keys(b).sort()).toEqual(['jiraKey', 'taskId'])
    // 연결된 작업은 새 작업으로 다시 나오지 않는다
    expect(p.newTasks.map((t) => t.jiraKey)).not.toContain('ICA-9051')
    const after = applyRefresh(refreshTasks(), p)
    expect(after.find((t) => t.id === 104)).toMatchObject({
      name: '노출 로그 추가 (ICA-9051)',
      end_date: null
    })
  })

  it('R12: 루트를 스냅샷에서 못 찾거나 루트가 subtask 면 newTasks 0건이고 상태만 맞춘다', () => {
    const withoutRoot = refreshIssues().filter((i) => i.key !== REFRESH_ROOT_KEY)
    const missing = refresh(refreshTasks(), withoutRoot)
    expect(missing.newTasks).toEqual([])
    expect(missing.statusChanges).toHaveLength(5)

    const subtaskRoot = refreshIssues().map((i) =>
      i.key === REFRESH_ROOT_KEY ? { ...i, issueType: '하위 작업', level: 'subtask' as const } : i
    )
    const sub = refresh(refreshTasks(), subtaskRoot)
    expect(sub.newTasks).toEqual([])
    expect(sub.statusChanges).toHaveLength(5)
  })

  it('R12: 입력(tasks 배열과 스냅샷)을 바꾸지 않는다', () => {
    const tasks = [...refreshTasks(), refreshTask(108, '순위 배지 UI (ICA-9050)', 'pending')]
    const snapshot = refreshSnapshot()
    const tasksCopy = JSON.parse(JSON.stringify(tasks))
    const snapshotCopy = JSON.parse(JSON.stringify(snapshot))
    buildTaskRefreshPlan(snapshot, REFRESH_PROJECT_ID, tasks)
    expect(tasks).toEqual(tasksCopy)
    expect(snapshot).toEqual(snapshotCopy)
  })
})
