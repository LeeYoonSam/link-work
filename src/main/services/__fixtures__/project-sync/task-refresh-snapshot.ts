// R12 연결 작업 새로고침 픽스처 — 실제 사례의 형태만 옮긴 가상 데이터다. 실 계정 정보는 없다.
// 에픽은 처리중이고 그 아래 작업이 모두 `할 일` 을 벗어나 R1~R11 싱크업이 다시 계획하지 않는 프로젝트다.
import type { JiraSyncIssue } from '../../jira'
import type { DbTaskRow, TaskRefreshSnapshot } from '../../project-sync-plan'
import { issue, ME, OTHER } from './proj-snapshot'

export const REFRESH_PROJECT_ID = 29
export const REFRESH_ROOT_KEY = 'ICA-9046'

const resolved = { status: '해결됨' } as const
const reviewing = { status: '리뷰중', statusCategory: 'indeterminate' } as const

/**
 * 시나리오
 * - 루트 에픽 ICA-9046(처리중)
 * - 작업 ICA-9047(해결됨) 과 하위 ICA-9048·ICA-9049(해결됨) — DB 에 연결됨
 * - 작업 ICA-9050(처리중) 과 하위 ICA-9055(할 일) — DB 에 없음 → 새 작업
 * - 하위 ICA-9054(할 일) 가 기존 작업 ICA-9047 아래에 새로 생김 → 새 작업
 * - 작업 ICA-9051(해결됨), ICA-9052(해결됨, 담당자가 남으로 바뀜), ICA-9053(리뷰중) — DB 에 연결됨
 * - 작업 ICA-9056(QA 라벨), ICA-9057(남에게 할당) — 추가하지 않음
 */
export function refreshIssues(): JiraSyncIssue[] {
  const epic = { parentKey: REFRESH_ROOT_KEY }
  return [
    issue(REFRESH_ROOT_KEY, 'PDP 소셜 프루프 넛징 - 카테고리 베스트 순위 노출', 'epic', 'doing'),
    issue('ICA-9047', '베스트 순위 API 연동', 'task', 'done', { ...epic, ...resolved }),
    issue('ICA-9048', '응답 모델 정의', 'subtask', 'done', {
      parentKey: 'ICA-9047',
      ...resolved
    }),
    issue('ICA-9049', '캐시 정책', 'subtask', 'done', { parentKey: 'ICA-9047', ...resolved }),
    issue('ICA-9050', '순위 배지 UI', 'task', 'doing', { ...epic, duedate: '2026-11-20' }),
    issue('ICA-9051', '노출 로그 추가', 'task', 'done', { ...epic, ...resolved }),
    issue('ICA-9052', '카테고리 매핑', 'task', 'done', {
      ...epic,
      ...resolved,
      assigneeAccountId: OTHER
    }),
    issue('ICA-9053', '디자인 검수 반영', 'task', 'doing', { ...epic, ...reviewing }),
    issue('ICA-9054', '에러 처리', 'subtask', 'todo', { parentKey: 'ICA-9047' }),
    issue('ICA-9055', '배지 애니메이션', 'subtask', 'todo', { parentKey: 'ICA-9050' }),
    issue('ICA-9056', '순위 노출 검수', 'task', 'todo', { ...epic, labels: ['qa'] }),
    issue('ICA-9057', '서버 순위 집계', 'task', 'todo', { ...epic, assigneeAccountId: OTHER })
  ]
}

export function refreshSnapshot(issues: JiraSyncIssue[] = refreshIssues()): TaskRefreshSnapshot {
  return { myAccountId: ME, rootKey: REFRESH_ROOT_KEY, issues }
}

export function refreshTask(
  id: number,
  name: string,
  status: string,
  overrides: Partial<DbTaskRow> = {}
): DbTaskRow {
  return {
    id,
    project_id: REFRESH_PROJECT_ID,
    parent_task_id: null,
    name,
    status,
    sort_order: id - 100,
    jira_issue_key: null,
    end_date: null,
    ...overrides
  }
}

/** 프로젝트 29 의 현재 작업 — 연결 작업 6개와 수동 작업 1개 */
export function refreshTasks(): DbTaskRow[] {
  return [
    refreshTask(101, '베스트 순위 API 연동 (ICA-9047)', 'in_progress', {
      jira_issue_key: 'ICA-9047'
    }),
    refreshTask(102, '응답 모델 정의 (ICA-9048)', 'done', {
      jira_issue_key: 'ICA-9048',
      parent_task_id: 101
    }),
    refreshTask(103, '캐시 정책 (ICA-9049)', 'in_progress', {
      jira_issue_key: 'ICA-9049',
      parent_task_id: 101
    }),
    refreshTask(104, '노출 로그 추가 (ICA-9051)', 'in_progress', { jira_issue_key: 'ICA-9051' }),
    refreshTask(105, '카테고리 매핑 (ICA-9052)', 'in_progress', { jira_issue_key: 'ICA-9052' }),
    refreshTask(106, '디자인 검수 반영 (ICA-9053)', 'pending', { jira_issue_key: 'ICA-9053' }),
    refreshTask(107, '킥오프 미팅', 'in_progress')
  ]
}
