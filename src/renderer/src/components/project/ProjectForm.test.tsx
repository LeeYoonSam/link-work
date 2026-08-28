import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Project } from '../../types'

// 상태 select에 중단이 실제로 걸려 있는지, 우선순위 필드가 생성·편집 모두에 나오는지 고정한다.
// 저장 페이로드 자체는 순수 함수(statusSelectionPatch)로 뽑아 두고 거기서 검증한다 —
// 이 저장소에는 jsdom·testing-library가 없어 select 조작을 흉내 낼 수 없다.
const state: { editingProject: Project | null } = { editingProject: null }

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: () => ({
    editingProject: state.editingProject,
    createProject: async () => {},
    updateProject: async () => {},
    setProjectView: () => {}
  })
}))

const ProjectForm = (await import('./ProjectForm')).default

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

const render = (editing: Project | null): string => {
  state.editingProject = editing
  return renderToStaticMarkup(<ProjectForm />)
}

describe('ProjectForm', () => {
  it('편집 모드의 상태 select에 중단 옵션이 있다', () => {
    const html = render(PROJECT)
    expect(html).toContain('value="on_hold"')
    expect(html).toContain('중단')
  })

  it('상태 select는 자동 복귀 옵션을 함께 제공한다 — 중단을 풀 수단', () => {
    const html = render(PROJECT)
    expect(html).toContain('value="auto"')
  })

  it('우선순위 select는 생성 모드에도 나온다', () => {
    const html = render(null)
    expect(html).toContain('우선순위 없음')
    expect(html).toContain('value="now"')
    expect(html).toContain('value="later"')
  })

  it('상태 select는 편집 모드 전용이다', () => {
    expect(render(null)).not.toContain('value="on_hold"')
  })
})
