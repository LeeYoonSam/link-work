// 비서 순수 모듈 테스트용 픽스처 생성기
import type { Candidate, PlanItem, SourceSnapshot } from '../../assistant-types'

export const TODAY = '2026-11-02'

export function cand(over: Partial<Candidate> & Pick<Candidate, 'id'>): Candidate {
  const source = over.source ?? (over.id.split(':')[0] as Candidate['source'])
  return {
    source,
    title: over.id,
    jiraKey: null,
    projectId: null,
    projectName: null,
    dueDate: null,
    dueTime: null,
    inProgress: false,
    priority: null,
    jiraPriority: null,
    lastTouchedAt: null,
    link: null,
    parentKey: null,
    groupName: null,
    workType: 'etc',
    workVersion: null,
    ...over
  }
}

export function item(over: Partial<PlanItem> & Pick<PlanItem, 'id'>): PlanItem {
  const candidate_id = over.candidate_id ?? `todo:${over.id}`
  return {
    plan_id: 1,
    candidate_id,
    source: candidate_id.split(':')[0] as PlanItem['source'],
    title: candidate_id,
    link: null,
    jira_issue_key: null,
    project_id: null,
    due_date: null,
    score: 0,
    rank: over.id,
    slot_start: null,
    slot_end: null,
    pinned: false,
    added_by: 'start',
    urgent: false,
    status: 'planned',
    status_note: null,
    status_at: null,
    first_planned_date: null,
    work_type: 'etc',
    work_version: null,
    parent_key: null,
    group_name: null,
    ...over
  }
}

export function snapshot(over: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return { calendar: [], jira: [], seenCandidateIds: [], takenAt: `${TODAY} 09:00:00`, ...over }
}

/** 객체를 깊게 얼린다. 입력 변경 시 TypeError 가 난다 (A14 검증용). */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
  }
  return value
}
