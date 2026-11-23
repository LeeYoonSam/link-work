import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import JiraWorkCard, { jiraDueText } from './JiraWorkCard'
import type { JiraRow, TodayDashboard } from './todayModel'
import { click, findButton } from './testTree'

const row = (over: Partial<JiraRow> & Pick<JiraRow, 'key'>): JiraRow => ({
  summary: '작업',
  status: '진행 중',
  statusCategory: 'indeterminate',
  review: false,
  duedate: null,
  overdue: false,
  dueToday: false,
  signaled: false,
  revealable: true,
  ...over
})

const jira = (over: Partial<TodayDashboard['jira']> = {}): TodayDashboard['jira'] => ({
  state: 'ok',
  rows: [
    row({ key: 'ICA-700', summary: '지난 마감', duedate: '2026-11-17', overdue: true, signaled: true }),
    row({ key: 'ICA-701', summary: '오늘 마감', duedate: '2026-11-19', dueToday: true }),
    row({ key: 'ICA-702', summary: '리뷰 중', status: '코드 리뷰', review: true })
  ],
  moreCount: 4,
  ...over
})

const noop = (): void => {}
const props = { onOpenIssue: noop, onOpenBoard: noop, onOpenSettings: noop }

describe('JiraWorkCard', () => {
  it('행·상태 배지·마감·강조 표식·외 n건 을 그린다', () => {
    const html = renderToStaticMarkup(<JiraWorkCard jira={jira()} {...props} />)
    expect(html).toContain('내 Jira 작업')
    expect(html).toContain('ICA-700')
    expect(html).toContain('11/17 지남')
    expect(html).toContain('오늘 마감')
    expect(html).toContain('코드 리뷰')
    expect(html).toContain('외 4건 →')
    // 총 건수 = 행 + 나머지
    expect(html).toContain('>7</span>')
    const first = html.slice(html.indexOf('data-issue="ICA-700"'), html.indexOf('data-issue="ICA-701"'))
    expect(first).toContain('먼저 챙길 항목')
  })

  it('상태별 빈 문구. 미연결이면 설정 이동 링크를 보인다', () => {
    const nc = renderToStaticMarkup(<JiraWorkCard jira={jira({ state: 'not_connected', rows: [], moreCount: 0 })} {...props} />)
    expect(nc).toContain('Jira가 연결되지 않았어요')
    expect(nc).toContain('설정에서 연결하기')
    expect(renderToStaticMarkup(<JiraWorkCard jira={jira({ state: 'no_project', rows: [], moreCount: 0 })} {...props} />)).toContain(
      '기본 Jira 프로젝트'
    )
    expect(renderToStaticMarkup(<JiraWorkCard jira={jira({ state: 'loading', rows: [], moreCount: 0 })} {...props} />)).toContain(
      '불러오는 중'
    )
    const err = renderToStaticMarkup(
      <JiraWorkCard jira={jira({ state: 'error', rows: [], moreCount: 0 })} {...props} errorText="토큰 만료" />
    )
    expect(err).toContain('Jira 작업을 불러오지 못했어요')
    expect(err).toContain('토큰 만료')
    expect(err).not.toContain('다시 시도')
    const withRetry = renderToStaticMarkup(
      <JiraWorkCard jira={jira({ state: 'error', rows: [], moreCount: 0 })} {...props} onRetry={() => {}} retrying />
    )
    expect(withRetry).toMatch(/<button[^>]*disabled=""[^>]*>다시 불러오는 중…<\/button>/)
    expect(err).not.toContain('설정에서 연결하기')
    expect(renderToStaticMarkup(<JiraWorkCard jira={jira({ rows: [], moreCount: 0 })} {...props} />)).toContain(
      '지금 맡은 진행 작업이 없어요'
    )
  })

  it('이동: 키 → onOpenIssue, 외 n건 → onOpenBoard, 미연결 링크 → onOpenSettings', () => {
    const onOpenIssue = vi.fn()
    const onOpenBoard = vi.fn()
    const onOpenSettings = vi.fn()
    const tree = JiraWorkCard({ jira: jira(), onOpenIssue, onOpenBoard, onOpenSettings })
    click(findButton(tree, 'ICA-701'))
    expect(onOpenIssue).toHaveBeenCalledWith(expect.objectContaining({ key: 'ICA-701' }))
    click(findButton(tree, '외 4건'))
    expect(onOpenBoard).toHaveBeenCalledTimes(1)
    const nc = JiraWorkCard({ jira: jira({ state: 'not_connected', rows: [], moreCount: 0 }), onOpenIssue, onOpenBoard, onOpenSettings })
    click(findButton(nc, '설정에서 연결하기'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('error 상태의 다시 시도 버튼은 onRetry 를 부른다', () => {
    const onRetry = vi.fn()
    const tree = JiraWorkCard({ jira: jira({ state: 'error', rows: [], moreCount: 0 }), ...props, onRetry })
    click(findButton(tree, '다시 시도'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('jiraDueText: 지남·오늘·그 밖', () => {
    expect(jiraDueText({ duedate: null, overdue: false, dueToday: false })).toBeNull()
    expect(jiraDueText({ duedate: '2026-11-17', overdue: true, dueToday: false })?.text).toBe('11/17 지남')
    expect(jiraDueText({ duedate: '2026-11-19', overdue: false, dueToday: true })?.text).toBe('오늘 마감')
    expect(jiraDueText({ duedate: '2026-11-25', overdue: false, dueToday: false })?.text).toBe('11/25 마감')
  })
})
