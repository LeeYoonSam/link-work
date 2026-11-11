import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Project, TaskRefreshResult } from '../../types'

// 상세 헤더의 중단/재개 버튼이 현재 상태를 라벨로 드러내는지 고정한다.
// 버튼이 보내는 페이로드는 statusSelectionPatch 테스트가 맡는다.
const state: { currentProject: Project | null } = { currentProject: null }

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: () => ({
    currentProject: state.currentProject,
    tasks: [],
    setProjectView: () => {},
    setEditingProject: () => {},
    deleteProject: async () => {},
    patchProject: async () => {},
    updateTask: async () => {},
    fetchTasks: async () => {}
  })
}))

vi.mock('../../stores/documentStore', () => ({
  useDocumentStore: () => ({
    documents: [],
    fetchDocuments: async () => {},
    openDocument: async () => {},
    deleteDocument: async () => {}
  })
}))

// 작업 목록과 릴리스 노트는 각자 스토어·IPC를 끌고 온다. 이 테스트의 관심사가 아니라 잘라낸다.
// 단, 헤더 슬롯(headerActions)은 ProjectDetail 이 채우므로 그대로 그린다.
vi.mock('./TaskList', () => ({
  default: ({ headerActions }: { headerActions?: React.ReactNode }) => headerActions ?? null
}))
vi.mock('./ReleaseNotesCard', () => ({ default: () => null }))

const { default: ProjectDetail, detailMenuItems, refreshOnEnter, refreshResultLabel } = await import(
  './ProjectDetail'
)

const PROJECT: Project = {
  id: 1,
  name: '테스트 프로젝트',
  description: null,
  dev_start_date: '2026-03-02',
  dev_end_date: '2026-03-20',
  qa_start_date: '2026-03-23',
  qa_end_date: '2026-03-25',
  deploy_date: '2026-03-27',
  deploy_version: null,
  status: 'development',
  status_manual: 0,
  priority: 'now',
  sort_order: 0,
  created_at: '2026-02-01',
  updated_at: '2026-02-01'
}

const render = (over: Partial<Project> = {}): string => {
  state.currentProject = { ...PROJECT, ...over }
  return renderToStaticMarkup(<ProjectDetail />)
}

// 중단 상태에서는 상태 뱃지도 '중단'이라 문자열 검색만으로는 버튼과 뱃지가 섞인다.
// 버튼 라벨만 뽑아 비교한다.
const buttonLabels = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])

const noop = (): void => {}

describe('ProjectDetail 헤더', () => {
  // 액션을 늘어놓던 자리다. 좁은 폭에서 한글 버튼이 세로로 깨져 Edit과 ⋯ 둘만 남겼고,
  // 나머지는 오버플로 메뉴로 접었다. 다시 늘어나면 같은 증상이 돌아온다.
  it('상시 노출되는 액션은 Edit과 오버플로 트리거뿐이다', () => {
    const labels = buttonLabels(render())
    expect(labels).toContain('Edit')
    expect(labels).toContain('⋯')
    expect(labels).not.toContain('중단')
    expect(labels).not.toContain('Delete')
  })

  it('액션 그룹은 수축하지 않고 제목 컬럼이 수축을 흡수한다', () => {
    const html = render()
    expect(html).toContain('flex shrink-0 items-center gap-2')
    expect(html).toContain('min-w-0')
  })

  it('중단 상태의 뱃지는 취소로 대체되지 않고 제 토큰을 쓴다', () => {
    const html = render({ status: 'on_hold', status_manual: 1 })
    expect(html).toContain('bg-zinc-200')
    expect(html).not.toContain('Cancelled')
  })

  // 뱃지가 중단 상태를 이미 말해주므로, 닫힌 메뉴 뒤에 라벨을 숨겨도 상태는 계속 보인다.
  it('중단 상태는 메뉴를 열지 않아도 뱃지로 드러난다', () => {
    expect(render({ status: 'on_hold', status_manual: 1 })).toContain('중단')
  })
})

