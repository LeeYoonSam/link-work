// 업무 유형 분류와 묶음 판정 (부록 J.3·J.4, A48·A49). 순수 모듈이다.
import type {
  Candidate, PlanItem, PlanItemStatus, WorkClassification, WorkClassifyInput, WorkType
} from './assistant-types'

// project-sync-plan.ts 의 SUSTAIN_EPIC_PATTERN·QA_EPIC_PATTERN 과 같은 문자열이다.
// import 하면 ADF·날짜 유틸을 끌고 와서 복사한다. 테스트가 두 패턴의 source 가 같은지 확인한다.
export const SUSTAIN_PATTERN = /\bsus(tain(ing)?)?\b/i
export const QA_PATTERN = /QA/
export const TRD_PATTERN = /\bTRD\b/i
export const PRD_PATTERN = /\bPRD\b/i
export const EPIC_TYPE_PATTERN = /epic|에픽/i
export const RELEASE_PROJECT_PATTERN = /릴리스|release|QA/i
export const VERSION_PATTERN = /(?:^|[^\d.])v?(\d+\.\d+\.\d+)(?![\d.])/
export const WORK_TYPE_LABEL: Record<WorkType, string> = { qa: 'QA', sus: 'SUS', trd: 'TRD', prd: 'PRD', etc: '기타' }

const NON_WORK_SOURCES = new Set(['todo', 'action_item', 'manual'])
const GROUP_CHILD_STATUSES = new Set<PlanItemStatus>(['planned', 'in_progress', 'done', 'deferred'])

/** 앞에서부터 처음 맞는 N.N.N 버전을 돌려준다. */
export function extractVersion(texts: (string | null | undefined)[]): string | null {
  for (const text of texts) {
    if (!text) continue
    const m = VERSION_PATTERN.exec(text)
    if (m) return m[1]
  }
  return null
}

/** J.3 순서대로 판정한다. 먼저 맞는 규칙이 이긴다. */
export function classifyWork(input: WorkClassifyInput): WorkClassification {
  const { source, jiraKey, title, parentSummary, projectName, issueType } = input
  const workVersion = extractVersion([title, parentSummary, projectName])
  const result = (workType: WorkType): WorkClassification => ({ workType, workVersion })
  if (NON_WORK_SOURCES.has(source)) return result('etc')

  const isEpic = issueType !== null && EPIC_TYPE_PATTERN.test(issueType)
  if (parentSummary !== null && QA_PATTERN.test(parentSummary)) return result('qa')
  if (issueType !== null && /qa/i.test(issueType)) return result('qa')
  if (QA_PATTERN.test(title) && extractVersion([title]) !== null) return result('qa')
  if (QA_PATTERN.test(title) && isEpic) return result('qa')
  if (projectName !== null && RELEASE_PROJECT_PATTERN.test(projectName)) return result('qa')

  const texts = [title, parentSummary, projectName].filter((t): t is string => t !== null)
  if (texts.some((t) => SUSTAIN_PATTERN.test(t))) return result('sus')
  if (texts.some((t) => TRD_PATTERN.test(t))) return result('trd')
  if (texts.some((t) => PRD_PATTERN.test(t))) return result('prd')
  if (jiraKey !== null && isEpic) return result('prd')
  if (jiraKey !== null && parentSummary !== null) return result('prd')
  return result('etc')
}

/** 'QA 4.174.0' | 'QA' | 'SUS' | '기타'. 버전은 qa 에만 붙인다. */
export function workTypeLabel(type: WorkType, version: string | null): string {
  const label = WORK_TYPE_LABEL[type]
  return type === 'qa' && version ? `${label} ${version}` : label
}

/** 받아들인 하위 항목이 같은 계획에 1건 이상 있는 Jira 항목이다 (J.4). */
export function isGroupItem(
  item: Pick<PlanItem, 'id' | 'jira_issue_key'>,
  items: Pick<PlanItem, 'id' | 'parent_key' | 'status'>[]
): boolean {
  const key = item.jira_issue_key
  if (key === null) return false
  return items.some((o) => o.id !== item.id && o.parent_key === key && GROUP_CHILD_STATUSES.has(o.status))
}

/** 다른 후보의 parentKey 가 이 후보의 Jira 키다 (J.4 후보 단계). */
export function isGroupCandidate(
  c: Pick<Candidate, 'jiraKey'>,
  candidates: Pick<Candidate, 'parentKey'>[]
): boolean {
  const key = c.jiraKey
  if (key === null) return false
  return candidates.some((o) => o.parentKey === key)
}
