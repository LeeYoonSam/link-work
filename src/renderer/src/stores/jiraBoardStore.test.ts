import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { JiraBoardSnapshot } from '../types'

// 프로젝트 화면(Jira 계층 보드) 스토어의 상태 전이를 고정한다.
// window.api 를 가짜로 꽂고 실제 zustand 스토어를 돌린다 — 노드 환경에서 window 만 흉내 낸다.

const snapshot = (over: Partial<JiraBoardSnapshot> = {}): JiraBoardSnapshot => ({
  projectKey: 'PROJ',
  myAccountId: 'acc-me',
  issues: [],
  truncated: false,
  recentDoneDays: 14,
  fetchedAt: '2026-11-18T01:00:00.000Z',
  lastFullSyncAt: '2026-11-18T00:00:00.000Z',
  ...over
})

type Fn = ReturnType<typeof vi.fn>
const SYNC_INC = { mode: 'incremental', changed: 3 } as const

// 응답 시점을 테스트가 정하는 약속
function deferred<T = unknown>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
// 대기 중인 마이크로태스크를 흘려보낸다
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
let api: { jiraBoard: { cached: Fn; fetch: Fn; summarizeEpic: Fn } }
let storage: Map<string, string>

const { useJiraBoardStore } = await import('./jiraBoardStore')
const { DEFAULT_FILTER, EMPTY_FILTER, CLOSED_SECTION_ID, doneFoldId } = await import(
  '../components/project/boardModel'
)

const initial = useJiraBoardStore.getState()

