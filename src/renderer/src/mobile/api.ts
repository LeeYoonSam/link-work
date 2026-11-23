// 모바일 화면의 HTTP API 래퍼. 휴대폰 브라우저에는 preload 브리지(IPC)가 없으므로 fetch 만 쓴다.
// 오류를 세 갈래로 나눈다: 'auth'(401 — QR 재스캔 필요), 'network'(Mac 잠자기·앱 종료로 연결 불가), 'http'(그 밖의 4xx/5xx).
// 테스트에서 fetch 를 바꿔 끼울 수 있도록 createMobileApi 가 fetch 구현을 받는다.
import type {
  MobileMemoCreateBody,
  MobileMemoCreated,
  MobileMemosResponse,
  MobileOk,
  MobileTodayResponse,
  MobileTodoCreateBody,
  MobileTodoCreated,
  MobileTodosResponse
} from './contract'

type MobileApiErrorKind = 'auth' | 'network' | 'http'

export class MobileApiError extends Error {
  readonly kind: MobileApiErrorKind
  /** HTTP 상태. 네트워크 오류면 null */
  readonly status: number | null

  constructor(kind: MobileApiErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'MobileApiError'
    this.kind = kind
    this.status = status
  }
}

/** fetch 응답에서 쓰는 부분만 */
export interface ResponseLike {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<ResponseLike>

/** POST 에 꼭 붙는 헤더. 서버가 CSRF 방어로 검사한다 */
export const MOBILE_HEADER = 'X-LinkWork-Mobile'

export interface MobileApi {
  getToday: () => Promise<MobileTodayResponse>
  getTodos: (completed: boolean) => Promise<MobileTodosResponse>
  createTodo: (body: MobileTodoCreateBody) => Promise<MobileTodoCreated>
  completeTodo: (id: number) => Promise<MobileOk>
  restoreTodo: (id: number) => Promise<MobileOk>
  getMemos: () => Promise<MobileMemosResponse>
  createMemo: (body: MobileMemoCreateBody) => Promise<MobileMemoCreated>
}

const errorMessageOf = (body: unknown): string | null =>
  body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : null

export function createMobileApi(fetchImpl: FetchLike = (input, init) => fetch(input, init)): MobileApi {
  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, credentials: 'same-origin', cache: 'no-store' }
    if (method === 'POST') {
      init.headers = { [MOBILE_HEADER]: '1', 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body ?? {})
    }
    let res: ResponseLike
    try {
      res = await fetchImpl(path, init)
    } catch {
      throw new MobileApiError('network', 'Mac 에 연결할 수 없어요')
    }
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    if (res.status === 401) {
      throw new MobileApiError('auth', errorMessageOf(data) ?? '연결이 만료되었어요', 401)
    }
    if (!res.ok) {
      throw new MobileApiError('http', errorMessageOf(data) ?? `요청에 실패했어요 (${res.status})`, res.status)
    }
    if (data === null) throw new MobileApiError('http', '응답을 읽지 못했어요', res.status)
    return data as T
  }

  return {
    getToday: () => request<MobileTodayResponse>('GET', '/api/today'),
    getTodos: (completed) => request<MobileTodosResponse>('GET', `/api/todos?completed=${completed ? 1 : 0}`),
    createTodo: (body) => request<MobileTodoCreated>('POST', '/api/todos', body),
    completeTodo: (id) => request<MobileOk>('POST', `/api/todos/${encodeURIComponent(String(id))}/complete`),
    restoreTodo: (id) => request<MobileOk>('POST', `/api/todos/${encodeURIComponent(String(id))}/restore`),
    getMemos: () => request<MobileMemosResponse>('GET', '/api/memos'),
    createMemo: (body) => request<MobileMemoCreated>('POST', '/api/memos', body)
  }
}

export const isAuthError = (e: unknown): boolean => e instanceof MobileApiError && e.kind === 'auth'
export const isNetworkError = (e: unknown): boolean => e instanceof MobileApiError && e.kind === 'network'

/** 화면에 보일 오류 문구 */
export function errorText(e: unknown): string {
  if (e instanceof MobileApiError) return e.kind === 'network' ? 'Mac 에 연결할 수 없어요' : e.message
  if (e instanceof Error && e.message) return e.message
  return '알 수 없는 오류'
}
