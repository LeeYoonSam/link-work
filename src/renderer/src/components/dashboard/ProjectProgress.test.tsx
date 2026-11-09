import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Project, Task } from '../../types'
import ProjectProgress, { SCHEDULE_TONE, TASK_PROGRESS_BAR, scheduleLevel, statusCardBg } from './ProjectProgress'

// 진행 중 프로젝트 카드 색 (부록 M.12). 카드는 요약 타일 바로 아래에 온다.
// 그래서 카드 색은 타일 4색(blue·green·purple·teal)을 쓰지 않는다.
// initialTasks 를 넘겨 window.api.task 호출을 피한다. 일정 진행률은 오늘 날짜를 쓰므로 시각을 고정한다

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

  it('R3 일정 진행률은 단계별로 lime → amber → red 다. 막대와 % 글자가 같은 단계 색이다', () => {
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
    // 11/01~11/30 은 29일이다. 11/10 은 9/29=31%, 11/16 은 15/29=52%, 11/25 은 24/29=83% 다
    const cases: [string, string, string, string][] = [
      ['2026-11-10T12:00:00', '31%', 'bg-lime-500', 'text-lime-700'],
      ['2026-11-16T12:00:00', '52%', 'bg-amber-500', 'text-amber-700'],
      ['2026-11-25T12:00:00', '83%', 'bg-red-500', 'text-red-700']
    ]
    for (const [now, percent, bar, text] of cases) {
      vi.setSystemTime(new Date(now))
      const html = render(project())
      expect(html).toContain(`<span class="text-2xl font-bold ${text}">${percent}</span>`)
      expect(html).toContain(`h-2.5 rounded-full transition-all duration-500 ${bar}`)
    }
  })

  it('R4 작업 진행률 막대는 slate 다', () => {
    expect(TASK_PROGRESS_BAR).toBe('bg-slate-400')
    const html = render(project())
    expect(html).toContain('h-1.5 rounded-full transition-all duration-500 bg-slate-400')
    expect(html).toContain('Tasks: 1/2 done')
  })
})
