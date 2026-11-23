import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ReleaseCard, { dDayLabel, phaseSteps, shortDayLabel } from './ReleaseCard'
import type { JiraRow, NextRelease } from './releaseModel'
import { collect, click, findButton } from './testTree'

const row = (over: Partial<JiraRow> & Pick<JiraRow, 'key'>): JiraRow => ({
  summary: '결제 화면 수정',
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

const release = (over: Partial<NextRelease> = {}): NextRelease => ({
  version: '4.177.0',
  date: '2026-11-24',
  dDay: 5,
  linked: true,
  noteId: 12,
  jiraVersionId: '10501',
  qaStart: '2026-11-19',
  qaEnd: '2026-11-23',
  phase: 'qa',
  totalCount: 40,
  mine: { total: 5, done: 3, review: 1, progress: 1, todo: 0 },
  rows: [
    row({ key: 'ICA-812', signaled: true }),
    row({ key: 'ICA-790', status: '코드 리뷰', review: true, summary: '리뷰 대기' })
  ],
  moreCount: 2,
  ...over
})

const noop = (): void => {}

describe('ReleaseCard', () => {
  it('버전·D-day·날짜, 단계 선(오늘 위치), 내 작업 막대, 행, 외 n건 을 그린다', () => {
    const html = renderToStaticMarkup(<ReleaseCard release={release()} onOpenIssue={noop} onOpenRelease={noop} />)
    expect(html).toContain('4.177.0')
    expect(html).toContain('D-5')
    expect(html).toContain('11/24(화)')
    expect(html).toContain('data-phase="qa" data-state="current"')
    expect(html).toContain('data-phase="dev" data-state="done"')
    expect(html).toContain('data-phase="release_day" data-state="todo"')
    expect(html).toContain('11/19(목)~11/23(월)')
    expect(html).toContain('내 작업 5건: 완료 3 · 리뷰 1 · 진행 1')
    expect(html).toContain('ICA-812')
    expect(html).toContain('ICA-790')
    expect(html).toContain('외 2건 →')
    // 신호에 올라간 행은 표식만 붙는다
    const r812 = html.slice(html.indexOf('data-issue="ICA-812"'), html.indexOf('data-issue="ICA-790"'))
    expect(r812).toContain('먼저 챙길 항목')
    expect(html.slice(html.indexOf('data-issue="ICA-790"'))).not.toContain('먼저 챙길 항목')
  })

  it('Jira 릴리스와 연결 안 되면 그 문구와 일정만 보인다', () => {
    const html = renderToStaticMarkup(
      <ReleaseCard
        release={release({ linked: false, version: null, totalCount: null, rows: [], moreCount: 0, noteId: null, jiraVersionId: null })}
        onOpenIssue={noop}
        onOpenRelease={noop}
      />
    )
    expect(html).toContain('Jira 릴리스와 연결 안 됨')
    expect(html).toContain('버전 미정')
    expect(html).toContain('data-phase="qa"')
    expect(html).not.toContain('내 작업')
  })

  it('내 작업이 0건이면 빈 막대 없이 문구 한 번만 보인다. 범례에는 같은 색 점이 붙는다', () => {
    const zero = renderToStaticMarkup(
      <ReleaseCard release={release({ mine: { total: 0, done: 0, review: 0, progress: 0, todo: 0 }, rows: [], moreCount: 0 })} onOpenIssue={noop} onOpenRelease={noop} />
    )
    expect(zero).not.toContain('role="img"')
    expect(zero.match(/내 작업/g) ?? []).toHaveLength(1)
    expect(zero).toContain('이 배포에 든 내 작업이 없어요')
    const html = renderToStaticMarkup(<ReleaseCard release={release()} onOpenIssue={noop} onOpenRelease={noop} />)
    expect(html).toMatch(/rounded-full bg-green-500"><\/span>완료 3/)
    expect(html).toContain('max-w-60 flex-1')
  })

  it('행은 키 · 제목 바로 뒤 상태 배지의 1줄 모양이다(내 Jira 작업 카드와 같음)', () => {
    const html = renderToStaticMarkup(<ReleaseCard release={release()} onOpenIssue={noop} onOpenRelease={noop} />)
    const r = html.slice(html.indexOf('data-issue="ICA-790"'))
    expect(r.indexOf('ICA-790')).toBeLessThan(r.indexOf('리뷰 대기'))
    expect(r.indexOf('리뷰 대기')).toBeLessThan(r.indexOf('코드 리뷰'))
  })

  it('mineKnown=false 면 내 작업 막대·빈 문구 대신 불러오기 안내 한 줄', () => {
    const html = renderToStaticMarkup(
      <ReleaseCard release={release({ mineKnown: false })} onOpenIssue={noop} onOpenRelease={noop} />
    )
    expect(html).toContain('Jira를 불러오면 이 배포의 내 작업이 보여요')
    expect(html).not.toContain('role="img"')
    expect(html).not.toContain('내 작업이 없어요')
    expect(html).not.toContain('data-issue=')
  })

  it('배포를 모르는 까닭에 따라 빈 문구가 다르다', () => {
    const r = (reason: 'not_connected' | 'load_failed' | null): string =>
      renderToStaticMarkup(<ReleaseCard release={null} onOpenIssue={noop} onOpenRelease={noop} unknownReason={reason} />)
    expect(r('not_connected')).toContain('Jira를 연결하면 다음 배포가 보여요')
    expect(r('load_failed')).toContain('Jira를 불러오면 다음 배포가 보여요')
    expect(r(null)).toContain('예정된 배포가 없어요')
  })

  it('예정된 배포가 없으면 빈 문구를 보인다', () => {
    expect(renderToStaticMarkup(<ReleaseCard release={null} onOpenIssue={noop} onOpenRelease={noop} />)).toContain(
      '예정된 배포가 없어요'
    )
  })

  it('D-1 이하는 빨간 배지다', () => {
    expect(renderToStaticMarkup(<ReleaseCard release={release({ dDay: 1 })} onOpenIssue={noop} onOpenRelease={noop} />)).toContain(
      'bg-red-50 text-red-700'
    )
  })

  it('이슈 키를 누르면 onOpenIssue, 외 n건 을 누르면 onOpenRelease 를 부른다', () => {
    const onOpenIssue = vi.fn()
    const onOpenRelease = vi.fn()
    const tree = ReleaseCard({ release: release(), onOpenIssue, onOpenRelease })
    click(findButton(tree, 'ICA-790'))
    expect(onOpenIssue).toHaveBeenCalledWith(expect.objectContaining({ key: 'ICA-790' }))
    click(findButton(tree, '외 2건'))
    expect(onOpenRelease).toHaveBeenCalledTimes(1)
    expect(collect(tree).filter((e) => e.type === 'button')).toHaveLength(3)
  })

  it('헬퍼: D-day·날짜·단계', () => {
    expect(dDayLabel(0)).toBe('D-day')
    expect(dDayLabel(5)).toBe('D-5')
    expect(dDayLabel(-1)).toBe('D+1')
    expect(shortDayLabel('2026-12-01')).toBe('12/1(화)')
    expect(shortDayLabel(null)).toBe('')
    expect(phaseSteps({ phase: 'release_day', qaStart: null, qaEnd: null, date: '2026-11-24' }).map((s) => s.state)).toEqual([
      'done',
      'done',
      'current'
    ])
    expect(phaseSteps({ phase: 'dev', qaStart: null, qaEnd: null, date: '2026-11-24' })[1].sub).toBe('일정 없음')
  })
})
