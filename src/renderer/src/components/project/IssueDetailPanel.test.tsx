import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import IssueDetailPanel, { aiChatPromptFor, openIssueChat, openIssueTodo } from './IssueDetailPanel'
import { useAiChatStore } from '../../stores/aiChatStore'
import { useQuickAddStore } from '../../stores/quickAddStore'
import type { DetailTarget } from './boardModel'
import type { JiraBoardIssue } from '../../types'

// [AI 대화로 열기] 버튼과 넘기는 프롬프트를 고정한다. 프롬프트에는 티켓 키만 들어간다(가드레일)

const issue = (over: Partial<JiraBoardIssue> = {}): JiraBoardIssue => ({
  key: 'PROJ-1',
  summary: '비밀 제목',
  issueType: '작업',
  level: 'standard',
  status: '진행 중',
  statusCategory: 'indeterminate',
  inScope: true,
  priority: null,
  parentKey: null,
  parentSummary: null,
  assigneeAccountId: null,
  assigneeName: null,
  duedate: null,
  updated: '2026-11-10T09:00:00.000Z',
  resolvedAt: null,
  labels: [],
  excerpt: '설명 본문',
  fixVersions: [],
  links: [],
  ...over
})

const target = (i: JiraBoardIssue): DetailTarget => ({
  id: i.key,
  issue: i,
  group: null,
  node: null,
  children: [],
  parentKey: null,
  parentSummary: null,
  hiddenBacklog: 0,
  hiddenPastDone: 0
})

const render = (i: JiraBoardIssue, onOpenChat?: (p: string) => void): string =>
  renderToStaticMarkup(
    <IssueDetailPanel
      target={target(i)}
      today="2026-11-19"
      onSummarize={vi.fn()}
      onOpenJira={vi.fn()}
      onOpenChat={onOpenChat}
    />
  )

describe('aiChatPromptFor', () => {
  it('에픽은 일정 초안 프롬프트, 그 밖은 정리 프롬프트를 쓴다', () => {
    expect(aiChatPromptFor('PROJ-9', true)).toBe(
      'Jira 에픽 PROJ-9 와 하위 티켓의 현재 상태를 읽고, 내가 할 일의 일정 초안을 제안해줘. 할 일로 만들기 전에 먼저 초안을 보여줘.'
    )
    expect(aiChatPromptFor('PROJ-1', false)).toBe('Jira 티켓 PROJ-1 의 내용과 최근 진행 상황을 읽고 정리해줘.')
  })
})

describe('IssueDetailPanel [AI 대화로 열기]', () => {
  it('onOpenChat 이 있으면 Jira 열기 옆에 버튼을 그린다', () => {
    const html = render(issue(), vi.fn())
    expect(html).toContain('>AI 대화로 열기</button>')
    expect(html.indexOf('Jira에서 열기')).toBeLessThan(html.indexOf('AI 대화로 열기'))
  })

  it('onOpenChat 이 없으면 버튼을 그리지 않는다', () => {
    expect(render(issue())).not.toContain('AI 대화로 열기')
  })

  it('프롬프트에는 키 외의 Jira 텍스트(제목·설명)가 없다', () => {
    for (const p of [aiChatPromptFor('PROJ-1', false), aiChatPromptFor('PROJ-1', true)]) {
      expect(p).toContain('PROJ-1')
      expect(p).not.toContain('비밀 제목')
      expect(p).not.toContain('설명 본문')
    }
  })
})

describe('openIssueChat', () => {
  it('에픽·일반 모두 승인 후 쓰기(ask) 모드로 startChatWith 를 부른다', async () => {
    const startChatWith = vi.fn(async () => {})
    const original = useAiChatStore.getState().startChatWith
    useAiChatStore.setState({ startChatWith })
    try {
      await openIssueChat(aiChatPromptFor('PROJ-9', true))
      await openIssueChat(aiChatPromptFor('PROJ-1', false))
    } finally {
      useAiChatStore.setState({ startChatWith: original })
    }
    expect(startChatWith.mock.calls).toEqual([
      [aiChatPromptFor('PROJ-9', true), { writeMode: 'ask' }],
      [aiChatPromptFor('PROJ-1', false), { writeMode: 'ask' }]
    ])
  })
})

describe('IssueDetailPanel [할 일로 만들기]', () => {
  const withSite = (siteUrl: string | null): string =>
    renderToStaticMarkup(
      <IssueDetailPanel
        target={target(issue())}
        today="2026-11-19"
        onSummarize={vi.fn()}
        onOpenJira={vi.fn()}
        jiraSiteUrl={siteUrl}
      />
    )

  it('Jira 사이트 주소를 알면 Jira 열기 옆에 버튼을 그린다', () => {
    const html = withSite('https://x.atlassian.net')
    expect(html).toContain('>할 일로 만들기</button>')
    expect(html.indexOf('Jira에서 열기')).toBeLessThan(html.indexOf('>할 일로 만들기<'))
  })

  it('사이트 주소를 모르면 버튼을 숨긴다', () => {
    expect(withSite(null)).not.toContain('>할 일로 만들기<')
    expect(render(issue())).not.toContain('>할 일로 만들기<')
  })

  it('누르면 "[KEY] 요약" 과 티켓 웹 주소로 빠른 추가를 연다', () => {
    useQuickAddStore.getState().close()
    openIssueTodo('PROJ-1', '로그인 오류', 'https://x.atlassian.net/')
    expect(useQuickAddStore.getState()).toMatchObject({
      isOpen: true,
      initialText: '[PROJ-1] 로그인 오류',
      sourceLink: 'https://x.atlassian.net/browse/PROJ-1'
    })
    useQuickAddStore.getState().close()
    openIssueTodo('PROJ-1', '로그인 오류', null)
    expect(useQuickAddStore.getState().isOpen).toBe(false)
  })
})
