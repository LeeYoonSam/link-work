import { describe, it, expect, vi } from 'vitest'
import type { Memo, MemoCategory, Todo } from '../types'
import { MobileApiError } from './api'
import {
  DRAFT_STORAGE_KEY,
  acceptTodosResponse,
  buildMemoBody,
  createRequestGate,
  readDraft,
  writeDraft,
  connectionAfterError,
  connectionAfterSuccess,
  dueLabel,
  parseTabHash,
  publishedAgo,
  removeOptimistically,
  sortActiveTodos,
  sortCompletedTodos,
  visibleMemos
} from './mobileModel'

const todo = (over: Partial<Todo> & Pick<Todo, 'id'>): Todo => ({
  title: `할 일 ${over.id}`,
  priority: 'medium',
  due_date: null,
  due_reminder: 0,
  is_completed: 0,
  completed_at: null,
  notes: null,
  created_at: '2026-11-01 00:00:00',
  updated_at: '2026-11-01 00:00:00',
  ...over
})

const memo = (over: Partial<Memo> & Pick<Memo, 'id'>): Memo => ({
  content: `메모 ${over.id}`,
  is_archived: 0,
  is_important: 0,
  color: '',
  category_id: null,
  created_at: '2026-11-01 00:00:00',
  updated_at: '2026-11-01 00:00:00',
  ...over
})

const cat = (id: number, name: string): MemoCategory => ({
  id,
  name,
  color: '#3b82f6',
  sort_order: id,
  created_at: '',
  updated_at: ''
})

describe('탭·연결 상태', () => {
  it('hash 를 탭으로 읽는다', () => {
    expect(parseTabHash('#todos')).toBe('todos')
    expect(parseTabHash('#memos')).toBe('memos')
    expect(parseTabHash('')).toBe('today')
    expect(parseTabHash('#nope')).toBe('today')
  })

  it('401 은 만료, 네트워크는 오프라인, http 는 그대로', () => {
    expect(connectionAfterError('online', new MobileApiError('auth', 'x', 401))).toBe('expired')
    expect(connectionAfterError('online', new MobileApiError('network', 'x'))).toBe('offline')
    expect(connectionAfterError('offline', new MobileApiError('http', 'x', 500))).toBe('offline')
    expect(connectionAfterSuccess('offline')).toBe('online')
    // 만료는 성공·다른 오류로 풀리지 않는다
    expect(connectionAfterSuccess('expired')).toBe('expired')
    expect(connectionAfterError('expired', new MobileApiError('network', 'x'))).toBe('expired')
  })
})

describe('publishedAgo', () => {
  const now = new Date('2026-11-19T03:10:00Z')
  it('5분 이내면 경고가 아니다', () => {
    expect(publishedAgo('2026-11-19T03:09:30Z', now)).toEqual({ text: 'Mac 에서 방금 갱신', stale: false })
    expect(publishedAgo('2026-11-19T03:06:00Z', now)).toEqual({ text: 'Mac 에서 4분 전 갱신', stale: false })
  })
  it('5분 넘게 지나면 오래됨', () => {
    expect(publishedAgo('2026-11-19T03:04:00Z', now)).toEqual({ text: 'Mac 에서 6분 전 갱신', stale: true })
    expect(publishedAgo('2026-11-19T01:00:00Z', now).text).toBe('Mac 에서 2시간 전 갱신')
    expect(publishedAgo('잘못된 값', now).stale).toBe(true)
  })
})

describe('할 일', () => {
  it('마감 문구는 데스크톱과 같다', () => {
    expect(dueLabel('2026-11-17', '2026-11-19')).toEqual({ text: '11/17 지남', bucket: 'overdue' })
    expect(dueLabel('2026-11-19 09:00:00', '2026-11-19')).toEqual({ text: '오늘', bucket: 'today' })
    expect(dueLabel('2026-11-24', '2026-11-19')).toEqual({ text: '11/24', bucket: 'later' })
    expect(dueLabel(null, '2026-11-19')).toBeNull()
  })

  it('진행 중은 마감 이른 순·마감 없음 끝, 완료는 최근 완료 순', () => {
    const active = sortActiveTodos([
      todo({ id: 1 }),
      todo({ id: 2, due_date: '2026-11-25' }),
      todo({ id: 3, due_date: '2026-11-10', priority: 'low' }),
      todo({ id: 4, due_date: '2026-11-10', priority: 'high' })
    ])
    expect(active.map((t) => t.id)).toEqual([4, 3, 2, 1])
    const done = sortCompletedTodos([
      todo({ id: 1, completed_at: '2026-11-18 01:00:00' }),
      todo({ id: 2, completed_at: '2026-11-19 01:00:00' })
    ])
    expect(done.map((t) => t.id)).toEqual([2, 1])
  })

  it('removeOptimistically: 실패하면 항목이 원래 자리로 돌아오고 onError 가 불린다', async () => {
    let items = [todo({ id: 1 }), todo({ id: 2 }), todo({ id: 3 })]
    const setItems = (fn: (cur: Todo[]) => Todo[]): void => {
      items = fn(items)
    }
    let resolveCall: (v: unknown) => void = () => {}
    let rejectCall: (e: unknown) => void = () => {}
    const call = vi.fn(
      () =>
        new Promise((res, rej) => {
          resolveCall = res
          rejectCall = rej
        })
    )
    const onError = vi.fn()
    const p = removeOptimistically({ id: 2, items, setItems, call, onError })
    // 응답 전에 이미 빠져 있다(낙관적 갱신)
    expect(items.map((t) => t.id)).toEqual([1, 3])
    expect(call).toHaveBeenCalledWith(2)
    rejectCall(new MobileApiError('http', '실패', 500))
    expect(await p).toBe(false)
    expect(items.map((t) => t.id)).toEqual([1, 2, 3])
    expect(onError).toHaveBeenCalledTimes(1)
    void resolveCall
  })

  it('removeOptimistically: 성공하면 빠진 채로 남는다', async () => {
    let items = [todo({ id: 1 }), todo({ id: 2 })]
    const ok = await removeOptimistically({
      id: 1,
      items,
      setItems: (fn) => {
        items = fn(items)
      },
      call: async () => ({ success: true }),
      onError: () => {}
    })
    expect(ok).toBe(true)
    expect(items.map((t) => t.id)).toEqual([2])
  })
})

