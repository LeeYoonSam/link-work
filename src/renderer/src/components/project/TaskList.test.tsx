import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '../../types'

// 작업 행 간격 규칙(docs: spacing-rule.md)이 TaskList에서 유지되는지 고정한다.
// 그룹 경계 여백·첫 그룹 예외·구분선 대비·상위 강조·하위 들여쓰기는 모두
// 눈으로만 확인되던 값이라, 누가 건드려도 조용히 통과하지 않도록 마크업으로 잠근다.
//
// TaskList는 zustand 스토어를 직접 구독하는데 zustand v5는 서버 렌더에서
// getServerSnapshot으로 초기 상태만 돌려준다. setState로는 주입되지 않아 훅을 모킹한다.
const mk = (id: number, name: string, parent: number | null = null): Task => ({
  id,
  project_id: 1,
  parent_task_id: parent,
  name,
  start_date: '2026-08-10',
  end_date: '2026-08-12',
  status: id % 3 === 0 ? 'done' : id % 3 === 1 ? 'in_progress' : 'pending',
  sort_order: id,
  created_at: ''
})

// 최상위 3개 + 하위 혼재 — 그룹 경계가 2곳 나와야 개수 검증이 의미를 갖는다.
const TASKS: Task[] = [
  mk(1, '[PROJ-1534] 상위A 스프린트 26-07'),
  mk(2, '[PROJ-1611] 하위A1 성능 측정용 Macrobenchmark 모듈 신설', 1),
  mk(3, '[PROJ-1634] 하위A2 자동 티켓 생성 검증', 1),
  mk(4, '[PROJ-1633] 상위B RxJava to Coroutine Phase1'),
  mk(5, '[PROJ-1635] 하위B1 랜딩페이지 화면 전환', 4),
  mk(6, '[PROJ-1636] 하위B2 작품 상세 잔여 Rx 제거', 4),
  mk(7, '[PROJ-1672] 상위C 스프린트 26-08'),
  mk(8, '[PROJ-1671] 하위C1 하단 네비게이션바 아이콘 변경', 7)
]

// 픽스처에서 파생한다 — 손으로 맞추는 목록이 늘면 갱신 누락으로 검증이 헐거워진다.
// 좌변(컴포넌트 출력)과 우변(픽스처 입력)이 갈리므로 동어반복이 아니다.
const short = (t: Task): string => t.name.split(' ')[1]
const isRoot = (t: Task): boolean => t.parent_task_id === null
const childrenOf = (root: Task): Task[] => TASKS.filter((t) => t.parent_task_id === root.id)

const ROOT_NAMES = TASKS.filter(isRoot).map(short)
const CHILD_NAMES = TASKS.filter((t) => !isRoot(t)).map(short)

// 상위 → 자기 하위 순으로 평탄화된 기대 결과.
// TASKS 배열 순서가 아니라 **부모-자식 관계**로 만들어야 순서 검증이 살아 있다.
const EXPECTED_ROWS = TASKS.filter(isRoot).flatMap((root) => [
  { name: short(root), indent: 'root' },
  ...childrenOf(root).map((c) => ({ name: short(c), indent: 'child' }))
])

// 포커스 렌더 검증에서만 작업·요청을 바꾼다. 기본 렌더는 원래 픽스처 그대로다.
let currentTasks: Task[] = TASKS
let focusRequest: { entity: 'task'; id: number; nonce: number } | null = null

vi.mock('../../stores/projectStore', () => ({
  useProjectStore: () => ({
    tasks: currentTasks,
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn()
  })
}))

// zustand v5 는 서버 렌더에서 setState 가 반영되지 않는다. 그래서 요청 훅을 모킹한다
vi.mock('../../stores/focusStore', () => ({
  useFocusRequest: () => focusRequest,
  useFocusStore: { getState: () => ({ consume: () => {} }) }
}))

const { FOCUS_RING_CLASS } = await import('../../hooks/useFocusFlash')
const { taskStatus } = await import('../ui')
const TaskList = (await import('./TaskList')).default
const html = renderToStaticMarkup(<TaskList projectId={1} />)

