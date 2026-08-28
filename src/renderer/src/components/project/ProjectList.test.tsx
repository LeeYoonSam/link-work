import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Project } from '../../types'

// 목록이 우선순위 그룹으로 나뉘어 그려지는지, 미지정 그룹이 항상 맨 뒤로 가는지 고정한다.
//
// zustand v5는 서버 렌더(renderToStaticMarkup)에서 초기 상태만 돌려주므로
// 스토어 훅 자체를 모킹한다 (RecognitionAidsPanel.test.tsx와 같은 방식).
const state: { projects: Project[] } = { projects: [] }

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: () => ({
    projects: state.projects,
    loading: false,
    fetchProjects: async () => {},
    fetchProject: async () => {},
    setProjectView: () => {},
    setEditingProject: () => {},
    updateProject: async () => {},
    reorderProjects: async () => {}
  })
}))

const ProjectList = (await import('./ProjectList')).default

const project = (over: Partial<Project> & Pick<Project, 'id' | 'name'>): Project => ({
  description: null,
  dev_start_date: '2026-03-02',
  dev_end_date: '2026-03-20',
  qa_start_date: '2026-03-23',
  qa_end_date: '2026-03-25',
  deploy_date: '2026-03-27',
  deploy_version: null,
  status: 'development',
  status_manual: 0,
  priority: null,
  sort_order: 0,
  created_at: '2026-02-01',
  updated_at: '2026-02-01',
  ...over
})

const render = (projects: Project[]): string => {
  state.projects = projects
  return renderToStaticMarkup(<ProjectList />)
}

describe('ProjectList 우선순위 그룹', () => {
  it('Now/Next/Later/미지정 순으로 그룹 헤더를 그린다', () => {
    const html = render([
      project({ id: 1, name: '미지정 프로젝트' }),
      project({ id: 2, name: 'Later 프로젝트', priority: 'later' }),
      project({ id: 3, name: 'Now 프로젝트', priority: 'now' }),
      project({ id: 4, name: 'Next 프로젝트', priority: 'next' })
    ])

    const headers = ['Now', 'Next', 'Later', '우선순위 없음'].map((label) => html.indexOf(label))
    expect(headers.every((i) => i >= 0)).toBe(true)
    expect(headers).toEqual([...headers].sort((a, b) => a - b))
  })

  it('프로젝트 카드도 그룹 순서대로 놓인다 — 미지정은 마지막', () => {
    const html = render([
      project({ id: 1, name: '미지정 프로젝트' }),
      project({ id: 2, name: 'Now 프로젝트', priority: 'now' })
    ])
    expect(html.indexOf('Now 프로젝트')).toBeLessThan(html.indexOf('미지정 프로젝트'))
  })

  it('같은 그룹 안에서는 sort_order 오름차순으로 놓인다', () => {
    const html = render([
      project({ id: 1, name: '뒤에 오는 것', priority: 'now', sort_order: 5 }),
      project({ id: 2, name: '앞에 오는 것', priority: 'now', sort_order: 1 })
    ])
    expect(html.indexOf('앞에 오는 것')).toBeLessThan(html.indexOf('뒤에 오는 것'))
  })

  it('비어 있는 그룹의 헤더는 그리지 않는다', () => {
    const html = render([project({ id: 1, name: 'Now 프로젝트', priority: 'now' })])
    expect(html).toContain('Now')
    expect(html).not.toContain('우선순위 없음')
    expect(html).not.toContain('Later')
  })

  // 미지정 그룹은 상태순 자동 정렬이라 sort_order가 무시된다. 끌 수 있게 두면
  // 저장은 되는데 화면은 제자리로 돌아와, 사용자에게는 그냥 고장으로 보인다.
  it('미지정 그룹 카드는 끌 수 없고 드래그 핸들도 보이지 않는다', () => {
    const html = render([project({ id: 1, name: '미지정 프로젝트' })])
    expect(html).toContain('draggable="false"')
    expect(html).not.toContain('draggable="true"')
    expect(html).not.toContain('⠿')
  })

  it('우선순위를 지정한 그룹의 카드는 끌 수 있다', () => {
    const html = render([project({ id: 1, name: 'Now 프로젝트', priority: 'now' })])
    expect(html).toContain('draggable="true"')
    expect(html).toContain('⠿')
  })

  // 필터 목록을 손으로 적어두면 상태가 늘 때 한쪽만 고쳐진다. STATUS_RANK에서 파생시켜
  // 두면 새 상태가 자동으로 따라 들어온다.
  it('상태 필터는 정렬 순위표에서 파생돼 중단까지 포함한다', () => {
    const html = render([project({ id: 1, name: 'Now 프로젝트', priority: 'now' })])
    expect(html).toContain('value="on_hold"')
    expect(html).toContain('value="development"')
    expect(html).toContain('value="cancelled"')
  })

  it('프로젝트가 없으면 빈 상태만 보인다', () => {
    const html = render([])
    expect(html).toContain('No projects found')
    expect(html).not.toContain('우선순위 없음')
  })
})
