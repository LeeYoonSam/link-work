import { describe, it, expect } from 'vitest'
import type { CalendarEvent, JiraBoardIssue, JiraBoardSnapshot, ReleaseNoteSummary } from '../../types'
import {
  classifyReleaseEvent,
  normalizeVersion,
  resolveNextRelease,
  releaseRiskKeys,
  RELEASE_ROW_LIMIT
} from './releaseModel'

// 실데이터(2026-11-19 기준 Tech 캘린더·릴리스 노트)를 그대로 옮긴 사례로 다음 배포 판정을 고정한다.

const allDay = (id: string, summary: string, start: string, end: string): CalendarEvent => ({
  id,
  summary,
  start,
  end,
  allDay: true
})

const note = (over: Partial<ReleaseNoteSummary> & { id: number; version_name: string }): ReleaseNoteSummary => ({
  jira_project_key: 'ICA',
  jira_version_id: `v-${over.id}`,
  description: null,
  released: 0,
  archived: 0,
  release_date: null,
  start_date: null,
  last_synced_at: null,
  last_sync_error: null,
  created_at: '2026-11-01 00:00:00',
  updated_at: '2026-11-01 00:00:00',
  item_count: 0,
  ...over
})

const issue = (key: string, over: Partial<JiraBoardIssue> = {}): JiraBoardIssue => ({
  key,
  summary: `${key} 요약`,
  issueType: '작업',
  level: 'standard',
  status: '진행 중',
  statusCategory: 'indeterminate',
  inScope: true,
  priority: null,
  parentKey: null,
  parentSummary: null,
  assigneeAccountId: 'me',
  assigneeName: '나',
  duedate: null,
  updated: '2026-11-18T00:00:00.000Z',
  resolvedAt: null,
  labels: [],
  excerpt: null,
  fixVersions: [],
  links: [],
  ...over
})

const snap = (issues: JiraBoardIssue[], myAccountId: string | null = 'me'): JiraBoardSnapshot => ({
  projectKey: 'ICA',
  myAccountId,
  issues,
  truncated: false,
  recentDoneDays: 14,
  fetchedAt: '2026-11-19T00:00:00.000Z',
  lastFullSyncAt: null
})

// 실제 캘린더: QA 11/19~11/23(종료 11/24 배타), 배포 11/24(제목 앞 공백), 12/1 배포(버전 없음)
const REAL_EVENTS: CalendarEvent[] = [
  allDay('qa', '[QA] Release Train', '2026-11-19', '2026-11-24'),
  allDay('rel1', ' App Release(v4.177.0)', '2026-11-24', '2026-11-25'),
  allDay('rel2', ' App Release', '2026-12-01', '2026-12-02'),
  { id: 'weekly', summary: 'Tech weekly', start: '2026-11-19T14:00:00+09:00', end: '2026-11-19T14:40:00+09:00', allDay: false }
]
const V177 = { id: 177, version_name: '4.177.0', jira_version_id: '10177', release_date: '2026-11-24', released: 1, item_count: 42 }
const REAL_NOTES: ReleaseNoteSummary[] = [
  note(V177),
  note({ id: 178, version_name: '4.178.0', jira_version_id: '10178', release_date: '2026-12-01', item_count: 7 }),
  note({ id: 179, version_name: '4.177.0-alpha02', jira_version_id: '10179', release_date: null })
]
const TODAY = '2026-11-19'
const fv177 = [{ id: '10177', name: '4.177.0' }]

describe('classifyReleaseEvent', () => {
  it('배포 일정은 앞 공백을 무시하고 버전을 읽는다', () => {
    expect(classifyReleaseEvent(REAL_EVENTS[1])).toEqual({
      kind: 'release',
      title: 'App Release(v4.177.0)',
      version: '4.177.0',
      start: '2026-11-24',
      endInclusive: '2026-11-24'
    })
    expect(classifyReleaseEvent(REAL_EVENTS[2])?.version).toBeNull()
  })

  it('QA 일정의 끝은 배타 종료에서 하루 뺀다', () => {
    expect(classifyReleaseEvent(REAL_EVENTS[0])).toMatchObject({ kind: 'qa', start: '2026-11-19', endInclusive: '2026-11-23' })
  })

  it('시간 있는 일정·관계없는 종일 일정은 무시한다', () => {
    expect(classifyReleaseEvent(REAL_EVENTS[3])).toBeNull()
    expect(classifyReleaseEvent({ ...REAL_EVENTS[1], allDay: false })).toBeNull()
    expect(classifyReleaseEvent(allDay('x', '휴가', '2026-11-20', '2026-11-21'))).toBeNull()
  })
})

describe('normalizeVersion', () => {
  it('정식 x.y.z 만 받는다', () => {
    expect(normalizeVersion('v4.177.0')).toBe('4.177.0')
    expect(normalizeVersion('4.177.0')).toBe('4.177.0')
    expect(normalizeVersion('4.177.0-alpha02')).toBeNull()
    expect(normalizeVersion('Sprint 12')).toBeNull()
  })
})

