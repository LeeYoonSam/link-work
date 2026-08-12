import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { addDays, format, startOfDay } from 'date-fns'
import ScheduleTimeline from './ScheduleTimeline'
import type { Project, Task } from '../../types'

// 간트 좌측 TASK 컬럼은 고정폭 + 1줄 말줄임이라 작업명 대부분이 잘려 읽을 수 없었다.
// 가변폭 + 2줄 라벨로 바꾸면서 (1) JS 절단이 없고 (2) 좌/중앙/우 3컬럼 행 정렬이
// 유지되는지, 그리고 (3) 그룹 경계 간격이 3컬럼에 동일하게 들어가는지를 렌더 결과로 확인한다.

const today = startOfDay(new Date())
const day = (offset: number): string => format(addDays(today, offset), 'yyyy-MM-dd')

const PROJECT: Project = {
  id: 1,
  name: '테스트 프로젝트',
  description: null,
  dev_start_date: day(-7),
  dev_end_date: day(3),
  qa_start_date: day(4),
  qa_end_date: day(7),
  deploy_date: day(10),
  deploy_version: 'v1.0.0',
  status: 'development',
  status_manual: 0,
  created_at: day(-14),
  updated_at: day(0)
}

const LONG_NAME = '[ICA-8636] 바이럴 작품 상세 잔여 Rx 제거 + UpdateFavoriteUseCase dual-track 신설'
const LONG_TITLE = '바이럴 작품 상세 잔여 Rx 제거 + UpdateFavoriteUseCase dual-track 신설'
const CHILD_NAME = '[ICA-9001] 하위 작업 상세 구현'
const CHILD_TITLE = '하위 작업 상세 구현'

const task = (over: Partial<Task> & Pick<Task, 'id' | 'name'>): Task => ({
  project_id: 1,
  parent_task_id: null,
  start_date: day(-5),
  end_date: day(-1),
  status: 'done',
  sort_order: over.id,
  created_at: day(-14),
  ...over
})

// 그룹 경계 규칙을 확인하려면 상위-하위 그룹이 2개 이상 필요하다.
// 그룹A(상위+하위2) / 그룹B(상위+하위1) / 그룹C(하위 없는 독립 상위) = 최상위 3개, 총 6행.
const TASKS: Task[] = [
  task({ id: 1, name: LONG_NAME, status: 'done', start_date: day(-6), end_date: day(-2) }),
  task({
    id: 2,
    name: CHILD_NAME,
    parent_task_id: 1,
    status: 'in_progress',
    start_date: day(-1),
    end_date: day(2)
  }),
  task({ id: 3, name: '[검색홈] 하위 두 번째 작업', parent_task_id: 1, status: 'pending' }),
  task({ id: 4, name: '[ICA-8633] 두 번째 그룹 상위 작업', status: 'in_progress' }),
  task({ id: 5, name: '두 번째 그룹의 하위 작업', parent_task_id: 4, status: 'pending' }),
  task({ id: 6, name: '하위 없는 독립 상위 작업', status: 'pending', start_date: day(5), end_date: day(5) })
]

const TOP_LEVEL = TASKS.filter((t) => t.parent_task_id == null).length
const CHILDREN = TASKS.length - TOP_LEVEL

const render = (variant: 'compact' | 'full'): string =>
  renderToStaticMarkup(<ScheduleTimeline project={PROJECT} tasks={TASKS} variant={variant} />)

// 3컬럼은 형제 div라 마커 문자열로 잘라 각 영역을 따로 검사한다.
const MIDDLE_MARK = 'flex-1 min-w-0 overflow-x-auto'
const RIGHT_MARK = 'w-[92px] shrink-0 pl-2'

const columns = (html: string): { left: string; middle: string; right: string } => {
  const m = html.indexOf(MIDDLE_MARK)
  const r = html.indexOf(RIGHT_MARK)
  expect(m).toBeGreaterThan(-1)
  expect(r).toBeGreaterThan(m)
  return { left: html.slice(0, m), middle: html.slice(m, r), right: html.slice(r) }
}

// 클래스 문자열에 [] . % 가 섞여 있어 정규식 대신 문자열 분할로 센다.
const countClass = (html: string, cls: string): number => html.split(`class="${cls}`).length - 1

// 각 컬럼의 "작업 행" 클래스 접두사 (뒤에 그룹 간격/들여쓰기가 더 붙을 수 있다)
const rowPrefix = {
  left: (rowH: string) => `${rowH} flex items-center`,
  middle: (rowH: string) => `relative grid ${rowH} items-center`,
  right: (rowH: string) => `${rowH} flex items-center justify-center`
}

// 각 컬럼의 작업 행 높이 클래스 (헤더 h-9 / 범례는 패턴이 달라 걸리지 않는다)
const rowHeights = (html: string): { left?: string; middle?: string; right?: string } => {
  const { left, middle, right } = columns(html)
  return {
    left: /class="(h-\d+) flex items-center/.exec(left)?.[1],
    middle: /class="relative grid (h-\d+) items-center/.exec(middle)?.[1],
    right: /class="(h-\d+) flex items-center justify-center/.exec(right)?.[1]
  }
}

