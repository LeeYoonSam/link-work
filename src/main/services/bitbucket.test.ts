import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Electron 런타임 없이 돌아야 하므로 safeStorage와 DB를 모듈 경계에서 대체한다.
// safeStorage는 "암호화 불가" 경로로 고정해 저장값을 평문으로 확인할 수 있게 한다.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (b: Buffer) => b.toString()
  }
}))

const settings = new Map<string, string>()

vi.mock('../db/database', () => ({
  getDatabase: () => ({
    prepare: (sql: string) => ({
      get: (key: string) => {
        const value = settings.get(key)
        return value === undefined ? undefined : { value }
      },
      run: (...args: string[]) => {
        if (sql.trimStart().startsWith('DELETE')) settings.delete(args[0])
        else settings.set(args[0], args[1])
        return { changes: 1 }
      }
    })
  })
}))

import {
  BITBUCKET_NOT_CONNECTED_MESSAGE,
  disconnectBitbucket,
  getBitbucketEmail,
  isBitbucketConnected,
  MAX_CONTENT_CHARS,
  readBitbucketSource,
  saveBitbucketCredentials
} from './bitbucket'

const EMAIL = 'me@example.com'
const TOKEN = 'ATATT-secret-token-value'
const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`
const API = 'https://api.bitbucket.org/2.0'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function text(body: string | Uint8Array<ArrayBuffer>, contentType = 'text/plain'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

type Route = (url: string, init: RequestInit) => Response | undefined

let fetchMock: ReturnType<typeof vi.fn>

function installFetch(route: Route): void {
  fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const res = route(url, init)
    if (!res) return json({ type: 'error', error: { message: 'not found' } }, 404)
    return res
  })
  vi.stubGlobal('fetch', fetchMock)
}

function calls(): Array<{ url: string; init: RequestInit }> {
  return fetchMock.mock.calls.map(([u, i]) => ({ url: String(u), init: (i ?? {}) as RequestInit }))
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name]
}

function connect(): void {
  settings.set('bitbucket_email', EMAIL)
  settings.set('bitbucket_api_token', TOKEN)
}

beforeEach(() => {
  settings.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('연동 상태', () => {
  it('token 과 이메일이 모두 있어야 연결로 판정한다', () => {
    expect(isBitbucketConnected()).toBe(false)
    settings.set('bitbucket_email', EMAIL)
    // 백업 복원 뒤처럼 이메일만 남은 상태
    expect(isBitbucketConnected()).toBe(false)
    expect(getBitbucketEmail()).toBe(EMAIL)
    settings.set('bitbucket_api_token', TOKEN)
    expect(isBitbucketConnected()).toBe(true)
  })

  it('disconnectBitbucket 은 이메일과 token 을 지운다', () => {
    connect()
    disconnectBitbucket()
    expect(settings.size).toBe(0)
    expect(isBitbucketConnected()).toBe(false)
  })
})

describe('saveBitbucketCredentials', () => {
  it('/2.0/user 로 검증하고 display_name 을 반환한다', async () => {
    installFetch((url) => (url === `${API}/user` ? json({ display_name: '홍길동' }) : undefined))
    const result = await saveBitbucketCredentials(` ${EMAIL} `, ` ${TOKEN} `)
    expect(result).toEqual({ account: '홍길동' })
    expect(settings.get('bitbucket_email')).toBe(EMAIL)
    expect(settings.get('bitbucket_api_token')).toBe(TOKEN)
    const [call] = calls()
    expect(call.init.method).toBe('GET')
    expect(header(call.init, 'Authorization')).toBe(AUTH)
  })

  it('401 이면 저장하지 않고 이메일·token·스코프 확인을 안내한다', async () => {
    installFetch(() => json({ type: 'error' }, 401))
    const err = await saveBitbucketCredentials(EMAIL, TOKEN).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/이메일.*token.*스코프/)
    expect((err as Error).message).not.toContain(TOKEN)
    expect(settings.size).toBe(0)
  })

  it('403 은 read:user 스코프가 없는 것으로 보고 이메일을 계정 이름으로 저장한다', async () => {
    installFetch(() => json({ type: 'error' }, 403))
    expect(await saveBitbucketCredentials(EMAIL, TOKEN)).toEqual({ account: EMAIL })
    expect(isBitbucketConnected()).toBe(true)
  })

  it('빈 값과 잘못된 이메일은 API 를 부르지 않고 거부한다', async () => {
    installFetch(() => json({}))
    await expect(saveBitbucketCredentials('', TOKEN)).rejects.toThrow()
    await expect(saveBitbucketCredentials('not-email', TOKEN)).rejects.toThrow()
    await expect(saveBitbucketCredentials(EMAIL, '  ')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('readBitbucketSource', () => {
  const FILE_URL =
    'https://bitbucket.org/backpackr/ios-ai-workspace/src/main/labs/gihyun/skills/client-log-query/SKILL.md'
  const SRC = `${API}/repositories/backpackr/ios-ai-workspace/src`

  it('미연동이면 연동 안내 메시지로 실패한다', async () => {
    installFetch(() => json({}))
    await expect(readBitbucketSource(FILE_URL)).rejects.toThrow(BITBUCKET_NOT_CONNECTED_MESSAGE)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('파일이면 본문을 반환하고 모든 요청은 GET·인증 헤더를 쓴다', async () => {
    connect()
    const path = 'labs/gihyun/skills/client-log-query/SKILL.md'
    installFetch((url) => {
      if (url === `${SRC}/main/${path}?format=meta`) {
        return json({ type: 'commit_file', size: 12, mimetype: 'text/markdown' })
      }
      if (url === `${SRC}/main/${path}`) return text('# Skill\n본문', 'text/markdown')
      return undefined
    })

    const result = await readBitbucketSource(FILE_URL)
    expect(result).toMatchObject({
      type: 'file',
      workspace: 'backpackr',
      repo: 'ios-ai-workspace',
      ref: 'main',
      path,
      content: '# Skill\n본문',
      truncated: false
    })
    for (const c of calls()) {
      expect(c.init.method).toBe('GET')
      expect(header(c.init, 'Authorization')).toBe(AUTH)
      expect(c.init.redirect).toBe('manual')
    }
    // 반환값에 token·이메일·인증 헤더가 들어가지 않는다
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain(EMAIL)
    expect(serialized).not.toContain(AUTH)
  })

  it('ref 가 없으면 mainbranch 로 루트 폴더 목록을 반환한다', async () => {
    connect()
    installFetch((url) => {
      if (url === `${API}/repositories/backpackr/ios-ai-workspace`) {
        return json({ mainbranch: { name: 'develop' } })
      }
      if (url === `${SRC}/develop/?pagelen=100`) {
        return json({
          values: [
            { path: 'README.md', type: 'commit_file', size: 10 },
            { path: 'labs', type: 'commit_directory' }
          ]
        })
      }
      return undefined
    })

    const result = await readBitbucketSource('https://bitbucket.org/backpackr/ios-ai-workspace')
    expect(result).toEqual({
      url: 'https://bitbucket.org/backpackr/ios-ai-workspace',
      workspace: 'backpackr',
      repo: 'ios-ai-workspace',
      ref: 'develop',
      path: '',
      type: 'directory',
      entries: [
        { path: 'README.md', type: 'file', size: 10 },
        { path: 'labs', type: 'directory' }
      ],
      truncated: false
    })
  })

  it('폴더 목록은 next 를 따라가되 페이지 상한에서 멈춘다', async () => {
    connect()
    installFetch((url) => {
      if (url.endsWith('?format=meta')) return json({ type: 'commit_directory' })
      const m = url.match(/[?&]page=(\d+)/)
      const page = m ? Number(m[1]) : 1
      return json({
        values: Array.from({ length: 100 }, (_, i) => ({
          path: `labs/f${page}-${i}.md`,
          type: 'commit_file',
          size: 1
        })),
        next: `${SRC}/main/labs/?pagelen=100&page=${page + 1}`
      })
    })

    const result = await readBitbucketSource('https://bitbucket.org/backpackr/ios-ai-workspace/src/main/labs')
    expect(result.type).toBe('directory')
    if (result.type !== 'directory') return
    expect(result.entries).toHaveLength(500)
    expect(result.truncated).toBe(true)
    // meta 1회 + 목록 5페이지
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('next 가 api.bitbucket.org 밖을 가리키면 인증 헤더를 보내지 않고 거부한다', async () => {
    connect()
    installFetch((url) => {
      if (url.endsWith('?format=meta')) return json({ type: 'commit_directory' })
      if (url.startsWith(SRC)) {
        return json({ values: [], next: 'https://evil.example/steal?pagelen=100' })
      }
      return json({ values: [] })
    })
    await expect(
      readBitbucketSource('https://bitbucket.org/backpackr/ios-ai-workspace/src/main/labs')
    ).rejects.toThrow()
    expect(calls().some((c) => c.url.startsWith('https://evil.example'))).toBe(false)
  })

  it('다른 호스트로 리다이렉트되면 인증 헤더 없이 따라간다', async () => {
    connect()
    installFetch((url) => {
      if (url.endsWith('?format=meta')) return json({ type: 'commit_file', size: 5 })
      if (url.startsWith(SRC)) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://bbuseruploads.s3.amazonaws.com/x?sig=1' }
        })
      }
      if (url.startsWith('https://bbuseruploads.s3.amazonaws.com/')) return text('hello')
      return undefined
    })
    const result = await readBitbucketSource('https://bitbucket.org/backpackr/ios-ai-workspace/src/main/a.txt')
    expect(result).toMatchObject({ type: 'file', content: 'hello' })
    const external = calls().find((c) => c.url.startsWith('https://bbuseruploads'))
    expect(external).toBeDefined()
    expect(header(external!.init, 'Authorization')).toBeUndefined()
  })

  it('본문이 15,000자를 넘으면 자르고 truncated 를 표시한다', async () => {
    connect()
    installFetch((url) => {
      if (url.endsWith('?format=meta')) return json({ type: 'commit_file', size: 20000 })
      return text('a'.repeat(20_000))
    })
    const result = await readBitbucketSource('https://bitbucket.org/backpackr/ios-ai-workspace/src/main/big.txt')
    expect(result.type).toBe('file')
    if (result.type !== 'file') return
    expect(result.content).toHaveLength(MAX_CONTENT_CHARS)
    expect(result.truncated).toBe(true)
  })

  it('바이너리 파일은 본문 대신 안내 문구를 반환한다', async () => {
    connect()
    installFetch((url) => {
      if (url.endsWith('?format=meta')) {
        return json({ type: 'commit_file', size: 4, mimetype: 'image/png' })
      }
      return text(new Uint8Array([0x89, 0x50, 0x00, 0x47]), 'image/png')
    })
    const result = await readBitbucketSource('https://bitbucket.org/backpackr/ios-ai-workspace/src/main/a.png')
    expect(result.type).toBe('file')
    if (result.type !== 'file') return
    expect(result.content).toContain('바이너리')
  })

  it('슬래시가 든 브랜치는 404 뒤 ref 를 늘려 다시 시도한다', async () => {
    connect()
    installFetch((url) => {
      if (url === `${SRC}/feature%2Flogin/docs/a.md?format=meta`) return json({ type: 'commit_file' })
      if (url === `${SRC}/feature%2Flogin/docs/a.md`) return text('ok')
      return undefined
    })
    const result = await readBitbucketSource(
      'https://bitbucket.org/backpackr/ios-ai-workspace/src/feature/login/docs/a.md'
    )
    expect(result).toMatchObject({ type: 'file', ref: 'feature/login', path: 'docs/a.md', content: 'ok' })
  })

  it('끝까지 404 면 저장소·경로·브랜치·권한 확인을 안내한다', async () => {
    connect()
    installFetch(() => undefined)
    const err = await readBitbucketSource(
      'https://bitbucket.org/backpackr/ios-ai-workspace/src/main/a/b/c/d/e.md'
    ).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/저장소·경로·브랜치/)
    expect((err as Error).message).toMatch(/읽기 권한/)
    // 첫 시도 1회 + 재시도 3회
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('401 은 token 값 없이 인증 확인을 안내한다', async () => {
    connect()
    installFetch(() => json({ type: 'error' }, 401))
    const err = await readBitbucketSource(FILE_URL).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/인증에 실패/)
    expect((err as Error).message).not.toContain(TOKEN)
    expect((err as Error).message).not.toContain(AUTH)
  })

  it('Bitbucket 소스 URL 이 아니면 요청 없이 실패한다', async () => {
    connect()
    installFetch(() => json({}))
    await expect(readBitbucketSource('https://bitbucket.org/ws/repo/pull-requests/1')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