describe('resolveNextRelease — 실데이터 사례', () => {
  it('11/19: 4.177.0, D-5, QA 단계, Jira 릴리스와 연결', () => {
    const r = resolveNextRelease({ today: TODAY, events: REAL_EVENTS, notes: REAL_NOTES, snapshot: null })!
    expect(r).toMatchObject({
      version: '4.177.0',
      date: '2026-11-24',
      dDay: 5,
      linked: true,
      noteId: 177,
      jiraVersionId: '10177',
      qaStart: '2026-11-19',
      qaEnd: '2026-11-23',
      phase: 'qa',
      totalCount: 42
    })
  })

  it('released=1 이어도 날짜가 미래면 다음 배포로 본다', () => {
    const r = resolveNextRelease({ today: TODAY, events: [], notes: REAL_NOTES, snapshot: null })!
    expect(r.version).toBe('4.177.0')
    expect(r.qaStart).toBeNull()
    expect(r.linked).toBe(true)
    expect(r.phase).toBe('dev')
  })

  it('버전 없는 12/1 배포 일정은 날짜로 4.178.0 과 매칭한다', () => {
    const r = resolveNextRelease({ today: '2026-11-25', events: REAL_EVENTS, notes: REAL_NOTES, snapshot: null })!
    expect(r).toMatchObject({ version: '4.178.0', date: '2026-12-01', dDay: 6, linked: true, noteId: 178, phase: 'dev', qaStart: null })
  })

  it('배포일 당일은 release_day', () => {
    const r = resolveNextRelease({ today: '2026-11-24', events: REAL_EVENTS, notes: REAL_NOTES, snapshot: null })!
    expect(r.phase).toBe('release_day')
    expect(r.dDay).toBe(0)
  })

  it('매칭에 실패하면 linked:false 이고 포함 이슈를 세지 않는다', () => {
    const s = snap([issue('ICA-812', { fixVersions: fv177 })])
    const r = resolveNextRelease({ today: TODAY, events: REAL_EVENTS, notes: [], snapshot: s })!
    expect(r.linked).toBe(false)
    expect(r.version).toBe('4.177.0')
    expect(r.totalCount).toBeNull()
    expect(r.mine.total).toBe(0)
    expect(r.rows).toEqual([])
    expect(releaseRiskKeys(r, TODAY)).toEqual([])
  })

  it('캘린더도 릴리스도 없으면 null, 접미사 버전·과거 날짜·보관 릴리스는 후보가 아니다', () => {
    expect(resolveNextRelease({ today: TODAY, events: [], notes: [], snapshot: null })).toBeNull()
    const notes = [
      note({ id: 1, version_name: '4.177.0-alpha02', release_date: '2026-11-20' }),
      note({ id: 2, version_name: '4.176.0', release_date: '2026-11-10' }),
      note({ id: 3, version_name: '4.179.0', release_date: '2026-11-21', archived: 1 })
    ]
    expect(resolveNextRelease({ today: TODAY, events: [], notes, snapshot: null })).toBeNull()
  })
})

describe('resolveNextRelease — 내 작업', () => {
  const issues = [
    issue('ICA-812', { fixVersions: fv177 }), // 진행 중 → QA 중 위험
    issue('ICA-830', { statusCategory: 'new', status: '할 일', fixVersions: fv177 }), // 할 일 → 위험
    issue('ICA-790', { status: 'In Review', fixVersions: fv177 }), // 리뷰 → 위험 아님
    issue('ICA-700', { statusCategory: 'done', status: '완료', fixVersions: [{ id: 'other', name: 'v4.177.0' }] }), // 이름으로 매칭
    issue('ICA-701', { statusCategory: 'done', status: '완료', fixVersions: fv177 }),
    issue('ICA-702', { statusCategory: 'done', status: '완료', fixVersions: fv177 }),
    issue('ICA-900', { fixVersions: fv177, assigneeAccountId: 'other' }), // 남의 것
    issue('ICA-1', { level: 'epic', fixVersions: fv177 }), // 에픽 제외
    issue('ICA-950', {}) // fixVersion 없음
  ]

  it('mine 집계와 위험 행 우선 정렬', () => {
    const r = resolveNextRelease({ today: TODAY, events: REAL_EVENTS, notes: REAL_NOTES, snapshot: snap(issues) })!
    expect(r.mine).toEqual({ total: 6, done: 3, review: 1, progress: 1, todo: 1 })
    expect(r.rows.map((x) => x.key)).toEqual(['ICA-812', 'ICA-830', 'ICA-790'])
    expect(releaseRiskKeys(r, TODAY)).toEqual(['ICA-812', 'ICA-830'])
    expect(r.moreCount).toBe(0)
  })

  it('QA 전(dev)에는 위험이 없고, D-1 이면 리뷰 중이어도 미완료는 위험', () => {
    const dev = resolveNextRelease({ today: '2026-11-17', events: REAL_EVENTS, notes: REAL_NOTES, snapshot: snap(issues) })!
    expect(dev.phase).toBe('dev')
    expect(releaseRiskKeys(dev, '2026-11-17')).toEqual([])
    const d1 = resolveNextRelease({ today: '2026-11-23', events: REAL_EVENTS, notes: REAL_NOTES, snapshot: snap(issues) })!
    expect(d1.dDay).toBe(1)
    expect(releaseRiskKeys(d1, '2026-11-23')).toEqual(['ICA-812', 'ICA-790', 'ICA-830'])
  })

  it('위험 아닌 행은 상한 3, 나머지는 moreCount', () => {
    const many = Array.from({ length: 6 }, (_, k) => issue(`ICA-${100 + k}`, { status: 'Code Review', fixVersions: fv177 }))
    const r = resolveNextRelease({ today: '2026-11-17', events: REAL_EVENTS, notes: REAL_NOTES, snapshot: snap(many) })!
    expect(r.rows).toHaveLength(RELEASE_ROW_LIMIT)
    expect(r.moreCount).toBe(3)
  })

  it('내 계정을 모르면 포함 이슈를 세지 않는다', () => {
    const r = resolveNextRelease({ today: TODAY, events: REAL_EVENTS, notes: REAL_NOTES, snapshot: snap(issues, null) })!
    expect(r.mine.total).toBe(0)
    expect(releaseRiskKeys(r, TODAY)).toEqual([])
  })
})
