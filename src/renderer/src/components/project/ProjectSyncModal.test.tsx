import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  ProjectSyncPlan,
  ProjectSyncPlanItem,
  ProjectSyncResult,
  ProjectSyncSkipped
} from '../../types'
import type { ProjectSyncPhase } from '../../stores/projectSyncStore'

// 싱크업 모달은 적용 전에 "무엇이 생기고 바뀌고 빠지는지"를 모두 보여줘야 한다.
// 특히 건너뛴 이슈를 감추면 "왜 프로젝트가 안 생겼지" 상태가 되므로 사유까지 고정한다.
//
// zustand v5는 서버 렌더(renderToStaticMarkup)에서 초기 상태만 돌려주므로
// 모달 렌더 테스트는 스토어 훅을 모킹한다 (ProjectList.test.tsx와 같은 방식).
// 스토어 동작(적용 후 목록 재조회 등)은 importActual로 실제 스토어를 따로 검증한다.
const state: {
  phase: ProjectSyncPhase
  plan: ProjectSyncPlan | null
  result: ProjectSyncResult | null
  error: string
  selectedKeys: string[]
  pendingForceKey: string | null
} = { phase: 'idle', plan: null, result: null, error: '', selectedKeys: [], pendingForceKey: null }

// 순수 헬퍼(isExistingItem·defaultSelectedKeys 등)는 실제 구현을 그대로 쓴다
vi.mock('../../stores/projectSyncStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/projectSyncStore')>()),
  useProjectSyncStore: () => ({
    ...state,
    preview: async () => {},
    toggle: () => {},
    confirmForce: () => {},
    cancelForce: () => {},
    setAllNew: () => {},
    apply: async () => {},
    reset: () => {}
  })
}))

const ProjectSyncModal = (await import('./ProjectSyncModal')).default
const { defaultSelectedKeys } = await import('../../stores/projectSyncStore')

const item = (over: Partial<ProjectSyncPlanItem> & Pick<ProjectSyncPlanItem, 'jiraKey'>) => ({
  summary: '알림센터 개편',
  kind: 'epic' as const,
  action: 'create' as const,
  projectId: null,
  projectName: '알림센터 개편',
  matchedBy: null,
  newTasks: 0,
  updatedTasks: 0,
  newDocuments: 0,
  forceChanges: 0,
  forceTasks: [],
  ...over
})

const plan = (over: Partial<ProjectSyncPlan>): ProjectSyncPlan => ({
  items: [],
  skipped: [],
  truncated: false,
  triggerCount: 3,
  fetchedAt: '2026-10-02T00:00:00.000Z',
  ...over
})

// selectedKeys를 주지 않으면 미리보기 직후의 기본 선택(새 프로젝트만)으로 그린다
const render = (over: Partial<typeof state>): string => {
  Object.assign(
    state,
    { phase: 'idle', plan: null, result: null, error: '', selectedKeys: [], pendingForceKey: null },
    { selectedKeys: over.plan ? defaultSelectedKeys(over.plan) : [] },
    over
  )
  return renderToStaticMarkup(<ProjectSyncModal onClose={() => {}} />)
}

// 항목 체크박스(aria-label="<키> 선택")의 태그만 뽑는다
const checkboxTag = (html: string, key: string): string | null =>
  html.match(new RegExp(`<input[^>]*aria-label="${key} 선택"[^>]*>`))?.[0] ?? null

const NEW_ITEM = item({ jiraKey: 'PROJ-1855', newTasks: 4, newDocuments: 2 })
const EXISTING_ITEM = item({
  jiraKey: 'PROJ-1889',
  summary: '결제 오류 수정',
  kind: 'sustain',
  action: 'update',
  projectId: 7,
  projectName: '[Sus] 결제 오류 수정',
  matchedBy: 'document_url',
  newTasks: 1,
  updatedTasks: 3,
  forceChanges: 4,
  forceTasks: [
    { before: '결제 버그 (PROJ-1)', after: '결제 오류 수정 (PROJ-1)' },
    { before: '로그 정리 (PROJ-2)', after: '로그 정리 (PROJ-2)' }
  ]
})
const UNCHANGED_ITEM = item({
  jiraKey: 'PROJ-2000',
  summary: '정산 개편',
  action: 'unchanged',
  projectId: 9,
  projectName: '정산 개편',
  matchedBy: 'jira_key'
})

