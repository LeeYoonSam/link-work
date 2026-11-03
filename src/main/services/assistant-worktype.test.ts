import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QA_EPIC_PATTERN, SUSTAIN_EPIC_PATTERN } from './project-sync-plan'
import type { PlanItem, WorkClassifyInput } from './assistant-types'
import {
  classifyWork,
  extractVersion,
  isGroupCandidate,
  isGroupItem,
  QA_PATTERN,
  SUSTAIN_PATTERN,
  WORK_TYPE_LABEL,
  workTypeLabel
} from './assistant-worktype'

function input(over: Partial<WorkClassifyInput>): WorkClassifyInput {
  return {
    source: 'jira', jiraKey: 'ICA-1', title: '작업', parentSummary: null, projectName: null, issueType: '작업',
    ...over
  }
}

type GroupRef = Pick<PlanItem, 'id' | 'jira_issue_key' | 'parent_key' | 'status'>
function ref(id: number, over: Partial<GroupRef> = {}): GroupRef {
  return { id, jira_issue_key: null, parent_key: null, status: 'planned', ...over }
}

describe('classifyWork (A48)', () => {
  it('A48: todo·action_item·manual 은 패턴과 무관하게 etc 다', () => {
    for (const source of ['todo', 'action_item', 'manual'] as const) {
      expect(classifyWork(input({ source, jiraKey: null, title: 'v4.174.0 QA [TRD] PRD' })).workType).toBe('etc')
    }
  })

  it('A48: 부모 요약이 QA 면 qa 다 (ICA-8971)', () => {
    const r = classifyWork(input({
      jiraKey: 'ICA-8971', title: '안드로이드 구매자 앱 v4.174.0 QA', parentSummary: '안드로이드QA-2026'
    }))
    expect(r).toEqual({ workType: 'qa', workVersion: '4.174.0' })
  })

  it('A48: 이슈 유형이 qa 면 qa 다', () => {
    expect(classifyWork(input({ title: '로그인 점검', issueType: 'QA Task' })).workType).toBe('qa')
  })

  it('A48: 제목에 QA 와 버전이 함께 있으면 qa 다', () => {
    expect(classifyWork(input({ title: '구매자 앱 4.170.1 QA' }))).toEqual({ workType: 'qa', workVersion: '4.170.1' })
  })

  it('A48: QA 에픽 자체는 qa 다 (ICA-8054)', () => {
    const r = classifyWork(input({ jiraKey: 'ICA-8054', title: '안드로이드QA-2026', issueType: '에픽' }))
    expect(r).toEqual({ workType: 'qa', workVersion: null })
  })

  it('A48: 셀프 QA 같은 개발 작업은 qa 가 아니다', () => {
    expect(classifyWork(input({ jiraKey: null, source: 'task', title: '셀프 QA', projectName: '회의 정리' })).workType)
      .toBe('etc')
  })

  it('A48: 릴리스 WBS 프로젝트는 qa 다', () => {
    const r = classifyWork(input({ source: 'task', jiraKey: null, title: '배포 노트', projectName: '4.165.0 릴리스', issueType: null }))
    expect(r).toEqual({ workType: 'qa', workVersion: '4.165.0' })
  })

  it('A48: Sus 패턴은 sus 다. 버전도 함께 뽑는다', () => {
    expect(classifyWork(input({ title: '[Android/Sus] Sprint 26-11' }))).toEqual({ workType: 'sus', workVersion: null })
    expect(classifyWork(input({ title: '[SUS] 크래시 수정' })).workType).toBe('sus')
    expect(classifyWork(input({ source: 'task', jiraKey: null, title: '정리', projectName: 'Sus 개선 작업 (4.162.0)', issueType: null })))
      .toEqual({ workType: 'sus', workVersion: '4.162.0' })
  })

  it('A48: TRD 부모의 하위 작업은 trd 다 (ICA-8571)', () => {
    const r = classifyWork(input({
      jiraKey: 'ICA-8571', title: '[코루틴] W2-2 홈 베스트·세일·메인 화면군 UseCase 마이그레이션',
      parentSummary: '[TRD] RxJava to Coroutine Phase2'
    }))
    expect(r.workType).toBe('trd')
    expect(classifyWork(input({ title: '[Android/TRD] 모듈 분리' })).workType).toBe('trd')
  })

  it('A48: PRD 패턴은 prd 다', () => {
    expect(classifyWork(input({ title: '[PRD] 장바구니 개편', issueType: '작업' })).workType).toBe('prd')
  })

  it('A48: 접두 없는 에픽과 그 하위는 prd 다 (ICA-8929·ICA-8984)', () => {
    const epic = '[폴더블] 넓은 화면 공통 기준 적용 - Android'
    expect(classifyWork(input({ jiraKey: 'ICA-8929', title: epic, issueType: 'Epic' })).workType).toBe('prd')
    expect(classifyWork(input({ jiraKey: 'ICA-8984', title: '[폴더블] 넓은 화면 공통 기반', parentSummary: epic })).workType)
      .toBe('prd')
  })

  it('A48: 패턴이 없는 WBS 작업과 부모 없는 Jira 작업은 etc 다', () => {
    expect(classifyWork(input({ source: 'task', jiraKey: null, title: '회의 정리', projectName: '팀 운영', issueType: null })).workType)
      .toBe('etc')
    expect(classifyWork(input({ title: '단독 작업' })).workType).toBe('etc')
  })

  it('A48: 순서는 QA → SUS → TRD → PRD 다', () => {
    expect(classifyWork(input({ title: '[SUS] 정리', parentSummary: '안드로이드QA-2026' })).workType).toBe('qa')
    expect(classifyWork(input({ title: '[SUS] [TRD] 정리' })).workType).toBe('sus')
    expect(classifyWork(input({ title: '[TRD] [PRD] 정리' })).workType).toBe('trd')
  })

  it('A48: 입력을 바꾸지 않고 같은 입력에 같은 출력을 낸다', () => {
    const i = Object.freeze(input({ title: 'v4.174.0 QA' }))
    expect(classifyWork(i)).toEqual(classifyWork(i))
  })

  it('A48: 릴리스 문구가 있는 action_item 도 etc 다', () => {
    expect(classifyWork(input({ source: 'action_item', jiraKey: null, title: '174 버전 릴리스를 시작한다.' })))
      .toEqual({ workType: 'etc', workVersion: null })
  })
})

