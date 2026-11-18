import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement, ReactNode } from 'react'

// 프로젝트 페이지 탭 컨테이너: 선택한 탭만 마운트, 릴리스 배지, 탭 전환, 릴리스 탭에서만 markSeen.

type Tab = 'tickets' | 'releases' | 'docs'
let tab: Tab = 'tickets'
let unseen = 0
const setProjectsTab = vi.fn<(t: Tab) => void>()
const markSeen = vi.fn<(part: 'release') => void>()
const load = vi.fn(async () => {})

vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: (sel: (s: unknown) => unknown) =>
    sel({ view: 'projects', projectsTab: tab, setProjectsTab, setView: () => {}, openProjectsTab: () => {} })
}))
vi.mock('../../stores/morningSyncStore', () => ({
  useMorningSyncStore: (sel: (s: unknown) => unknown) => sel({ unseenCount: () => unseen, markSeen })
}))
vi.mock('../../stores/jiraBoardStore', () => ({
  useJiraBoardStore: { getState: () => ({ load }) }
}))
vi.mock('../release/ReleasesView', () => ({ default: () => <div data-panel="releases" /> }))
vi.mock('./ProjectBoardView', () => ({ default: () => <div data-panel="tickets" /> }))
vi.mock('./DocsTab', () => ({ default: () => <div data-panel="docs" /> }))

// 효과(useEffect)를 렌더 중에 바로 돌려 markSeen·load 호출을 확인한다. 서버 렌더는 효과를 돌리지 않는다
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useEffect: (fn: () => void) => void fn() }
})

const mod = await import('./ProjectsPage')
const ProjectsPage = mod.default
const { shouldMarkReleasesSeen, nextTabId } = mod

const render = (t: Tab, n = 0): string => {
  tab = t
  unseen = n
  return renderToStaticMarkup(<ProjectsPage />)
}

beforeEach(() => {
  setProjectsTab.mockClear()
  markSeen.mockClear()
  load.mockClear()
})

describe('ProjectsPage 탭', () => {
  it('탭 바 3개와 선택한 탭 하나만 마운트한다', () => {
    for (const t of ['tickets', 'releases', 'docs'] as const) {
      const html = render(t)
      expect(html.match(/role="tab"/g)).toHaveLength(3)
      expect(html).toContain(`data-panel="${t}"`)
      expect(html.match(/data-panel=/g)).toHaveLength(1)
      expect(html).toMatch(new RegExp(`id="projects-tab-${t}"[^>]*aria-selected="true"`))
    }
    expect(render('tickets')).toContain('>티켓<')
  })

  it('aria-controls 는 마운트된 패널이 있는 활성 탭에만 단다', () => {
    const html = render('docs')
    expect(html.match(/aria-controls=/g)).toHaveLength(1)
    expect(html).toMatch(/id="projects-tab-docs"[^>]*aria-controls="projects-panel-docs"/)
    expect(html).toContain('id="projects-panel-docs"')
  })

  it('새 릴리스가 있으면 릴리스 탭 라벨에 배지를 단다', () => {
    expect(render('tickets', 3)).toContain('새 릴리스 3건')
    expect(render('tickets', 0)).not.toContain('새 릴리스')
  })

  it('탭을 누르면 navigationStore 의 탭을 바꾼다', () => {
    tab = 'tickets'
    const tree = ProjectsPage() as ReactElement<{ children: ReactNode }>
    const buttons = findAll(tree, (el) => (el.props as { role?: string }).role === 'tab')
    expect(buttons).toHaveLength(3)
    ;(buttons[2].props as { onClick: () => void }).onClick()
    expect(setProjectsTab).toHaveBeenCalledWith('docs')
  })

  it('마운트되면 보드 저장본을 올린다(릴리스 탭부터 열어도)', () => {
    render('releases')
    expect(load).toHaveBeenCalled()
  })
})

describe('ProjectsPage 탭 키보드(APG)', () => {
  it('←/→ 는 순환, Home/End 는 처음·끝, 그 밖은 null', () => {
    expect(nextTabId('tickets', 'ArrowRight')).toBe('releases')
    expect(nextTabId('docs', 'ArrowRight')).toBe('tickets')
    expect(nextTabId('tickets', 'ArrowLeft')).toBe('docs')
    expect(nextTabId('releases', 'Home')).toBe('tickets')
    expect(nextTabId('tickets', 'End')).toBe('docs')
    expect(nextTabId('tickets', 'Enter')).toBeNull()
  })
  it('탭 버튼의 Home 키가 첫 탭으로 바꾼다', () => {
    tab = 'docs'
    const tree = ProjectsPage() as ReactElement<{ children: ReactNode }>
    const [first] = findAll(tree, (el) => (el.props as { role?: string }).role === 'tab')
    const preventDefault = vi.fn()
    // 노드 환경이라 포커스 이동 대상만 흉내 낸다
    const focus = vi.fn()
    vi.stubGlobal('document', { getElementById: (id: string) => (id === 'projects-tab-tickets' ? { focus } : null) })
    try {
      ;(first.props as { onKeyDown: (e: unknown) => void }).onKeyDown({ key: 'Home', preventDefault })
    } finally {
      vi.unstubAllGlobals()
    }
    expect(setProjectsTab).toHaveBeenCalledWith('tickets')
    expect(preventDefault).toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
  })
})

describe('ProjectsPage markSeen', () => {
  it('릴리스 탭이 열려 있고 안 본 것이 있을 때만 본 것으로 표시한다', () => {
    render('releases', 2)
    expect(markSeen).toHaveBeenCalledWith('release')
  })
  it('다른 탭이거나 안 본 것이 없으면 표시하지 않는다', () => {
    render('tickets', 2)
    render('docs', 2)
    render('releases', 0)
    expect(markSeen).not.toHaveBeenCalled()
  })
  it('shouldMarkReleasesSeen', () => {
    expect(shouldMarkReleasesSeen('releases', 1)).toBe(true)
    expect(shouldMarkReleasesSeen('releases', 0)).toBe(false)
    expect(shouldMarkReleasesSeen('tickets', 5)).toBe(false)
  })
})

function findAll(node: ReactNode, pred: (el: ReactElement) => boolean): ReactElement[] {
  const out: ReactElement[] = []
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (!n || typeof n !== 'object' || !('props' in n)) return
    const el = n as ReactElement<{ children?: ReactNode }>
    if (pred(el)) out.push(el)
    walk(el.props.children)
  }
  walk(node)
  return out
}
