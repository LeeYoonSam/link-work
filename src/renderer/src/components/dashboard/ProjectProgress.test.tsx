import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Project, Task } from '../../types'
import ProjectProgress, { SCHEDULE_TONE, TASK_PROGRESS_BAR, scheduleLevel, statusCardBg } from './ProjectProgress'

// 진행 중 프로젝트 카드 색 (부록 M.12). 카드는 요약 타일 바로 아래에 온다.
// 그래서 카드 색은 타일 4색(blue·green·purple·teal)을 쓰지 않는다.
// initialTasks 를 넘겨 window.api.task 호출을 피한다. 일정 막대는 오늘 날짜를 쓰므로 시각을 고정한다

const TILE_COLORS = /(bg|border|text)-(blue|green|purple|teal)-/

const project = (over: Partial<Project> = {}): Project => ({
  id: 1,
  name: '결제 개편',
  description: null,
  dev_start_date: '2026-11-01',
  dev_end_date: '2026-11-30',
  qa_start_date: '2026-12-01',
  qa_end_date: '2026-12-05',
  deploy_date: '2026-12-08',
  deploy_version: null,
  status: 'development',
  status_manual: 0,
  priority: 'now',
  sort_order: 0,
  created_at: '2026-11-01',
  updated_at: '2026-11-01',
  ...over
})

const task = (id: number, status: Task['status']): Task => ({
  id,
  project_id: 1,
  parent_task_id: null,
  name: `작업 ${id}`,
  start_date: null,
  end_date: null,
  status,
  sort_order: id,
  created_at: '2026-11-01'
})

const TASKS = [task(1, 'done'), task(2, 'pending')]

const render = (p: Project): string => renderToStaticMarkup(<ProjectProgress project={p} initialTasks={TASKS} />)

// 카드 바깥 div 의 class 값
const cardClass = (html: string): string => html.match(/^<div class="([^"]*)"/)?.[1] ?? ''

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-10T12:00:00'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ProjectProgress 카드 색 (부록 M.12)', () => {
  it('R2 development 카드는 lime, qa_pending 카드는 pink 다', () => {
    expect(cardClass(render(project({ status: 'development' })))).toContain('bg-lime-50 border-lime-300')
    expect(cardClass(render(project({ status: 'qa_pending' })))).toContain('bg-pink-50 border-pink-200')
  })

  it('R2 상태별 카드 색 표는 결정과 같고 활성 상태끼리 서로 다르다', () => {
    expect(statusCardBg).toMatchObject({
      scheduled: 'bg-slate-50 border-slate-200',
      development: 'bg-lime-50 border-lime-300',
      qa_pending: 'bg-pink-50 border-pink-200',
      qa: 'bg-orange-50 border-orange-200',
      deploy_pending: 'bg-fuchsia-50 border-fuchsia-200',
      deploy: 'bg-red-50 border-red-200',
      completed: 'bg-stone-50 border-stone-200'
    })
    const active = ['scheduled', 'development', 'qa_pending', 'qa', 'deploy_pending', 'deploy']
    expect(new Set(active.map((s) => statusCardBg[s])).size).toBe(active.length)
  })

  it('R1 모든 상태의 카드 바깥·진행률 막대·% 글자에 타일 4색이 없다', () => {
    for (const status of Object.keys(statusCardBg)) {
      expect(statusCardBg[status]).not.toMatch(TILE_COLORS)
      const html = render(project({ status: status as Project['status'] }))
      expect(cardClass(html)).not.toMatch(TILE_COLORS)
      // 진행률 막대 2개와 % 글자
      for (const m of html.matchAll(/class="(h-(?:2\.5|1\.5) rounded-full[^"]*)"/g)) expect(m[1]).not.toMatch(TILE_COLORS)
      for (const m of html.matchAll(/class="(text-2xl font-bold[^"]*)"/g)) expect(m[1]).not.toMatch(TILE_COLORS)
    }
    for (const tone of Object.values(SCHEDULE_TONE)) {
      expect(tone.bar).not.toMatch(TILE_COLORS)
      expect(tone.text).not.toMatch(TILE_COLORS)
    }
  })

  it('R3 일정 막대 색 단계는 lime → amber → red 다', () => {
    expect(scheduleLevel(0)).toBe('early')
    expect(scheduleLevel(33)).toBe('early')
    expect(scheduleLevel(34)).toBe('mid')
    expect(scheduleLevel(66)).toBe('mid')
    expect(scheduleLevel(67)).toBe('late')
    expect(SCHEDULE_TONE).toEqual({
      early: { bar: 'bg-lime-500', text: 'text-lime-700' },
      mid: { bar: 'bg-amber-500', text: 'text-amber-700' },
      late: { bar: 'bg-red-500', text: 'text-red-700' }
    })
  })

  it('R4 작업 완료율 막대는 slate 다', () => {
    expect(TASK_PROGRESS_BAR).toBe('bg-slate-400')
    const html = render(project())
    expect(html).toContain('h-2.5 rounded-full transition-all duration-500 bg-slate-400')
  })
})

