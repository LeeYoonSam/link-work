import { describe, it, expect, vi } from 'vitest'
import { createMobileApi, MobileApiError, MOBILE_HEADER, errorText, type FetchLike, type ResponseLike } from './api'

const res = (status: number, body: unknown): ResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
})

describe('createMobileApi', () => {
  it('401 이면 인증 만료(auth) 오류다', async () => {
    const api = createMobileApi(async () => res(401, { error: 'unauthorized' }))
    const err = await api.getToday().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MobileApiError)
    expect((err as MobileApiError).kind).toBe('auth')
    expect((err as MobileApiError).status).toBe(401)
  })

  it('fetch 가 reject 되면 네트워크(network) 오류다', async () => {
    const api = createMobileApi(async () => {
      throw new TypeError('Failed to fetch')
    })
    const err = await api.getTodos(false).catch((e: unknown) => e)
    expect((err as MobileApiError).kind).toBe('network')
    expect((err as MobileApiError).status).toBeNull()
    expect(errorText(err)).toBe('Mac 에 연결할 수 없어요')
  })

  it('그 밖의 4xx/5xx 는 http 오류이고 서버 문구를 싣는다', async () => {
    const api = createMobileApi(async () => res(500, { error: '데이터베이스 오류' }))
    const err = (await api.getMemos().catch((e: unknown) => e)) as MobileApiError
    expect(err.kind).toBe('http')
    expect(err.status).toBe(500)
    expect(err.message).toBe('데이터베이스 오류')
  })

  it('GET 은 쿠키(same-origin)로 보내고 모바일 헤더는 붙이지 않는다', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => res(200, { todos: [] }))
    const api = createMobileApi(fetchImpl)
    await api.getTodos(true)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/todos?completed=1')
    expect(init?.method).toBe('GET')
    expect(init?.credentials).toBe('same-origin')
    expect(init?.headers).toBeUndefined()
  })

  it('POST 에는 X-LinkWork-Mobile: 1 과 JSON Content-Type 이 붙는다', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => res(200, { success: true }))
    const api = createMobileApi(fetchImpl)
    await api.completeTodo(7)
    await api.restoreTodo(8)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/todos/7/complete')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect(init?.headers).toMatchObject({ [MOBILE_HEADER]: '1', 'Content-Type': 'application/json' })
    expect(MOBILE_HEADER).toBe('X-LinkWork-Mobile')
    expect(fetchImpl.mock.calls[1][0]).toBe('/api/todos/8/restore')
  })

  it('메모 작성은 계약 본문 형식으로 POST 하고 id 를 돌려준다', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => res(200, { id: 42 }))
    const api = createMobileApi(fetchImpl)
    const out = await api.createMemo({ content: '# 회의\n내용', category_id: 3, is_important: 1 })
    expect(out).toEqual({ id: 42 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/memos')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ content: '# 회의\n내용', category_id: 3, is_important: 1 })
  })
})