describe('메모', () => {
  const categories = [cat(1, '업무'), cat(2, '개인')]
  const memos = [
    memo({ id: 1, content: '# 배포 회의\n릴리스 체크리스트 정리', category_id: 1, updated_at: '2026-11-18 00:00:00' }),
    memo({ id: 2, content: '장보기 목록\n우유, 계란', category_id: 2, is_important: 1, updated_at: '2026-11-19 00:00:00' }),
    memo({ id: 3, content: '아이디어\n본문 깊숙이 체크리스트 라는 말', updated_at: '2026-11-17 00:00:00' })
  ]

  it('필터: 전체(최근 수정순)·중요·카테고리', () => {
    expect(visibleMemos(memos, categories, 'all', '').map((i) => i.memo.id)).toEqual([2, 1, 3])
    expect(visibleMemos(memos, categories, 'important', '').map((i) => i.memo.id)).toEqual([2])
    expect(visibleMemos(memos, categories, 1, '').map((i) => i.memo.id)).toEqual([1])
  })

  it('검색은 본문까지 보고, 필터와 함께 걸린다', () => {
    expect(visibleMemos(memos, categories, 'all', '체크리스트').map((i) => i.memo.id).sort()).toEqual([1, 3])
    expect(visibleMemos(memos, categories, 1, '체크리스트').map((i) => i.memo.id)).toEqual([1])
    expect(visibleMemos(memos, categories, 'all', '계란').map((i) => i.memo.id)).toEqual([2])
    expect(visibleMemos(memos, categories, 'all', '없는말')).toEqual([])
  })

  it('작성 본문 형식', () => {
    expect(buildMemoBody({ content: '  ', categoryId: null, important: false })).toEqual({ ok: false, error: '내용을 입력하세요' })
    expect(buildMemoBody({ content: '새 메모', categoryId: 2, important: true })).toEqual({
      ok: true,
      body: { content: '새 메모', category_id: 2, is_important: 1 }
    })
    expect(buildMemoBody({ content: '새 메모', categoryId: null, important: false })).toEqual({
      ok: true,
      body: { content: '새 메모', category_id: null, is_important: 0 }
    })
    expect(buildMemoBody({ content: 'x'.repeat(20001), categoryId: null, important: false }).ok).toBe(false)
  })
})

describe('요청 순번(응답 경쟁)', () => {
  it('마지막으로 시작한 요청만 적용하고 invalidate 는 진행 중 응답을 모두 버린다', () => {
    const gate = createRequestGate()
    const a = gate.begin()
    const b = gate.begin()
    expect(gate.isLatest(a)).toBe(false)
    expect(gate.isLatest(b)).toBe(true)
    gate.invalidate()
    expect(gate.isLatest(b)).toBe(false)
  })

  it("'진행 중' 응답이 '완료 보기' 로 바꾼 뒤 도착하면 버린다", () => {
    const gate = createRequestGate()
    // 진행 중 목록 요청
    const active = gate.begin()
    // 사용자가 완료 보기로 전환 → 옛 응답 무효 + 완료 목록 요청
    gate.invalidate()
    const done = gate.begin()
    // 느린 Wi-Fi: 진행 중 응답이 나중에 도착
    expect(acceptTodosResponse(gate, active, false, true)).toBe(false)
    expect(acceptTodosResponse(gate, done, true, true)).toBe(true)
  })

  it('순번이 최신이어도 요청한 목록 종류가 지금 보는 종류와 다르면 버린다', () => {
    const gate = createRequestGate()
    const seq = gate.begin()
    expect(acceptTodosResponse(gate, seq, false, true)).toBe(false)
    expect(acceptTodosResponse(gate, seq, false, false)).toBe(true)
  })
})

describe('메모 초안 보관', () => {
  const memStorage = (): Storage & { data: Map<string, string> } => {
    const data = new Map<string, string>()
    return {
      data,
      get length() {
        return data.size
      },
      clear: () => data.clear(),
      key: () => null,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k)
    }
  }

  it('쓰고 읽고, null 이면 지운다', () => {
    const s = memStorage()
    writeDraft(s, { content: '작성 중', categoryId: 3, important: true })
    expect(readDraft(s)).toEqual({ content: '작성 중', categoryId: 3, important: true })
    writeDraft(s, null)
    expect(s.data.has(DRAFT_STORAGE_KEY)).toBe(false)
    expect(readDraft(s)).toBeNull()
  })

  it('모양이 틀린 값은 버리고, 저장소 오류는 삼킨다', () => {
    const s = memStorage()
    s.setItem(DRAFT_STORAGE_KEY, '{망가진')
    expect(readDraft(s)).toBeNull()
    s.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ content: 1 }))
    expect(readDraft(s)).toBeNull()
    s.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ content: 'x', categoryId: 'a', important: 'yes' }))
    expect(readDraft(s)).toEqual({ content: 'x', categoryId: null, important: false })
    const broken = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      }
    }
    expect(readDraft(broken)).toBeNull()
    expect(() => writeDraft(broken, { content: 'x', categoryId: null, important: false })).not.toThrow()
    expect(readDraft(null)).toBeNull()
  })
})