// 진행률 기준 (부록 M.13). 큰 숫자·굵은 막대는 작업 완료율이다. 일정은 영업일 기준 얇은 막대다
describe('ProjectProgress 진행률 기준 (부록 M.13)', () => {
  // 11/10(화)~11/23(월) 은 영업일 10일이다. 11/11 은 2일째라 2/10 = 20% 다.
  // 달력일 기준이면 1/13 = 8% 다
  const DEV = { dev_start_date: '2026-11-10', dev_end_date: '2026-11-23' }

  // 상위 1건(하위 6건)은 집계하지 않는다. leaf 6건 중 4건 완료라 67% 다
  const leaf = (id: number, status: Task['status']): Task => ({ ...task(id, status), parent_task_id: 100 })
  const LEAF_TASKS = [
    { ...task(100, 'pending') },
    leaf(1, 'done'),
    leaf(2, 'done'),
    leaf(3, 'done'),
    leaf(4, 'done'),
    leaf(5, 'pending'),
    leaf(6, 'in_progress')
  ]

  const renderWith = (p: Project, tasks: Task[]): string =>
    renderToStaticMarkup(<ProjectProgress project={p} initialTasks={tasks} />)

  it('R1 큰 숫자는 leaf 작업 완료율 67% 이고 작업 완료 라벨이 붙는다', () => {
    vi.setSystemTime(new Date(2026, 10, 11, 12, 0))
    const html = renderWith(project(DEV), LEAF_TASKS)
    expect(html).toContain('<span class="text-2xl font-bold text-slate-800">67%</span>')
    expect(html).toContain('작업 완료')
    expect(html).toContain('작업 4/6 완료')
    expect(html).not.toContain('Tasks:')
  })

  it('R2 굵은 막대는 작업 완료율이다', () => {
    vi.setSystemTime(new Date(2026, 10, 11, 12, 0))
    const html = renderWith(project(DEV), LEAF_TASKS)
    expect(html).toContain('class="h-2.5 rounded-full transition-all duration-500 bg-slate-400" style="width:67%"')
  })

  it('R3 일정은 영업일 기준 20% 다. 달력일 기준 8% 는 나오지 않는다', () => {
    vi.setSystemTime(new Date(2026, 10, 11, 12, 0))
    const html = renderWith(project(DEV), LEAF_TASKS)
    expect(html).toContain('일정')
    expect(html).toContain('>20%</span>')
    expect(html).toContain('class="h-1.5 rounded-full transition-all duration-500 bg-lime-500" style="width:20%"')
    expect(html).not.toContain('8%')
    // PhaseHint 의 N/M일차와 같은 기준이다
    expect(html).toContain('2/10일차')
  })

  it('R3 일정 막대 색은 일정 % 단계를 따른다', () => {
    // 11/18(수) 은 7/10 = 70% 로 late 다
    vi.setSystemTime(new Date(2026, 10, 18, 12, 0))
    const html = renderWith(project(DEV), LEAF_TASKS)
    expect(html).toContain('class="h-1.5 rounded-full transition-all duration-500 bg-red-500" style="width:70%"')
  })

  it('R1 작업이 0건이면 큰 % 와 굵은 막대가 없다. 일정 막대는 보인다', () => {
    vi.setSystemTime(new Date(2026, 10, 11, 12, 0))
    const html = renderWith(project(DEV), [])
    expect(html).not.toContain('text-2xl')
    expect(html).not.toContain('작업 완료')
    expect(html).not.toContain('h-2.5')
    expect(html).toContain('No tasks')
    expect(html).toContain('>20%</span>')
  })

  it('R1 개발 기간이 끝나도 작업 % 는 보이고 일정 막대는 없다', () => {
    vi.setSystemTime(new Date(2026, 10, 25, 12, 0))
    const html = renderWith(project({ ...DEV, status: 'qa_pending' }), LEAF_TASKS)
    expect(html).toContain('<span class="text-2xl font-bold text-slate-800">67%</span>')
    expect(html).not.toContain('일정')
    expect(html).not.toContain('h-1.5')
  })

  it('R1 개발 시작 전이면 일정 막대가 없다', () => {
    vi.setSystemTime(new Date(2026, 10, 9, 12, 0))
    const html = renderWith(project({ ...DEV, status: 'scheduled' }), LEAF_TASKS)
    expect(html).not.toContain('h-1.5')
  })

  it('R6 오늘은 로컬 날짜다. 로컬 오전 8시에도 그날로 센다', () => {
    // 로컬 11/11 08:00 은 한국 시간이면 UTC 11/10 23:00 이다. UTC 날짜를 쓰면 1/10 = 10% 가 된다
    vi.setSystemTime(new Date(2026, 10, 11, 8, 0))
    const html = renderWith(project(DEV), LEAF_TASKS)
    expect(html).toContain('>20%</span>')
    expect(html).toContain('2/10일차')
  })

  it('R7 큰 숫자와 막대에 타일 4색이 없다', () => {
    vi.setSystemTime(new Date(2026, 10, 11, 12, 0))
    const html = renderWith(project(DEV), LEAF_TASKS)
    // 상태 배지는 공용 토큰이라 검사하지 않는다(M.12 R5)
    const marks = [...html.matchAll(/class="((?:h-(?:2\.5|1\.5) rounded-full|text-2xl font-bold)[^"]*)"/g)]
    expect(marks.length).toBe(3)
    for (const m of marks) expect(m[1]).not.toMatch(TILE_COLORS)
  })
})