describe.each([
  {
    variant: 'compact' as const,
    rowH: 'h-8',
    gap: 'mt-2',
    leading: 'leading-[14px]',
    oldRowH: 'h-7',
    oldWidth: 'w-32'
  },
  {
    variant: 'full' as const,
    rowH: 'h-9',
    gap: 'mt-2.5',
    leading: 'leading-[15px]',
    oldRowH: 'h-8',
    oldWidth: 'w-44'
  }
])('간트 좌측 작업명 컬럼 ($variant)', ({ variant, rowH, gap, leading, oldRowH, oldWidth }) => {
  it('작업명을 말줄임하지 않는다 (truncate 없음)', () => {
    const { left } = columns(render(variant))
    expect(left).not.toContain('truncate')
  })

  it('긴 작업명의 제목 전문이 DOM에 남는다 (JS 절단 없음)', () => {
    const html = render(variant)
    expect(html).toContain(LONG_TITLE)
    // 대괄호 접두사는 칩으로 분리되므로 키 자체도 함께 노출된다
    expect(html).toContain('ICA-8636')
  })

  it('좌/중앙/우 3컬럼이 같은 행 높이를 쓴다', () => {
    const heights = rowHeights(render(variant))
    expect(heights.left).toBe(rowH)
    expect(heights.middle).toBe(rowH)
    expect(heights.right).toBe(rowH)
  })

  it('옛 행 높이 클래스가 작업 행에 남아있지 않다', () => {
    const html = render(variant)
    expect(html).not.toContain(`class="${oldRowH} flex items-center`)
    expect(html).not.toContain(`class="relative grid ${oldRowH} items-center`)
    expect(html).not.toContain(`class="${oldRowH} flex items-center justify-center`)
  })

  it('TASK 컬럼이 고정폭이 아니다', () => {
    const { left } = columns(render(variant))
    expect(left).not.toContain(oldWidth)
    expect(left).toMatch(/basis-\[\d+%\]/)
    expect(left).toMatch(/min-w-\[[\d.]+rem\]/)
    expect(left).toMatch(/max-w-\[[\d.]+rem\]/)
  })

  it('컬럼 헤더는 자르지 않는다', () => {
    const { left, right } = columns(render(variant))
    expect(left).toContain('>Task</span>')
    expect(right).toContain('>Status</span>')
  })

  it('하위 작업을 ↳ 글리프와 함께 렌더하고 접두사도 분리한다', () => {
    const { left } = columns(render(variant))
    expect(left).toContain('↳')
    expect(left).toContain(CHILD_TITLE)
    expect(left).toContain('ICA-9001')
    // 하위 들여쓰기와 흐린 색 유지
    expect(left).toContain('pl-3')
    expect(left).toContain('text-gray-500')
  })

  it('상태 배지·Dev/QA 밴드·Deploy 마커가 그대로 렌더된다', () => {
    const html = render(variant)
    const { right } = columns(html)
    expect(right).toContain('Done')
    expect(right).toContain('In Progress')
    expect(right).toContain('Pending')
    expect(html).toContain('>Dev</div>')
    expect(html).toContain('>QA</div>')
    expect(html).toContain(`title="Deploy ${format(addDays(today, 10), 'MM/dd')}"`)
  })

  it('작업 행 수가 3컬럼 모두에서 작업 수와 일치한다', () => {
    const { left, middle, right } = columns(render(variant))
    expect(countClass(left, rowPrefix.left(rowH))).toBe(TASKS.length)
    expect(countClass(middle, rowPrefix.middle(rowH))).toBe(TASKS.length)
    expect(countClass(right, rowPrefix.right(rowH))).toBe(TASKS.length)
  })
})

