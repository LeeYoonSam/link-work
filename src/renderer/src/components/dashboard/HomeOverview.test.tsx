import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Memo, Project } from '../../types'

// 홈('오늘' 화면) 개요의 내용을 마크업으로 잠근다 (메뉴 통합 D1·D2).
// zustand v5 는 서버 렌더에서 초기 상태만 돌려준다. 그래서 스토어 훅을 모킹한다
// (ProjectList.test.tsx 와 같은 방식). 자동 클릭이 불가해 renderToStaticMarkup 으로 판정한다.

const state: { projects: Project[]; importantMemos: Memo[] } = { projects: [], importantMemos: [] }

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: () => ({
    projects: state.projects,
    fetchProjects: async () => {},
    setView: () => {}
  })
}))

vi.mock('../../stores/memoStore', () => ({
  useMemoStore: () => ({
    importantMemos: state.importantMemos,
    fetchImportantMemos: async () => {}
  })
}))

const { default: HomeOverview, HomeProjects, HomeMemos } = await import('./HomeOverview')

const project = (over: Partial<Project> & Pick<Project, 'id' | 'name'>): Project => ({
  description: null,
  dev_start_date: '2026-11-02',
  dev_end_date: '2026-11-20',
  qa_start_date: '2026-11-23',
  qa_end_date: '2026-11-25',
  deploy_date: '2026-11-27',
  deploy_version: null,
  status: 'development',
  status_manual: 0,
  priority: 'now',
  sort_order: 0,
  created_at: '2026-11-01',
  updated_at: '2026-11-01',
  ...over
})

const memo = (over: Partial<Memo> & Pick<Memo, 'id' | 'content'>): Memo => ({
  is_archived: 0,
  is_important: 1,
  color: 'yellow',
  category_id: null,
  created_at: '2026-11-02 09:15:00',
  updated_at: '2026-11-02 09:15:00',
  ...over
})

const render = (): string => renderToStaticMarkup(<HomeOverview />)

beforeEach(() => {
  state.projects = []
  state.importantMemos = []
})

describe('HomeOverview 중요 메모', () => {
  it('중요 메모가 있으면 제목과 본문을 보인다. 날짜는 ISO 가 아니다 (A53)', () => {
    state.importantMemos = [memo({ id: 1, content: '배포 동결 기간 확인' })]
    const html = render()
    expect(html).toContain('중요 메모')
    expect(html).toContain('배포 동결 기간 확인')
    expect(html).toContain('11/2 09:15')
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('중요 메모가 없으면 메모 영역을 그리지 않는다', () => {
    expect(render()).not.toContain('중요 메모')
  })
})

describe('HomeOverview 진행 중 프로젝트', () => {
  it('진행 중 상태만 정렬 순서대로 보인다. 완료·중단은 빠진다', () => {
    state.projects = [
      project({ id: 1, name: '나중 프로젝트', priority: 'later' }),
      project({ id: 2, name: '완료 프로젝트', status: 'completed' }),
      project({ id: 3, name: '지금 프로젝트', priority: 'now' }),
      project({ id: 4, name: '중단 프로젝트', status: 'on_hold' })
    ]
    const html = render()
    expect(html).toContain('진행 중 프로젝트')
    expect(html).toContain('지금 프로젝트')
    expect(html).toContain('나중 프로젝트')
    expect(html).not.toContain('완료 프로젝트')
    expect(html).not.toContain('중단 프로젝트')
    expect(html.indexOf('지금 프로젝트')).toBeLessThan(html.indexOf('나중 프로젝트'))
  })

  it('진행 중 프로젝트가 없으면 빈 안내를 보인다', () => {
    state.projects = [project({ id: 1, name: '완료 프로젝트', status: 'completed' })]
    const html = render()
    expect(html).toContain('진행 중인 프로젝트가 없어요.')
    expect(html).not.toContain('완료 프로젝트')
  })

  it('집중 카드와 TODO 패널이 없다 (D2)', () => {
    state.projects = [project({ id: 1, name: '지금 프로젝트' })]
    const html = render()
    expect(html).not.toContain('지금 할 일')
    expect(html).not.toContain('TODO')
    expect(html).not.toContain('다음:')
  })
})

describe('HomeOverview 우선순위 미지정 배지', () => {
  it('개발 중인데 우선순위가 없으면 건수를 배지로 보인다', () => {
    state.projects = [
      project({ id: 1, name: '미지정 A', priority: null }),
      project({ id: 2, name: '미지정 B', priority: null }),
      project({ id: 3, name: 'QA 미지정', priority: null, status: 'qa' }),
      project({ id: 4, name: '지정됨' })
    ]
    expect(render()).toContain('우선순위 미지정 2건')
  })

  it('모두 지정돼 있으면 배지가 없다', () => {
    state.projects = [project({ id: 1, name: '지정됨' })]
    expect(render()).not.toContain('우선순위 미지정')
  })
})

// 부록 M.11 Q1. 오늘 화면이 두 부분을 다른 자리에 그린다
describe('HomeProjects·HomeMemos 분리 (부록 M.11 Q1)', () => {
  it('HomeProjects 는 진행 중 프로젝트만 그린다. 메모가 있어도 메모를 그리지 않는다', () => {
    state.projects = [project({ id: 1, name: '지금 프로젝트' })]
    state.importantMemos = [memo({ id: 1, content: '배포 동결 기간 확인' })]
    const html = renderToStaticMarkup(<HomeProjects />)
    expect(html).toContain('id="home-projects"')
    expect(html).toContain('진행 중 프로젝트')
    expect(html).toContain('지금 프로젝트')
    expect(html).not.toContain('중요 메모')
    expect(html).not.toContain('배포 동결 기간 확인')
    expect(html).not.toContain('id="home-overview"')
  })

  it('HomeMemos 는 중요 메모만 그린다. 0건이면 아무것도 그리지 않는다', () => {
    state.projects = [project({ id: 1, name: '지금 프로젝트' })]
    state.importantMemos = [memo({ id: 1, content: '배포 동결 기간 확인' })]
    const html = renderToStaticMarkup(<HomeMemos />)
    expect(html).toContain('id="home-overview"')
    expect(html).toContain('배포 동결 기간 확인')
    expect(html).not.toContain('진행 중 프로젝트')
    expect(html).not.toContain('지금 프로젝트')
    state.importantMemos = []
    expect(renderToStaticMarkup(<HomeMemos />)).toBe('')
  })

  it('기본 HomeOverview 는 진행 중 프로젝트 → 중요 메모 순서로 그린다', () => {
    state.projects = [project({ id: 1, name: '지금 프로젝트' })]
    state.importantMemos = [memo({ id: 1, content: '배포 동결 기간 확인' })]
    const html = render()
    expect(html.indexOf('id="home-projects"')).toBeGreaterThan(-1)
    expect(html.indexOf('id="home-projects"')).toBeLessThan(html.indexOf('id="home-overview"'))
  })

  it('HomeProjects 는 메모 스토어를, HomeMemos 는 프로젝트 스토어를 읽지 않는다 (Q5)', () => {
    const src = readFileSync(resolve(__dirname, 'HomeOverview.tsx'), 'utf-8')
    const projects = src.slice(src.indexOf('export function HomeProjects'), src.indexOf('export function HomeMemos'))
    const memos = src.slice(src.indexOf('export function HomeMemos'), src.indexOf('export default function HomeOverview'))
    expect(projects).not.toContain('useMemoStore')
    expect(projects).not.toContain('fetchImportantMemos')
    expect(memos).not.toContain('useProjectStore')
    expect(memos).not.toContain('listByProjectIds')
  })
})