const classAttrs = (): string[] => [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1])

// 목록 바깥 컨테이너 — 그룹 사이 구분선을 소유한다
const container = (): string => {
  const found = classAttrs().filter((c) => c.includes('rounded-lg') && c.includes('overflow-hidden'))
  expect(found, '목록 컨테이너를 찾지 못했다').toHaveLength(1)
  return found[0]
}

// 그룹 래퍼 — 상위 1개와 그 하위 전부를 묶는다. 그룹 내부 구분선을 소유한다.
const groupWrappers = (): string[] =>
  classAttrs().filter((c) => c.includes('divide-y') && !c.includes('rounded-lg'))

// 작업 행 컨테이너를 문서 순서대로
const rowClasses = (): string[] => classAttrs().filter((c) => c.startsWith('group flex'))

// 라벨(TaskLabel) 렌더 결과. `flex-1 min-w-0` 래퍼 안에는 라벨 span 하나뿐이라
// 첫 </span></div>가 항상 끝이다. [1]=span의 className, [2]=칩+제목 내용.
const LABEL = /<div class="flex-1 min-w-0"><span class="([^"]*)">([\s\S]*?)<\/span><\/div>/g

const labelClassOf = (needle: string): string => {
  for (const m of html.matchAll(LABEL)) {
    if (m[2].includes(needle)) return m[1]
  }
  throw new Error(
    `라벨을 찾지 못했다: ${needle} — <div class="flex-1 min-w-0"><span> 구조가 바뀌었는지 확인`
  )
}

// 문서 순서대로 (작업 축약명, 들여쓰기) 쌍을 뽑는다.
// 행 클래스와 라벨은 각각 행마다 하나씩이라 순서대로 짝지으면 된다.
const renderedRows = (): { name: string; indent: string }[] => {
  const indents = rowClasses().map((c) =>
    /\bpl-9\b/.test(c) ? 'child' : /\bpl-3\b/.test(c) ? 'root' : 'unknown'
  )
  const names = [...html.matchAll(LABEL)].map(([, , inner]) => {
    const hit = TASKS.map(short).filter((n) => inner.includes(n))
    expect(hit, `라벨에서 작업을 특정하지 못했다: ${inner}`).toHaveLength(1)
    return hit[0]
  })
  expect(names, '행 수와 라벨 수가 어긋난다').toHaveLength(indents.length)
  return indents.map((indent, i) => ({ name: names[i], indent }))
}

describe('TaskList 그룹 경계 여백', () => {
  it('여백이 붙은 그룹은 최상위 작업 수보다 하나 적다', () => {
    const withMargin = groupWrappers().filter((c) => /\bmt-2\b/.test(c))
    expect(groupWrappers()).toHaveLength(ROOT_NAMES.length)
    expect(withMargin).toHaveLength(ROOT_NAMES.length - 1)
  })

  it('첫 그룹에는 여백이 붙지 않는다', () => {
    expect(groupWrappers()[0]).not.toMatch(/\bmt-2\b/)
    // 나머지는 전부 붙어야 한다 — 앞뒤가 뒤바뀌어도 잡히도록 함께 고정한다
    for (const cls of groupWrappers().slice(1)) expect(cls).toMatch(/\bmt-2\b/)
  })
})

describe('TaskList 구분선 대비', () => {
  it('그룹 경계선은 진하고 그룹 내부선은 옅다', () => {
    expect(container()).toContain('divide-gray-200')
    expect(container()).not.toContain('divide-gray-100')
    for (const cls of groupWrappers()) {
      expect(cls).toContain('divide-gray-100')
      expect(cls).not.toContain('divide-gray-200')
    }
  })
})

