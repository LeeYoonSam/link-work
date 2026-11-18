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
  ...over
})

type Fn = ReturnType<typeof vi.fn>
let api: { jiraBoard: { fetch: Fn; summarizeEpic: Fn } }
let storage: Map<string, string>

const { useJiraBoardStore } = await import('./jiraBoardStore')
const { DEFAULT_FILTER, EMPTY_FILTER } = await import('../components/project/boardModel')

const initial = useJiraBoardStore.getState()

beforeEach(() => {
  api = {
    jiraBoard: {
      fetch: vi.fn(async () => ({ success: true, snapshot: snapshot() })),
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

describe('jiraBoardStore.load', () => {
  it('성공하면 스냅샷을 담고 오류를 지운다', async () => {
    useJiraBoardStore.setState({ error: '옛 오류', errorCode: null })
    await useJiraBoardStore.getState().load()
    const s = useJiraBoardStore.getState()
    expect(s.snapshot?.projectKey).toBe('PROJ')
    expect(s).toMatchObject({ loading: false, error: null, errorCode: null })
    expect(api.jiraBoard.fetch).toHaveBeenCalledWith(false)
  })

  it('강제 새로고침은 force=true 로 부른다', async () => {
    await useJiraBoardStore.getState().load(true)
    expect(api.jiraBoard.fetch).toHaveBeenCalledWith(true)
  })

  it('재조회 중에도 기존 스냅샷을 유지한다', async () => {
    const old = snapshot({ fetchedAt: 'old' })
    useJiraBoardStore.setState({ snapshot: old })
    let resolve!: (v: unknown) => void
    api.jiraBoard.fetch.mockImplementation(() => new Promise((r) => (resolve = r)))
    const p = useJiraBoardStore.getState().load(true)
    expect(useJiraBoardStore.getState()).toMatchObject({ loading: true, snapshot: old })
    resolve({ success: true, snapshot: snapshot({ fetchedAt: 'new' }) })
    await p
    expect(useJiraBoardStore.getState().snapshot?.fetchedAt).toBe('new')
  })

  it('일반 오류는 스냅샷을 남기고 메시지만 띄운다', async () => {
    useJiraBoardStore.setState({ snapshot: snapshot() })
    api.jiraBoard.fetch.mockResolvedValue({ success: false, error: '네트워크 오류' })
    await useJiraBoardStore.getState().load()
    const s = useJiraBoardStore.getState()
    expect(s.snapshot).not.toBeNull()
    expect(s).toMatchObject({ error: '네트워크 오류', errorCode: null, loading: false })
  })

  it('미연결·기본 프로젝트 없음은 코드를 남기고 옛 스냅샷을 지운다', async () => {
    useJiraBoardStore.setState({ snapshot: snapshot() })
    api.jiraBoard.fetch.mockResolvedValue({ success: false, error: '미연결', code: 'not_connected' })
    await useJiraBoardStore.getState().load()
    expect(useJiraBoardStore.getState()).toMatchObject({ snapshot: null, errorCode: 'not_connected' })

    api.jiraBoard.fetch.mockResolvedValue({ success: false, error: '없음', code: 'no_default_project' })
    await useJiraBoardStore.getState().load()
    expect(useJiraBoardStore.getState().errorCode).toBe('no_default_project')
  })

  it('예외가 나도 loading 을 풀고 메시지를 남긴다', async () => {
    api.jiraBoard.fetch.mockRejectedValue(new Error('IPC 끊김'))
    await useJiraBoardStore.getState().load()
    expect(useJiraBoardStore.getState()).toMatchObject({ loading: false, error: 'IPC 끊김' })
  })

  it('조회 중에 다시 부르면(강제가 아니면) 겹쳐 부르지 않는다', async () => {
    api.jiraBoard.fetch.mockImplementation(() => new Promise(() => {}))
    void useJiraBoardStore.getState().load()
    await useJiraBoardStore.getState().load()
    expect(api.jiraBoard.fetch).toHaveBeenCalledTimes(1)
  })

  it('늦게 끝난 옛 요청은 새 결과를 덮지 않는다', async () => {
    const resolvers: ((v: unknown) => void)[] = []
    api.jiraBoard.fetch.mockImplementation(() => new Promise((r) => resolvers.push(r)))
    const first = useJiraBoardStore.getState().load()
    const second = useJiraBoardStore.getState().load(true)
    resolvers[1]({ success: true, snapshot: snapshot({ fetchedAt: 'second' }) })
    await second
    resolvers[0]({ success: true, snapshot: snapshot({ fetchedAt: 'first' }) })
    await first
    expect(useJiraBoardStore.getState().snapshot?.fetchedAt).toBe('second')
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