// 메뉴는 닫힌 채로 렌더되므로 항목은 마크업에 없다. 구성은 빌더에서 직접 확인한다.
describe('detailMenuItems', () => {
  it('진행 중이면 중단 항목과 Delete를 담는다', () => {
    const items = detailMenuItems({ onHold: false, onToggleHold: noop, onDelete: noop })
    expect(items.map((i) => i.label)).toEqual(['중단', 'Delete'])
    expect(items[0].description).toBe('상태 수동 고정')
  })

  it('중단된 프로젝트에는 재개 항목이 온다', () => {
    const items = detailMenuItems({ onHold: true, onToggleHold: noop, onDelete: noop })
    expect(items[0].label).toBe('재개')
    expect(items[0].description).toBe('자동 계산으로 복귀')
  })

  it('Delete는 구분선 아래 파괴적 액션으로 떨어져 있다', () => {
    const items = detailMenuItems({ onHold: false, onToggleHold: noop, onDelete: noop })
    const del = items[items.length - 1]
    expect(del.tone).toBe('danger')
    expect(del.separatorBefore).toBe(true)
  })

  it('항목을 고르면 넘긴 핸들러가 그대로 실행된다', () => {
    const toggle = vi.fn()
    const remove = vi.fn()
    const items = detailMenuItems({ onHold: false, onToggleHold: toggle, onDelete: remove })
    items[0].onSelect()
    items[1].onSelect()
    expect(toggle).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
  })
})

// R12: Jira 와 연결된 프로젝트만 작업 상태를 Jira 값으로 다시 맞추는 버튼을 둔다.
describe('R12 Jira 동기화 버튼', () => {
  it('R12 jira_issue_key 가 있는 프로젝트는 Jira 동기화 버튼을 보인다', () => {
    expect(buttonLabels(render({ jira_issue_key: 'ICA-9046' }))).toContain('Jira 동기화')
  })

  it('R12 jira_issue_key 가 없는 프로젝트는 버튼을 보이지 않는다', () => {
    expect(buttonLabels(render({ jira_issue_key: null }))).not.toContain('Jira 동기화')
    expect(buttonLabels(render())).not.toContain('Jira 동기화')
  })
})

describe('R12 refreshResultLabel', () => {
  const result = (over: Partial<TaskRefreshResult>): TaskRefreshResult => ({
    projectId: 1,
    skipped: false,
    statusChanged: 0,
    tasksAdded: 0,
    missingKeys: [],
    refreshedAt: '2026-11-11T00:00:00.000Z',
    ...over
  })

  it('R12 변경이 있으면 상태·작업 추가 건수를 보인다', () => {
    expect(refreshResultLabel(result({ statusChanged: 4, tasksAdded: 1 }))).toBe(
      '상태 4건 · 작업 추가 1건'
    )
  })

  it('R12 변경이 없으면 변경 없음을 보인다', () => {
    expect(refreshResultLabel(result({}))).toBe('변경 없음')
  })
})

describe('R12 진입 새로고침 refreshOnEnter', () => {
  const ok = (over: Partial<TaskRefreshResult>) =>
    vi.fn(async () => ({
      success: true as const,
      result: {
        projectId: 29,
        skipped: false,
        statusChanged: 0,
        tasksAdded: 0,
        missingKeys: [],
        refreshedAt: '2026-11-11T00:00:00.000Z',
        ...over
      }
    }))

  it('R12 enter 사유로 1번 부르고 변경이 있으면 작업 목록을 다시 읽는다', async () => {
    const refresh = ok({ statusChanged: 5 })
    const fetchTasks = vi.fn(async () => {})
    await refreshOnEnter(29, { refresh, fetchTasks, isCurrent: () => true })
    expect(refresh).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledWith(29, 'enter')
    expect(fetchTasks).toHaveBeenCalledWith(29)
  })

  it('R12 건너뛰었거나 변경이 없으면 다시 읽지 않는다', async () => {
    const fetchTasks = vi.fn(async () => {})
    await refreshOnEnter(29, { refresh: ok({ skipped: true }), fetchTasks, isCurrent: () => true })
    await refreshOnEnter(29, { refresh: ok({}), fetchTasks, isCurrent: () => true })
    expect(fetchTasks).not.toHaveBeenCalled()
  })

  it('R12 프로젝트를 떠난 뒤 늦게 온 응답은 무시한다', async () => {
    const fetchTasks = vi.fn(async () => {})
    await refreshOnEnter(29, { refresh: ok({ tasksAdded: 2 }), fetchTasks, isCurrent: () => false })
    expect(fetchTasks).not.toHaveBeenCalled()
  })

  it('R12 실패는 콘솔에만 남기고 throw 하지 않는다', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchTasks = vi.fn(async () => {})
    try {
      await refreshOnEnter(29, {
        refresh: vi.fn(async () => ({ success: false as const, error: 'Jira 와 연결된 프로젝트가 아닙니다.' })),
        fetchTasks,
        isCurrent: () => true
      })
      await refreshOnEnter(29, {
        refresh: vi.fn(async () => {
          throw new Error('IPC 끊김')
        }),
        fetchTasks,
        isCurrent: () => true
      })
      expect(err).toHaveBeenCalledTimes(2)
      expect(fetchTasks).not.toHaveBeenCalled()
    } finally {
      err.mockRestore()
    }
  })
})