// 적용 버튼(aria-label="싱크업 적용")의 여는 태그만 뽑는다
const applyButtonTag = (html: string): string | null =>
  html.match(/<button[^>]*aria-label="싱크업 적용"[^>]*>/)?.[0] ?? null

describe('ProjectSyncModal', () => {
  it('dialog 역할과 제목을 갖는다', () => {
    const html = render({ phase: 'loading' })
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Jira 싱크업')
    expect(html).toContain('불러오는 중')
  })

  it('미리보기는 새 프로젝트 / 이미 있는 프로젝트로 나눠 키·이름·건수를 보여준다', () => {
    const html = render({
      phase: 'preview',
      plan: plan({ items: [NEW_ITEM, EXISTING_ITEM, UNCHANGED_ITEM] })
    })
    expect(html).toContain('새 프로젝트')
    expect(html).toContain('이미 있는 프로젝트')
    expect(html).not.toContain('변경 없음')
    expect(html).toContain('PROJ-1855')
    expect(html).toContain('작업 추가 4')
    expect(html).toContain('문서 추가 2')
    expect(html).toContain('[Sus] 결제 오류 수정')
    // 기존 이름과 Jira 요약이 다르면 둘 다 보여 매칭을 확인할 수 있어야 한다
    expect(html).toContain('Jira: 결제 오류 수정')
    expect(html).toContain('작업 갱신 3')
    expect(html).toContain('문서 링크로 매칭')
    expect(html).toContain('Jira 키로 연결됨')
    expect(html).toContain('Sustain')
  })

  it('기본 선택 — 새 프로젝트는 선택, 기존 프로젝트는 해제 + 흐림 + 경고 문구', () => {
    const html = render({
      phase: 'preview',
      plan: plan({ items: [NEW_ITEM, EXISTING_ITEM, UNCHANGED_ITEM] })
    })
    expect(checkboxTag(html, 'PROJ-1855')).toContain('checked=""')
    expect(checkboxTag(html, 'PROJ-1889')).not.toContain('checked=""')
    expect(checkboxTag(html, 'PROJ-2000')).not.toContain('checked=""')
    // 기존 프로젝트 2건(update·unchanged 모두)에 경고가 붙는다
    expect(html.split('이미 추가된 프로젝트입니다').length - 1).toBe(2)
    expect(html).toContain('opacity-60')
    expect(html).toContain('적용 (선택 1건)')
    expect(applyButtonTag(html)).not.toContain('disabled=""')
    // 전체 선택은 새 프로젝트에만 있다
    expect(html).toContain('aria-label="새 프로젝트 전체 선택"')
    expect(html).not.toContain('덮어쓰기 선택')
  })

  it('확인을 거쳐 고른 기존 프로젝트는 강제 업데이트로 표시한다', () => {
    const html = render({
      phase: 'preview',
      plan: plan({ items: [NEW_ITEM, EXISTING_ITEM] }),
      selectedKeys: ['PROJ-1889']
    })
    expect(checkboxTag(html, 'PROJ-1855')).not.toContain('checked=""')
    expect(checkboxTag(html, 'PROJ-1889')).toContain('checked=""')
    expect(html).toContain('강제 업데이트')
    expect(html).toContain('적용 (선택 1건)')
  })

  it('기존 프로젝트를 켜려 하면 덮어쓰기 확인 팝업을 띄운다', () => {
    const html = render({
      phase: 'preview',
      plan: plan({ items: [NEW_ITEM, EXISTING_ITEM] }),
      pendingForceKey: 'PROJ-1889'
    })
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('기존 프로젝트 덮어쓰기')
    expect(html).toContain('Jira 내용으로 덮어씌워집니다')
    expect(html).toContain('바뀌는 것: 프로젝트 이름·설명, 연결된 작업의 이름·상태·마감일')
    expect(html).toContain('유지되는 것: 프로젝트 일정·우선순위, Jira에 없는 수동 작업·문서')
    expect(html).toContain('덮어써질 항목 4건')
    // 덮어써질 작업 목록 — 이름이 바뀌면 before → after, 같으면 before만(상태·마감일 변경)
    expect(html).toContain('덮어써질 작업 (2)')
    expect(html).toMatch(/결제 버그 \(PROJ-1\)<\/span> →\s*<span[^>]*>결제 오류 수정 \(PROJ-1\)/)
    expect(html).toContain('로그 정리 (PROJ-2) <span class="text-gray-400">(상태·마감일)</span>')
    expect(html.split('로그 정리 (PROJ-2)').length - 1).toBe(1)
    expect(html).toContain('max-h-40 overflow-auto')
    expect(html).toContain('덮어쓰기 선택')
    expect(html).toContain('취소')
  })

  it('덮어써질 항목이 0건이면 건수 문구는 생략한다', () => {
    const html = render({
      phase: 'preview',
      plan: plan({ items: [UNCHANGED_ITEM] }),
      pendingForceKey: 'PROJ-2000'
    })
    expect(html).toContain('role="alertdialog"')
    expect(html).not.toContain('덮어써질 항목')
    expect(html).not.toContain('덮어써질 작업')
  })

  it('triggerCount를 하위 작업 제외로 안내한다', () => {
    const html = render({ phase: 'preview', plan: plan({ triggerCount: 5, items: [NEW_ITEM] }) })
    expect(html).toContain('이슈 5건을 찾았습니다')
    expect(html).toContain('(하위 작업 제외)')
  })

  it('건너뛴 이슈는 사유별 라벨로 나열한다', () => {
    const skipped: ProjectSyncSkipped[] = [
      { jiraKey: 'PROJ-1054', summary: '안드로이드QA-2099', reason: 'qa', detail: null },
      { jiraKey: 'PROJ-100', summary: '에픽 없는 작업', reason: 'no_epic', detail: null },
      {
        jiraKey: 'PROJ-200',
        summary: '스크롤 버그',
        reason: 'tracked_in_project',
        detail: 'Sustain 26-10'
      }
    ]
    const html = render({ phase: 'preview', plan: plan({ skipped }) })
    expect(html).toContain('건너뜀 (3)')
    expect(html).toContain('QA 티켓 제외')
    expect(html).toContain('에픽 없음')
    expect(html).toContain('이미 &#x27;Sustain 26-10&#x27; 프로젝트에서 추적 중')
  })

  it('조회 상한에 걸리면 안내한다', () => {
    const html = render({ phase: 'preview', plan: plan({ truncated: true }) })
    expect(html).toContain(
      'Jira 조회 상한에 걸려 최근 이슈 일부만 가져왔습니다. 오래된 할 일 이슈는 목록에'
    )
    expect(html).not.toContain('이어서 확인')
  })

  it('선택이 0건이면 적용 버튼을 잠근다', () => {
    const html = render({
      phase: 'preview',
      plan: plan({ items: [NEW_ITEM] }),
      selectedKeys: []
    })
    expect(applyButtonTag(html)).toContain('disabled=""')
    expect(html).toContain('적용 (선택 0건)')
  })

  it('항목이 하나도 없을 때만 동기화할 변경이 없다고 알린다', () => {
    const html = render({ phase: 'preview', plan: plan({ items: [] }) })
    expect(html).toContain('동기화할 변경이 없습니다')
    expect(applyButtonTag(html)).toContain('disabled=""')
  })

  it('새 프로젝트 없이 기존 프로젝트만 있으면 덮어쓰기 선택을 안내한다', () => {
    const html = render({ phase: 'preview', plan: plan({ items: [UNCHANGED_ITEM] }) })
    expect(html).not.toContain('동기화할 변경이 없습니다')
    expect(html).toContain('새로 추가할 프로젝트가 없습니다')
    expect(applyButtonTag(html)).toContain('disabled=""')
  })

  it('적용 중에는 적용 버튼과 체크박스를 잠근다', () => {
    const html = render({
      phase: 'applying',
      plan: plan({ items: [item({ jiraKey: 'PROJ-1855', newTasks: 1 })] })
    })
    expect(checkboxTag(html, 'PROJ-1855')).toContain('disabled=""')
    expect(applyButtonTag(html)).toContain('disabled=""')
    expect(html).toContain('적용 중…')
  })

  it('적용 후 결과 요약을 보여준다', () => {
    const html = render({
      phase: 'done',
      result: {
        created: 2,
        updated: 1,
        unchanged: 3,
        tasksAdded: 7,
        tasksUpdated: 4,
        documentsAdded: 5,
        skipped: [{ jiraKey: 'PROJ-1054', summary: 'QA', reason: 'qa', detail: null }]
      }
    })
    expect(html).toContain('싱크업을 적용했습니다')
    for (const [label, n] of [
      ['프로젝트 생성', 2],
      ['프로젝트 업데이트', 1],
      ['작업 추가', 7],
      ['작업 갱신', 4],
      ['문서 추가', 5]
    ] as const) {
      expect(html).toMatch(new RegExp(`${label}</dt><dd[^>]*>${n}건`))
    }
    expect(html).toContain('QA 티켓 제외')
    // 결과 화면에는 다시 적용할 버튼이 없다
    expect(applyButtonTag(html)).toBeNull()
  })

  it('오류는 메시지를 그대로 보여주고 연동 설정으로 안내한다', () => {
    const html = render({
      phase: 'error',
      error: 'Jira가 연결되지 않았습니다. Jira 연동 설정에서 토큰을 등록하세요.'
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Jira가 연결되지 않았습니다. Jira 연동 설정에서 토큰을 등록하세요.')
    expect(html).toContain('Jira 연동 설정')
    expect(html).toContain('다시 시도')
  })
})

describe('projectSyncStore', () => {
  const projectList = vi.fn(async () => [])
  const preview = vi.fn()
  const apply = vi.fn()

  beforeEach(() => {
    projectList.mockClear()
    preview.mockReset()
    apply.mockReset()
    vi.stubGlobal('window', {
      api: { projectSync: { preview, apply }, project: { list: projectList } }
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const actual = async () =>
    (
      await vi.importActual<typeof import('../../stores/projectSyncStore')>(
        '../../stores/projectSyncStore'
      )
    ).useProjectSyncStore

  it('미리보기 성공 시 계획을 담고 preview 단계로 간다', async () => {
    const store = await actual()
    store.getState().reset()
    const p = plan({ items: [item({ jiraKey: 'PROJ-1' })] })
    preview.mockResolvedValue({ success: true, plan: p })
    await store.getState().preview()
    expect(store.getState().phase).toBe('preview')
    expect(store.getState().plan).toEqual(p)
  })

  // 미리보기를 거쳐 기본 선택이 잡힌 상태를 만든다
  const previewed = async (items: ProjectSyncPlanItem[]) => {
    const store = await actual()
    store.getState().reset()
    preview.mockResolvedValue({ success: true, plan: plan({ items }) })
    await store.getState().preview()
    return store
  }

  it('미리보기는 기본 선택을 새 프로젝트로 잡고, 다시 부르면 선택을 기본값으로 되돌린다', async () => {
    const store = await previewed([NEW_ITEM, EXISTING_ITEM])
    expect(store.getState().selectedKeys).toEqual(['PROJ-1855'])
    store.getState().toggle('PROJ-1855')
    store.getState().toggle('PROJ-1889')
    store.getState().confirmForce()
    expect(store.getState().selectedKeys).toEqual(['PROJ-1889'])
    await store.getState().preview()
    expect(store.getState().selectedKeys).toEqual(['PROJ-1855'])
    expect(store.getState().pendingForceKey).toBeNull()
  })

  it('기존 프로젝트를 켜면 확인 대기만 하고, 확인하면 선택된다', async () => {
    const store = await previewed([NEW_ITEM, EXISTING_ITEM])
    store.getState().toggle('PROJ-1889')
    expect(store.getState().pendingForceKey).toBe('PROJ-1889')
    expect(store.getState().selectedKeys).not.toContain('PROJ-1889')
    store.getState().confirmForce()
    expect(store.getState().pendingForceKey).toBeNull()
    expect(store.getState().selectedKeys).toContain('PROJ-1889')
    // 해제는 확인 없이 바로
    store.getState().toggle('PROJ-1889')
    expect(store.getState().pendingForceKey).toBeNull()
    expect(store.getState().selectedKeys).not.toContain('PROJ-1889')
  })

  it('확인을 취소하면 선택되지 않는다', async () => {
    const store = await previewed([NEW_ITEM, EXISTING_ITEM])
    store.getState().toggle('PROJ-1889')
    store.getState().cancelForce()
    expect(store.getState().pendingForceKey).toBeNull()
    expect(store.getState().selectedKeys).toEqual(['PROJ-1855'])
  })

  it('새 프로젝트는 확인 없이 바로 토글되고, 전체 선택은 기존 프로젝트를 건드리지 않는다', async () => {
    const other = item({ jiraKey: 'PROJ-1856' })
    const store = await previewed([NEW_ITEM, other, EXISTING_ITEM])
    store.getState().toggle('PROJ-1855')
    expect(store.getState().pendingForceKey).toBeNull()
    expect(store.getState().selectedKeys).toEqual(['PROJ-1856'])
    store.getState().setAllNew(false)
    expect(store.getState().selectedKeys).toEqual([])
    store.getState().toggle('PROJ-1889')
    store.getState().confirmForce()
    store.getState().setAllNew(true)
    expect([...store.getState().selectedKeys].sort()).toEqual(['PROJ-1855', 'PROJ-1856', 'PROJ-1889'])
    store.getState().setAllNew(false)
    expect(store.getState().selectedKeys).toEqual(['PROJ-1889'])
  })

  it('apply에는 선택한 항목만, 새 프로젝트는 force=false·기존 프로젝트는 force=true로, 미리보기 projectId와 함께 넘긴다', async () => {
    const store = await previewed([NEW_ITEM, item({ jiraKey: 'PROJ-1856' }), EXISTING_ITEM, UNCHANGED_ITEM])
    store.getState().toggle('PROJ-1856') // 새 프로젝트 하나 해제
    store.getState().toggle('PROJ-2000') // 기존(변경 없음) 하나 확인 후 선택
    store.getState().confirmForce()
    apply.mockResolvedValue({ success: false, error: 'x' })
    await store.getState().apply()
    expect(apply).toHaveBeenCalledWith([
      { jiraKey: 'PROJ-1855', force: false, projectId: null },
      { jiraKey: 'PROJ-2000', force: true, projectId: 9 }
    ])
  })

  it('선택이 0건이면 apply를 부르지 않는다', async () => {
    const store = await previewed([EXISTING_ITEM])
    await store.getState().apply()
    expect(apply).not.toHaveBeenCalled()
    expect(store.getState().phase).toBe('preview')
  })

  it('적용 성공 시 결과를 담고 프로젝트 목록을 다시 읽는다', async () => {
    const store = await actual()
    store.getState().reset()
    const result: ProjectSyncResult = {
      created: 1,
      updated: 0,
      unchanged: 0,
      tasksAdded: 2,
      tasksUpdated: 0,
      documentsAdded: 1,
      skipped: []
    }
    apply.mockResolvedValue({ success: true, result })
    await (await previewed([NEW_ITEM])).getState().apply()
    expect(store.getState().phase).toBe('done')
    expect(store.getState().result).toEqual(result)
    expect(projectList).toHaveBeenCalledTimes(1)
  })

  it('실패 응답은 error 메시지를 그대로 담고 목록은 건드리지 않는다', async () => {
    const store = await actual()
    store.getState().reset()
    apply.mockResolvedValue({ success: false, error: '기본 Jira 프로젝트를 먼저 선택하세요' })
    await (await previewed([NEW_ITEM])).getState().apply()
    expect(store.getState().phase).toBe('error')
    expect(store.getState().error).toBe('기본 Jira 프로젝트를 먼저 선택하세요')
    expect(projectList).not.toHaveBeenCalled()
  })
})