describe('TaskList 계층 표현', () => {
  it('상위 라벨만 굵고 하위 라벨은 굵지 않다', () => {
    for (const name of ROOT_NAMES) expect(labelClassOf(name)).toContain('font-medium')
    for (const name of CHILD_NAMES) expect(labelClassOf(name)).not.toContain('font-medium')
  })

  it('하위 행만 깊게 들여쓰고 상위 → 자기 하위 순으로 편다', () => {
    // 들여쓰기와 함께 "어느 작업이 어느 행에 왔는지"까지 비교해
    // 들여쓰기는 맞는데 순서가 뒤집히는 회귀도 잡는다
    expect(renderedRows()).toEqual(EXPECTED_ROWS)
  })
})

describe('TaskList 포커스', () => {
  // 행 컨테이너의 여는 태그를 id 로 찾는다
  const rowTag = (markup: string, id: string): string | undefined =>
    markup.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`))?.[0]

  const renderFocused = (request: typeof focusRequest): string => {
    currentTasks = [...TASKS, mk(9, '[PROJ-1700] 하위C2 포커스 대상', 7)]
    focusRequest = request
    try {
      return renderToStaticMarkup(<TaskList projectId={1} />)
    } finally {
      currentTasks = TASKS
      focusRequest = null
    }
  }

  it('모든 작업 행에 task-{id} DOM id 가 붙는다', () => {
    for (const t of TASKS) expect(rowTag(html, `task-${t.id}`)).toBeDefined()
  })

  it('요청이 없으면 어느 행도 강조하지 않는다', () => {
    expect(html).not.toContain(FOCUS_RING_CLASS)
  })

  it('요청한 작업 행만 강조한다', () => {
    const markup = renderFocused({ entity: 'task', id: 9, nonce: 1 })
    const tag = rowTag(markup, 'task-9')
    expect(tag, 'id="task-9" 행이 없다').toBeDefined()
    expect(tag).toContain(FOCUS_RING_CLASS)
    // 목록 컨테이너가 overflow-hidden 이라 링을 안쪽에 그려야 보인다
    expect(tag).toContain('ring-inset')
    expect(rowTag(markup, 'task-8')).not.toContain(FOCUS_RING_CLASS)
    expect(markup.split(FOCUS_RING_CLASS)).toHaveLength(2)
  })

  it('목록에 없는 작업을 요청하면 강조하지 않는다', () => {
    const markup = renderFocused({ entity: 'task', id: 999, nonce: 2 })
    expect(markup).not.toContain(FOCUS_RING_CLASS)
  })
})

// R12: Jira 연결 작업의 상태는 동기화가 Jira 값으로 덮는다. 그래서 UI 에서 바꿀 수 없어야 한다.
describe('R12 Jira 연결 작업 상태 잠금', () => {
  const render = (tasks: Task[]): string => {
    currentTasks = tasks
    try {
      return renderToStaticMarkup(<TaskList projectId={1} />)
    } finally {
      currentTasks = TASKS
    }
  }
  const linked: Task = { ...mk(1, '[ICA-9047] 연결 작업'), jira_issue_key: 'ICA-9047' }
  const manual: Task = { ...mk(2, '수동 작업'), jira_issue_key: null }

  it('R12 jira_issue_key 가 있는 작업은 select 없이 배지와 Jira 툴팁만 보인다', () => {
    const markup = render([linked])
    expect(markup).not.toContain('<select')
    expect(markup).toContain('title="Jira 상태를 따릅니다 (ICA-9047)"')
    // 배지는 드롭다운과 같은 색 토큰과 상태 라벨을 보여 준다
    const { badge, label } = taskStatus[linked.status]
    expect(markup).toMatch(new RegExp(`<span class="[^"]*${badge}[^"]*" title="Jira[^"]*">${label}</span>`))
  })

  it('R12 jira_issue_key 가 없는 작업은 상태 select 를 그대로 보인다', () => {
    const markup = render([manual])
    expect(markup).toContain('<select')
    expect(markup).not.toContain('Jira 상태를 따릅니다')
  })

  it('R12 섞여 있으면 수동 작업에만 select 가 붙는다', () => {
    const markup = render([linked, manual])
    expect(markup.split('<select')).toHaveLength(2)
    expect(markup.split('Jira 상태를 따릅니다')).toHaveLength(2)
  })
})
