import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import type { JiraBoardIssue } from '../../types'

// treegrid 키 처리의 가로채기 규칙을 잠근다.
// 이 저장소에는 DOM 테스트 환경(jsdom 등)이 없고 새 의존성은 들이지 않는다. 그래서 React 의 훅 3개만
// 단순 구현으로 바꿔 IssueTree 를 함수로 직접 부르고, 반환된 treegrid 의 onKeyDown 에 가짜 이벤트를 넣는다.
// 실제 컴포넌트의 핸들러가 그대로 돈다. "버튼 click 발생"은 브라우저 기본 동작(버튼 위 Enter → click)이라
// preventDefault 를 부르지 않았는지로 판정한다.

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(init: T | (() => T)) => [typeof init === 'function' ? (init as () => T)() : init, () => {}],
    useRef: <T,>(init: T) => ({ current: init }),
    useEffect: () => {}
  }
})

const { default: IssueTree } = await import('./IssueTree')
const { buildIssueForest, flattenVisible } = await import('./boardModel')

const issue = (over: Partial<JiraBoardIssue>): JiraBoardIssue => ({
  key: 'PROJ-1',
  summary: '제목',
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
  updated: '2026-11-10T00:00:00Z',
  resolvedAt: null,
  labels: [],
  excerpt: null,
  ...over
})

const forest = buildIssueForest(
  [issue({ key: 'PROJ-1', level: 'epic', issueType: '에픽' }), issue({ key: 'PROJ-2', parentKey: 'PROJ-1' })],
  '2026-11-18'
)
const rows = flattenVisible(forest, {})

let onSelect: ReturnType<typeof vi.fn<(id: string) => void>>
let onOpenJira: ReturnType<typeof vi.fn<(key: string) => void>>
let onToggle: ReturnType<typeof vi.fn<(id: string, expanded: boolean) => void>>

beforeEach(() => {
  onSelect = vi.fn<(id: string) => void>()
  onOpenJira = vi.fn<(key: string) => void>()
  onToggle = vi.fn<(id: string, expanded: boolean) => void>()
})

// 선택한 행(PROJ-2) 아래 인라인 상세에 버튼이 있는 상태로 그린다
const treegridKeyDown = (): ((e: unknown) => void) => {
  const el = IssueTree({
    rows,
    forest,
    selectedId: 'PROJ-2',
    today: '2026-11-18',
    onSelect,
    onToggle,
    onOpenJira,
    renderInlineDetail: () => <button type="button">AI 요약</button>
  }) as ReactElement<{ role: string; onKeyDown: (e: unknown) => void; children: ReactNode }>
  expect(el.props.role).toBe('treegrid')
  return el.props.onKeyDown
}

const fakeEvent = (key: string, role: string | null, mods: { metaKey?: boolean } = {}) => {
  const preventDefault = vi.fn()
  return {
    event: { key, ...mods, target: { getAttribute: (n: string) => (n === 'role' ? role : null) }, preventDefault },
    preventDefault
  }
}

describe('IssueTree 키 가로채기', () => {
  it('상세 패널 버튼에서 Enter: 행 선택이 바뀌지 않고 기본 동작(버튼 click)을 막지 않는다', () => {
    const { event, preventDefault } = fakeEvent('Enter', null)
    treegridKeyDown()(event)
    expect(onSelect).not.toHaveBeenCalled()
    expect(onOpenJira).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('버튼에서 o·⌘Enter·화살표도 트리가 가로채지 않는다', () => {
    for (const [key, mods] of [['o', {}], ['Enter', { metaKey: true }], ['ArrowDown', {}], [' ', {}]] as const) {
      const { event, preventDefault } = fakeEvent(key, null, mods)
      treegridKeyDown()(event)
      expect(preventDefault, key).not.toHaveBeenCalled()
    }
    expect(onSelect).not.toHaveBeenCalled()
    expect(onOpenJira).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('행 자체에서 Enter 는 상세 선택, o 는 Jira 열기', () => {
    const enter = fakeEvent('Enter', 'row')
    treegridKeyDown()(enter.event)
    expect(onSelect).toHaveBeenCalledWith('PROJ-2')
    expect(enter.preventDefault).toHaveBeenCalled()

    treegridKeyDown()(fakeEvent('o', 'row').event)
    expect(onOpenJira).toHaveBeenCalledWith('PROJ-2')
  })

  it('행 자체에서 ← 는 부모로 포커스를 옮긴다(기본 동작은 막는다)', () => {
    const left = fakeEvent('ArrowLeft', 'row')
    treegridKeyDown()(left.event)
    expect(left.preventDefault).toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })
})