beforeEach(() => {
  api = {
    jiraBoard: {
      cached: vi.fn(async () => ({ success: true, snapshot: null })),
      fetch: vi.fn(async () => ({ success: true, snapshot: snapshot(), sync: SYNC_INC })),
      summarizeEpic: vi.fn(async (epicKey: string) => ({
        success: true,
        summary: { epicKey, headline: '순항 중', bullets: ['a', 'b'], generatedAt: '2026-11-18T01:00:00Z' }
      }))
    }
  }
  storage = new Map()
  vi.stubGlobal('window', { api })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v)
  })
  useJiraBoardStore.setState(initial, true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('jiraBoardStore.load — 저장본 먼저, 이어서 auto 동기화', () => {
  it('저장본이 있으면 동기화 응답 전에 바로 올리고, 동기화 중임(loading)을 유지한다', async () => {
    api.jiraBoard.cached.mockResolvedValue({ success: true, snapshot: snapshot({ fetchedAt: 'cached' }) })
    const fetch = deferred()
    api.jiraBoard.fetch.mockReturnValue(fetch.promise)
    const p = useJiraBoardStore.getState().load()
    await flush()
    expect(useJiraBoardStore.getState()).toMatchObject({ loading: true })
    expect(useJiraBoardStore.getState().snapshot?.fetchedAt).toBe('cached')
    expect(api.jiraBoard.fetch).toHaveBeenCalledWith('auto')

    fetch.resolve({ success: true, snapshot: snapshot({ fetchedAt: 'synced' }), sync: SYNC_INC })
    await p
    const s = useJiraBoardStore.getState()
    expect(s.snapshot?.fetchedAt).toBe('synced')
    expect(s).toMatchObject({ loading: false, error: null, errorCode: null, lastSync: SYNC_INC })
  })

  it('저장본이 null 이면 첫 로딩 상태(snapshot null + loading)로 동기화를 기다린다', async () => {
    const fetch = deferred()
    api.jiraBoard.fetch.mockReturnValue(fetch.promise)
    const p = useJiraBoardStore.getState().load()
    await flush()
    expect(useJiraBoardStore.getState()).toMatchObject({ snapshot: null, loading: true })
    fetch.resolve({ success: true, snapshot: snapshot(), sync: { mode: 'full', changed: 40 } })
    await p
    expect(useJiraBoardStore.getState().snapshot).not.toBeNull()
  })

  it('저장본 조회가 미연결·기본 프로젝트 없음 code 를 주면 연결 안내로 가고 fetch 는 부르지 않는다', async () => {
    useJiraBoardStore.setState({ snapshot: snapshot() })
    api.jiraBoard.cached.mockResolvedValue({ success: false, error: '미연결', code: 'not_connected' })
    await useJiraBoardStore.getState().load()
    expect(useJiraBoardStore.getState()).toMatchObject({ snapshot: null, errorCode: 'not_connected', loading: false })
    api.jiraBoard.cached.mockResolvedValue({ success: false, error: '없음', code: 'no_default_project' })
    await useJiraBoardStore.getState().load()
    expect(useJiraBoardStore.getState().errorCode).toBe('no_default_project')
    expect(api.jiraBoard.fetch).not.toHaveBeenCalled()
  })

  it('저장본 읽기가 code 없이 실패하거나 던져도 동기화로 이어간다', async () => {
    api.jiraBoard.cached.mockResolvedValueOnce({ success: false, error: 'DB 오류' })
    await useJiraBoardStore.getState().load()
    expect(useJiraBoardStore.getState().snapshot).not.toBeNull()
    expect(useJiraBoardStore.getState().error).toBeNull()

    useJiraBoardStore.setState({ snapshot: null })
    api.jiraBoard.cached.mockRejectedValueOnce(new Error('IPC 끊김'))
    await useJiraBoardStore.getState().load()
    expect(useJiraBoardStore.getState().snapshot).not.toBeNull()
    expect(api.jiraBoard.fetch).toHaveBeenCalledTimes(2)
  })

  it('동기화가 실패해도 저장본은 남기고 오류만 띄운다', async () => {
    api.jiraBoard.cached.mockResolvedValue({ success: true, snapshot: snapshot({ fetchedAt: 'cached' }) })
    api.jiraBoard.fetch.mockResolvedValue({ success: false, error: '네트워크 오류' })
    await useJiraBoardStore.getState().load()
    const s = useJiraBoardStore.getState()
    expect(s.snapshot?.fetchedAt).toBe('cached')
    expect(s).toMatchObject({ error: '네트워크 오류', errorCode: null, loading: false })
  })

  it('동기화가 던져도 loading 을 풀고 저장본을 남긴다', async () => {
    api.jiraBoard.cached.mockResolvedValue({ success: true, snapshot: snapshot({ fetchedAt: 'cached' }) })
    api.jiraBoard.fetch.mockRejectedValue(new Error('IPC 끊김'))
    await useJiraBoardStore.getState().load()
    expect(useJiraBoardStore.getState()).toMatchObject({ loading: false, error: 'IPC 끊김' })
    expect(useJiraBoardStore.getState().snapshot?.fetchedAt).toBe('cached')
  })

  it('동기화가 미연결 code 를 주면 저장본을 지운다(다른 계정 데이터를 남기지 않는다)', async () => {
    api.jiraBoard.cached.mockResolvedValue({ success: true, snapshot: snapshot() })
    api.jiraBoard.fetch.mockResolvedValue({ success: false, error: '미연결', code: 'not_connected' })
    await useJiraBoardStore.getState().load()
    expect(useJiraBoardStore.getState()).toMatchObject({ snapshot: null, errorCode: 'not_connected' })
  })

  it('도는 중에 다시 load 하면(메뉴 재진입) 겹쳐 부르지 않는다', async () => {
    api.jiraBoard.fetch.mockImplementation(() => new Promise(() => {}))
    void useJiraBoardStore.getState().load()
    await flush()
    await useJiraBoardStore.getState().load()
    expect(api.jiraBoard.cached).toHaveBeenCalledTimes(1)
    expect(api.jiraBoard.fetch).toHaveBeenCalledTimes(1)
  })

  it('늦게 도착한 저장본 응답이 새로고침 결과를 덮지 않는다', async () => {
    const cached = deferred()
    api.jiraBoard.cached.mockReturnValue(cached.promise)
    const first = useJiraBoardStore.getState().load()
    await useJiraBoardStore.getState().sync('incremental')
    expect(useJiraBoardStore.getState().snapshot?.fetchedAt).toBe('2026-11-18T01:00:00.000Z')
    cached.resolve({ success: true, snapshot: snapshot({ fetchedAt: 'stale-cache' }) })
    await first
    expect(useJiraBoardStore.getState().snapshot?.fetchedAt).toBe('2026-11-18T01:00:00.000Z')
    // load 의 auto 동기화도 이어서 부르지 않는다
    expect(api.jiraBoard.fetch).toHaveBeenCalledTimes(1)
    expect(api.jiraBoard.fetch).toHaveBeenCalledWith('incremental')
  })

  it('늦게 끝난 옛 동기화는 새 동기화 결과를 덮지 않는다', async () => {
    const resolvers: ((v: unknown) => void)[] = []
    api.jiraBoard.fetch.mockImplementation(() => new Promise((r) => resolvers.push(r)))
    const first = useJiraBoardStore.getState().load()
    await flush()
    const second = useJiraBoardStore.getState().sync('full')
    resolvers[1]({ success: true, snapshot: snapshot({ fetchedAt: 'second' }), sync: { mode: 'full', changed: 9 } })
    await second
    resolvers[0]({ success: true, snapshot: snapshot({ fetchedAt: 'first' }), sync: SYNC_INC })
    await first
    expect(useJiraBoardStore.getState().snapshot?.fetchedAt).toBe('second')
    expect(useJiraBoardStore.getState().lastSync).toEqual({ mode: 'full', changed: 9 })
  })

  it('스냅샷이 바뀌어도 펼침·선택·필터는 그대로다', async () => {
    api.jiraBoard.cached.mockResolvedValue({ success: true, snapshot: snapshot({ fetchedAt: 'cached' }) })
    useJiraBoardStore.setState({
      expanded: { 'PROJ-1': false },
      selectedKey: 'PROJ-2',
      filter: { ...EMPTY_FILTER, query: '결제' }
    })
    await useJiraBoardStore.getState().load()
    const s = useJiraBoardStore.getState()
    expect(s.snapshot?.fetchedAt).not.toBe('cached')
    expect(s).toMatchObject({ expanded: { 'PROJ-1': false }, selectedKey: 'PROJ-2' })
    expect(s.filter.query).toBe('결제')
  })
})

describe('jiraBoardStore.sync — 새로고침·전체 다시 받기', () => {
  it('동기화 중에 전체 다시 받기를 고르면 전체가 끝날 때까지 loading 이고, 앞선 응답은 버린다', async () => {
    const first = deferred()
    const full = deferred()
    api.jiraBoard.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(full.promise)
    const p1 = useJiraBoardStore.getState().sync('incremental')
    const p2 = useJiraBoardStore.getState().sync('full')
    first.resolve({ success: true, snapshot: snapshot({ fetchedAt: 'inc' }), sync: SYNC_INC })
    await p1
    expect(useJiraBoardStore.getState().loading).toBe(true)
    expect(useJiraBoardStore.getState().lastSync).toBeNull()
    full.resolve({ success: true, snapshot: snapshot({ fetchedAt: 'full' }), sync: { mode: 'full', changed: 80 } })
    await p2
    expect(useJiraBoardStore.getState()).toMatchObject({
      loading: false,
      lastSync: { mode: 'full', changed: 80 },
      lastSyncRequested: 'full'
    })
  })

  it('새로고침은 incremental, 전체 다시 받기는 full 로 부르고 결과를 남긴다', async () => {
    await useJiraBoardStore.getState().sync('incremental')
    expect(api.jiraBoard.fetch).toHaveBeenLastCalledWith('incremental')
    expect(useJiraBoardStore.getState().lastSync).toEqual(SYNC_INC)
    api.jiraBoard.fetch.mockResolvedValue({ success: true, snapshot: snapshot(), sync: { mode: 'full', changed: 50 } })
    await useJiraBoardStore.getState().sync('full')
    expect(api.jiraBoard.fetch).toHaveBeenLastCalledWith('full')
    expect(useJiraBoardStore.getState().lastSync).toEqual({ mode: 'full', changed: 50 })
    expect(api.jiraBoard.cached).not.toHaveBeenCalled()
  })

  it('새로고침 중에는 스냅샷을 유지하고, 실패하면 오류만 띄운다', async () => {
    const old = snapshot({ fetchedAt: 'old' })
    useJiraBoardStore.setState({ snapshot: old })
    const fetch = deferred()
    api.jiraBoard.fetch.mockReturnValue(fetch.promise)
    const p = useJiraBoardStore.getState().sync('incremental')
    expect(useJiraBoardStore.getState()).toMatchObject({ loading: true, snapshot: old })
    fetch.resolve({ success: false, error: '시간 초과' })
    await p
    expect(useJiraBoardStore.getState()).toMatchObject({ loading: false, snapshot: old, error: '시간 초과' })
  })
})

describe('jiraBoardStore.revealIssue — 보드에서 보기', () => {
  const base = {
    summary: '제목',
    issueType: '작업',
    level: 'standard' as const,
    status: '진행 중',
    statusCategory: 'indeterminate' as const,
    inScope: true,
    priority: null,
    parentKey: null,
    parentSummary: null,
    assigneeAccountId: 'other',
    assigneeName: null,
    duedate: null,
    updated: '2026-11-10T00:00:00Z',
    resolvedAt: null,
    labels: [],
    excerpt: null,
    fixVersions: [],
    links: []
  }
  const ISSUES = [
    { ...base, key: 'PROJ-1', level: 'epic' as const, issueType: '에픽' },
    { ...base, key: 'PROJ-2', parentKey: 'PROJ-1' },
    { ...base, key: 'PROJ-3', parentKey: 'PROJ-2', level: 'subtask' as const },
    // 오래전 완료 잎
    { ...base, key: 'PROJ-4', parentKey: 'PROJ-1', statusCategory: 'done' as const, resolvedAt: '2020-01-01T00:00:00Z' },
    // 백로그 잎
    { ...base, key: 'PROJ-5', parentKey: 'PROJ-1', inScope: false, statusCategory: 'new' as const }
  ]
  beforeEach(() => {
    useJiraBoardStore.setState({ snapshot: snapshot({ issues: ISSUES, myAccountId: 'acc-me' }) })
  })

  it('이슈를 선택하고 조상을 펼친다', () => {
    useJiraBoardStore.setState({ expanded: { 'PROJ-1': false }, filter: { ...EMPTY_FILTER } })
    expect(useJiraBoardStore.getState().revealIssue('PROJ-3')).toBe(true)
    const s = useJiraBoardStore.getState()
    expect(s.selectedKey).toBe('PROJ-3')
    expect(s.expanded).toMatchObject({ 'PROJ-1': true, 'PROJ-2': true })
  })

  describe('닫힘 묶음', () => {
    // 최근 완료여야 트리에 남는다. reveal 은 실제 오늘 날짜로 판정한다
    const DONE = { statusCategory: 'done' as const, resolvedAt: new Date().toISOString() }
    const FOLD_ISSUES = [
      { ...base, key: 'PROJ-10', level: 'epic' as const, issueType: '에픽' },
      { ...base, key: 'PROJ-11', parentKey: 'PROJ-10' },
      { ...base, key: 'PROJ-12', parentKey: 'PROJ-10', ...DONE },
      { ...base, key: 'PROJ-13', parentKey: 'PROJ-10', ...DONE },
      { ...base, key: 'PROJ-20', level: 'epic' as const, issueType: '에픽', ...DONE },
      { ...base, key: 'PROJ-21', parentKey: 'PROJ-20', ...DONE }
    ]
    const FOLD = doneFoldId('PROJ-10')
    beforeEach(() => {
      useJiraBoardStore.setState({
        snapshot: snapshot({ issues: FOLD_ISSUES }),
        filter: { ...EMPTY_FILTER },
        expanded: { [FOLD]: false, [CLOSED_SECTION_ID]: false }
      })
    })

    it('묶음 속에 숨은 이슈면 감싼 묶음을 펼친다', () => {
      expect(useJiraBoardStore.getState().revealIssue('PROJ-12')).toBe(true)
      expect(useJiraBoardStore.getState().expanded).toMatchObject({ 'PROJ-10': true, [FOLD]: true })
    })

    it('닫힌 그룹 섹션 속 이슈면 섹션과 그룹을 펼친다', () => {
      expect(useJiraBoardStore.getState().revealIssue('PROJ-21')).toBe(true)
      expect(useJiraBoardStore.getState().expanded).toMatchObject({ 'PROJ-20': true, [CLOSED_SECTION_ID]: true })
    })

    it('이미 보이는 열린 이슈면 사용자가 접어 둔 묶음·섹션을 건드리지 않는다', () => {
      expect(useJiraBoardStore.getState().revealIssue('PROJ-11')).toBe(true)
      expect(useJiraBoardStore.getState().expanded).toEqual({
        'PROJ-10': true,
        [FOLD]: false,
        [CLOSED_SECTION_ID]: false
      })
    })

    it('묶음 상태가 저장된 적 없어도 열린 이슈 reveal 은 묶음 id 를 추가하지 않는다', () => {
      useJiraBoardStore.setState({ expanded: {} })
      useJiraBoardStore.getState().revealIssue('PROJ-11')
      expect(useJiraBoardStore.getState().expanded).toEqual({ 'PROJ-10': true })
    })
  })

  it('필터에 가려져 있으면 필터를 푼다(내 담당만·검색)', () => {
    useJiraBoardStore.setState({ filter: { ...DEFAULT_FILTER, query: '없는말' } })
    expect(useJiraBoardStore.getState().revealIssue('PROJ-2')).toBe(true)
    expect(useJiraBoardStore.getState().filter).toEqual(EMPTY_FILTER)
  })

  it('가리는 조건만 풀고, 무관한 조건은 남긴다', () => {
    // PROJ-2 는 남의 담당 + '작업' 유형. '내 담당만'만 가린다
    useJiraBoardStore.setState({ filter: { ...DEFAULT_FILTER, types: ['작업'] } })
    useJiraBoardStore.getState().revealIssue('PROJ-2')
    expect(useJiraBoardStore.getState().filter).toEqual({ ...DEFAULT_FILTER, types: ['작업'], mineOnly: false })
    expect(useJiraBoardStore.getState().revealNotice).toContain("'내 담당만'")
  })

  // 저장본을 읽는다
  const saved = (): Record<string, unknown> => JSON.parse(storage.get('linkwork.jiraBoard.prefs') ?? '{}')
  // '내 담당만'이 켜진 사용자 필터로 시작해 남의 담당 이슈를 reveal 한다
  const revealWithMineOn = (): void => {
    useJiraBoardStore.setState({ filter: { ...DEFAULT_FILTER }, savedFilter: { ...DEFAULT_FILTER } })
    expect(useJiraBoardStore.getState().revealIssue('PROJ-3')).toBe(true)
    expect(useJiraBoardStore.getState().filter.mineOnly).toBe(false)
  }

  it('reveal 은 화면용 필터만 바꾸고 저장본에는 펼침만 남긴다', () => {
    revealWithMineOn()
    expect(saved().mineOnly).toBe(true)
    expect(saved().expanded).toMatchObject({ 'PROJ-1': true, 'PROJ-2': true })
    expect(useJiraBoardStore.getState().savedFilter.mineOnly).toBe(true)
  })

  it('reveal 뒤 행을 펼쳐도 저장된 내 담당만은 true 그대로다', () => {
    revealWithMineOn()
    useJiraBoardStore.getState().setExpanded('PROJ-9', true)
    useJiraBoardStore.getState().setAllExpanded(['PROJ-1'], false)
    expect(saved()).toMatchObject({ mineOnly: true, expanded: { 'PROJ-9': true, 'PROJ-1': false } })
  })

  it('reveal 뒤 정렬을 바꿔도 저장된 내 담당만은 true 그대로다', () => {
    revealWithMineOn()
    useJiraBoardStore.getState().setSort('due')
    expect(saved()).toMatchObject({ mineOnly: true, sort: 'due' })
  })

  it('reveal 뒤 사용자가 완료 모두 숨김만 토글하면 그 키만 저장된다', () => {
    revealWithMineOn()
    useJiraBoardStore.getState().setFilter({ hideDone: true })
    expect(saved()).toMatchObject({ mineOnly: true, hideDone: true })
    // 화면은 reveal 이 푼 상태 그대로 + 토글
    expect(useJiraBoardStore.getState().filter).toMatchObject({ mineOnly: false, hideDone: true })
    // 사용자가 필터를 만지면 안내는 지운다
    expect(useJiraBoardStore.getState().revealNotice).toBeNull()
  })

  it('사용자가 내 담당만을 직접 끄면 그때 저장된다. 필터 지우기는 저장본도 초기화한다', () => {
    revealWithMineOn()
    useJiraBoardStore.getState().setFilter({ mineOnly: false })
    expect(saved().mineOnly).toBe(false)
    useJiraBoardStore.getState().setFilter({ mineOnly: true, hideDone: true })
    useJiraBoardStore.getState().clearFilter()
    expect(saved()).toMatchObject({ mineOnly: false, hideDone: false, showPastDone: false })
    expect(useJiraBoardStore.getState().savedFilter).toEqual(EMPTY_FILTER)
  })

  it('앱 재시작(스토어 재생성) 시 reveal 전의 저장본으로 복원된다', async () => {
    revealWithMineOn()
    useJiraBoardStore.getState().setExpanded('PROJ-9', true)
    vi.resetModules()
    const fresh = (await import('./jiraBoardStore')).useJiraBoardStore.getState()
    expect(fresh.filter).toMatchObject({ mineOnly: true, hideDone: false, query: '' })
    expect(fresh.savedFilter).toEqual(fresh.filter)
    expect(fresh.expanded).toMatchObject({ 'PROJ-1': true, 'PROJ-9': true })
  })

  it('필터를 바꾸지 않았으면 안내도 없다', () => {
    useJiraBoardStore.setState({ filter: { ...EMPTY_FILTER }, revealNotice: '옛 안내' })
    useJiraBoardStore.getState().revealIssue('PROJ-2')
    expect(useJiraBoardStore.getState().revealNotice).toBeNull()
  })

  it('보이는 이슈면 필터를 그대로 둔다', () => {
    const filter = { ...EMPTY_FILTER, hideDone: true }
    useJiraBoardStore.setState({ filter })
    useJiraBoardStore.getState().revealIssue('PROJ-2')
    expect(useJiraBoardStore.getState().filter).toEqual(filter)
  })

  it('이전 완료 잎이면 "이전 완료 보기"를 켜고 완료 모두 숨김을 끈다', () => {
    useJiraBoardStore.setState({ filter: { ...EMPTY_FILTER, hideDone: true } })
    expect(useJiraBoardStore.getState().revealIssue('PROJ-4')).toBe(true)
    expect(useJiraBoardStore.getState().filter).toMatchObject({ showPastDone: true, hideDone: false })
    expect(useJiraBoardStore.getState().revealNotice).toContain("'이전 완료 보기'를 켰어요")
    expect(useJiraBoardStore.getState().selectedKey).toBe('PROJ-4')
  })

  it('스냅샷에 없거나 트리에 그려질 수 없는 이슈(백로그 잎)는 false 이고 상태를 바꾸지 않는다', () => {
    useJiraBoardStore.setState({ selectedKey: 'PROJ-2' })
    expect(useJiraBoardStore.getState().revealIssue('NOPE-1')).toBe(false)
    expect(useJiraBoardStore.getState().revealIssue('PROJ-5')).toBe(false)
    expect(useJiraBoardStore.getState().selectedKey).toBe('PROJ-2')
    useJiraBoardStore.setState({ snapshot: null })
    expect(useJiraBoardStore.getState().revealIssue('PROJ-2')).toBe(false)
  })
})

describe('jiraBoardStore.setDocsFilter', () => {
  it('문서 탭 필터를 부분 갱신한다', () => {
    useJiraBoardStore.getState().setDocsFilter({ query: 'PROJ-1' })
    useJiraBoardStore.getState().setDocsFilter({ kinds: ['web'] })
    expect(useJiraBoardStore.getState().docsFilter).toEqual({ query: 'PROJ-1', kinds: ['web'], sources: [] })
  })
})

describe('jiraBoardStore.summarizeEpic', () => {
  it('성공하면 에픽 키로 요약을 담는다', async () => {
    await useJiraBoardStore.getState().summarizeEpic('PROJ-1')
    const s = useJiraBoardStore.getState()
    expect(s.aiSummaries['PROJ-1'].headline).toBe('순항 중')
    expect(s.aiLoading['PROJ-1']).toBeUndefined()
  })

  it('실패하면 에픽별 오류를 남기고, 다시 누르면 오류를 지운다', async () => {
    api.jiraBoard.summarizeEpic.mockResolvedValueOnce({ success: false, error: 'AI 실패' })
    await useJiraBoardStore.getState().summarizeEpic('PROJ-1')
    expect(useJiraBoardStore.getState().aiErrors['PROJ-1']).toBe('AI 실패')
    await useJiraBoardStore.getState().summarizeEpic('PROJ-1')
    expect(useJiraBoardStore.getState().aiErrors['PROJ-1']).toBeUndefined()
  })

  it('같은 에픽을 생성 중이면 겹쳐 부르지 않는다', async () => {
    api.jiraBoard.summarizeEpic.mockImplementation(() => new Promise(() => {}))
    void useJiraBoardStore.getState().summarizeEpic('PROJ-1')
    await useJiraBoardStore.getState().summarizeEpic('PROJ-1')
    expect(api.jiraBoard.summarizeEpic).toHaveBeenCalledTimes(1)
  })
})

describe('jiraBoardStore 필터·펼침·선택', () => {
  it('기본 필터는 내 담당만 켜짐', () => {
    expect(DEFAULT_FILTER.mineOnly).toBe(true)
  })

  it('setFilter 는 부분 갱신, clearFilter 는 내 담당만까지 끈다', () => {
    useJiraBoardStore.getState().setFilter({ query: '결제', hideDone: true })
    expect(useJiraBoardStore.getState().filter).toMatchObject({ query: '결제', hideDone: true })
    useJiraBoardStore.getState().clearFilter()
    expect(useJiraBoardStore.getState().filter).toEqual(EMPTY_FILTER)
  })

  it('펼침 상태와 토글·정렬을 localStorage 에 남긴다(검색어는 남기지 않는다)', () => {
    const st = useJiraBoardStore.getState()
    st.setExpanded('PROJ-1', false)
    st.setAllExpanded(['PROJ-2', 'PROJ-3'], true)
    st.setSort('due')
    st.setFilter({ query: '비밀', hideDone: true })
    const saved = JSON.parse(storage.get('linkwork.jiraBoard.prefs') ?? '{}')
    expect(saved).toEqual({
      mineOnly: DEFAULT_FILTER.mineOnly,
      hideDone: true,
      showPastDone: false,
      sort: 'due',
      expanded: { 'PROJ-1': false, 'PROJ-2': true, 'PROJ-3': true }
    })
  })

  it('localStorage 가 던져도 상태는 바뀐다', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    })
    useJiraBoardStore.getState().setSort('key')
    expect(useJiraBoardStore.getState().sort).toBe('key')
  })

  it('select 는 상세 패널 대상을 바꾼다', () => {
    useJiraBoardStore.getState().select('PROJ-7')
    expect(useJiraBoardStore.getState().selectedKey).toBe('PROJ-7')
    useJiraBoardStore.getState().select(null)
    expect(useJiraBoardStore.getState().selectedKey).toBeNull()
  })
})