describe.each([
  { variant: 'compact' as const, rowH: 'h-8', gap: 'mt-2' },
  { variant: 'full' as const, rowH: 'h-9', gap: 'mt-2.5' }
])('그룹 경계 간격 ($variant)', ({ variant, rowH, gap }) => {
  // 그룹 간격은 좌/중앙/우 어느 한 곳이라도 빠지면 간트 바가 작업명과 어긋난다.
  const gapClass = {
    left: `${rowPrefix.left(rowH)} ${gap}"`,
    middle: `${rowPrefix.middle(rowH)} ${gap}"`,
    right: `${rowPrefix.right(rowH)} ${gap}"`
  }

  it('3컬럼에 동일한 간격 클래스가 같은 횟수로 들어간다', () => {
    const { left, middle, right } = columns(render(variant))
    const counts = [
      countClass(left, gapClass.left),
      countClass(middle, gapClass.middle),
      countClass(right, gapClass.right)
    ]
    expect(counts[0]).toBe(counts[1])
    expect(counts[1]).toBe(counts[2])
    expect(counts[0]).toBeGreaterThan(0)
  })

  it('그룹 시작 행 수가 (최상위 작업 수 - 1)과 같다', () => {
    const { left, middle, right } = columns(render(variant))
    expect(countClass(left, gapClass.left)).toBe(TOP_LEVEL - 1)
    expect(countClass(middle, gapClass.middle)).toBe(TOP_LEVEL - 1)
    expect(countClass(right, gapClass.right)).toBe(TOP_LEVEL - 1)
  })

  it('첫 그룹 앞에는 간격이 붙지 않는다', () => {
    const { left, middle, right } = columns(render(variant))
    // 각 컬럼의 첫 작업 행은 간격 없는 정확한 클래스여야 한다
    const firstIs = (col: string, prefix: string): boolean =>
      col.slice(col.indexOf(`class="${prefix}`)).startsWith(`class="${prefix}"`)
    expect(firstIs(left, rowPrefix.left(rowH))).toBe(true)
    expect(firstIs(middle, rowPrefix.middle(rowH))).toBe(true)
    expect(firstIs(right, rowPrefix.right(rowH))).toBe(true)
  })

  it('하위 행에는 그룹 간격이 붙지 않는다 (상위-하위 간격 0 유지)', () => {
    const { left } = columns(render(variant))
    // 하위 행은 전부 "간격 없는 들여쓰기 행" 클래스로만 나온다
    expect(countClass(left, `${rowPrefix.left(rowH)} pl-3"`)).toBe(CHILDREN)
    expect(left).not.toContain(`${rowPrefix.left(rowH)} ${gap} pl-3`)
  })

  it('상위 라벨을 font-medium으로 강조하고 하위는 흐린 색을 유지한다', () => {
    const { left } = columns(render(variant))
    expect(left).toContain('font-medium text-gray-800')
    expect(left).not.toContain('font-medium text-gray-500')
  })
})

describe.each([
  { variant: 'compact' as const, leading: 'leading-[14px]', labelBox: 'h-7' },
  { variant: 'full' as const, leading: 'leading-[15px]', labelBox: 'h-[30px]' }
])('트리 글리프 정렬 ($variant)', ({ variant, leading, labelBox }) => {
  it('글리프와 라벨을 같은 상자에 묶어 첫 줄에 정렬한다', () => {
    const { left } = columns(render(variant))
    expect(left).toContain('min-w-0 flex-1 flex items-start')
    // 글리프도 라벨과 같은 line-height라야 첫 줄 baseline이 맞는다
    expect(left).toContain(`text-gray-400 ${leading}`)
  })

  // 픽스처가 전부 같은 줄 수면 아래 두 검증이 조용히 무의미해진다
  it('픽스처에 1줄 라벨과 2줄 라벨이 섞여 있다', () => {
    expect(TASKS.some((t) => t.name.length > 40)).toBe(true)
    expect(TASKS.some((t) => t.name.length < 20)).toBe(true)
  })

  // 1줄 라벨이 더 작은 상자를 쓰면 행마다 위아래 여백이 달라져
  // 간격이 관계 대신 글자 수를 반영하게 된다(그룹 내부가 경계만큼 벌어지는 역전).
  it('라벨 상자를 2줄 높이로 고정해 모든 행이 같은 여백을 쓴다', () => {
    const { left } = columns(render(variant))
    // 1줄·2줄 라벨이 섞인 픽스처인데도 모든 작업 행이 같은 상자 높이를 쓴다
    expect(countClass(left, `${labelBox} flex-1`)).toBe(TASKS.length)
  })

  it('고정 상자가 글리프+라벨 묶음을 감싸 중앙 정렬한다', () => {
    const { left } = columns(render(variant))
    // 바깥 상자 items-center가 빠지면 1줄 라벨이 위로 치우쳐 간트 바와 어긋나고,
    // 안쪽 묶음 items-start가 빠지면 2줄 라벨에서 글리프가 두 줄 사이로 내려간다.
    // 둘의 중첩이 규칙이므로 클래스 존재가 아니라 감싸는 관계를 고정한다.
    expect(left).toContain(
      `class="${labelBox} flex-1 min-w-0 flex items-center"><div class="min-w-0 flex-1 flex items-start">`
    )
  })
})

describe('간트 렌더 기본 동작', () => {
  it('작업이 없으면 아무것도 렌더하지 않는다', () => {
    expect(renderToStaticMarkup(<ScheduleTimeline project={PROJECT} tasks={[]} />)).toBe('')
  })

  it('상위→하위 순으로 행을 배치한다', () => {
    const { left } = columns(render('full'))
    expect(left.indexOf(LONG_TITLE)).toBeLessThan(left.indexOf(CHILD_TITLE))
  })

  it('그룹 간격은 다음 그룹의 상위 행에만 붙는다', () => {
    const { left } = columns(render('full'))
    // 첫 그룹 상위(A)보다 뒤, 두 번째 그룹 상위(B) 바로 앞에 간격이 나타난다
    const firstGap = left.indexOf('h-9 flex items-center mt-2.5')
    expect(firstGap).toBeGreaterThan(left.indexOf(LONG_TITLE))
    expect(firstGap).toBeLessThan(left.indexOf('두 번째 그룹 상위 작업'))
  })
})