describe('extractVersion (A48)', () => {
  it('A48: N.N.N 만 뽑고 v 접두를 뗀다', () => {
    expect(extractVersion(['안드로이드 구매자 앱 v4.174.0 QA'])).toBe('4.174.0')
    expect(extractVersion(['(4.162.0)'])).toBe('4.162.0')
    expect(extractVersion(['4.174.0'])).toBe('4.174.0')
  })

  it('A48: 스프린트 번호·2단·4단 버전은 null 이다', () => {
    expect(extractVersion(['[Android/Sus] Sprint 26-11'])).toBeNull()
    expect(extractVersion(['v4.174'])).toBeNull()
    expect(extractVersion(['1.2.3.4'])).toBeNull()
  })

  it('A48: 앞에서부터 첫 일치를 돌려주고 null·빈 값은 건너뛴다', () => {
    expect(extractVersion([null, undefined, '', '4.1.0', '5.0.0'])).toBe('4.1.0')
    expect(extractVersion([])).toBeNull()
  })
})

describe('패턴·라벨 (A48)', () => {
  it('A48: SUSTAIN·QA 패턴이 project-sync-plan 과 같다', () => {
    expect(SUSTAIN_PATTERN.source).toBe(SUSTAIN_EPIC_PATTERN.source)
    expect(SUSTAIN_PATTERN.flags).toBe(SUSTAIN_EPIC_PATTERN.flags)
    expect(QA_PATTERN.source).toBe(QA_EPIC_PATTERN.source)
    expect(QA_PATTERN.flags).toBe(QA_EPIC_PATTERN.flags)
  })

  it('A48: workTypeLabel 은 qa 에만 버전을 붙인다', () => {
    expect(workTypeLabel('qa', '4.174.0')).toBe('QA 4.174.0')
    expect(workTypeLabel('qa', null)).toBe('QA')
    expect(workTypeLabel('sus', '4.162.0')).toBe('SUS')
    expect(workTypeLabel('etc', null)).toBe('기타')
    expect(WORK_TYPE_LABEL.prd).toBe('PRD')
  })

  it('A3: assistant-worktype.ts 는 ./assistant-types 만 import 한다', () => {
    const src = readFileSync(join(__dirname, 'assistant-worktype.ts'), 'utf8')
    const froms = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(froms).toEqual(['./assistant-types'])
  })
})

describe('isGroupItem·isGroupCandidate (A49)', () => {
  it('A49: 받아들인 하위가 있는 Jira 항목은 묶음이다', () => {
    const epic = ref(1, { jira_issue_key: 'ICA-8054' })
    for (const status of ['planned', 'in_progress', 'done', 'deferred'] as const) {
      expect(isGroupItem(epic, [epic, ref(2, { parent_key: 'ICA-8054', status })])).toBe(true)
    }
  })

  it('A49: suggested·dismissed·dropped 하위는 세지 않는다', () => {
    const epic = ref(1, { jira_issue_key: 'ICA-8054' })
    for (const status of ['suggested', 'dismissed', 'dropped'] as const) {
      expect(isGroupItem(epic, [epic, ref(2, { parent_key: 'ICA-8054', status })])).toBe(false)
    }
  })

  it('A49: 하위가 없는 에픽과 Jira 키가 없는 항목은 보통 항목이다', () => {
    const epic = ref(1, { jira_issue_key: 'ICA-8929' })
    expect(isGroupItem(epic, [epic])).toBe(false)
    const self = ref(3, { jira_issue_key: 'X-1', parent_key: 'X-1' })
    expect(isGroupItem(self, [self])).toBe(false)
    expect(isGroupItem(ref(4), [ref(4), ref(5, { parent_key: null })])).toBe(false)
  })

  it('A49: 다른 후보의 parentKey 가 이 키면 묶음 후보다', () => {
    const cands = [{ parentKey: null }, { parentKey: 'ICA-8054' }]
    expect(isGroupCandidate({ jiraKey: 'ICA-8054' }, cands)).toBe(true)
    expect(isGroupCandidate({ jiraKey: 'ICA-8929' }, cands)).toBe(false)
    expect(isGroupCandidate({ jiraKey: null }, [{ parentKey: null }])).toBe(false)
  })
})
