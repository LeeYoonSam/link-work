import { beforeEach, describe, expect, it, vi } from 'vitest'

// Electron 런타임 없이 돌아야 하므로 safeStorage·DB·OAuth 클라이언트를 모듈 경계에서 대체한다.
// safeStorage는 macOS 암호문처럼 'v10' 접두어를 붙이는 가짜 암호화 — 접두어가 없는 값의 복호화는 실제처럼 throw한다.
// keychain.decryptFails로 "암호문인데 지금 복호화만 실패"(키체인 거부·재서명 ACL 불일치)를 흉내 낸다.
const keychain = vi.hoisted(() => ({ decryptFails: false }))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(`v10${v}`),
    decryptString: (b: Buffer) => {
      const s = b.toString()
      if (keychain.decryptFails || !s.startsWith('v10')) throw new Error('Error while decrypting the ciphertext')
      return s.slice(3)
    }
  }
}))

const oauthArgs: unknown[][] = []

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    constructor(...args: unknown[]) {
      oauthArgs.push(args)
    }
    setCredentials(): void {}
  }
}))

const settings = new Map<string, string>()

vi.mock('../db/database', () => ({
  getDatabase: () => ({
    prepare: (sql: string) => {
      const literalKey = sql.match(/key = '([^']+)'/)?.[1]
      return {
        get: () => {
          if (!literalKey) return undefined // auth_tokens 조회 — 토큰 없음
          const value = settings.get(literalKey)
          return value === undefined ? undefined : { value }
        },
        run: (...args: string[]) => {
          const op = sql.trimStart()
          if (op.startsWith('INSERT') && sql.includes('app_settings')) settings.set(args[0], args[1])
          else if (op.startsWith('UPDATE') && literalKey) settings.set(literalKey, args[0])
          return { changes: 1 }
        }
      }
    }
  })
}))

import { disconnect, getAuthenticatedClient, hasCredentials, saveSettings } from './google-auth'

/** getOAuth2Client가 OAuth2Client에 넘긴 client_secret (생성자 두 번째 인자) */
function secretPassedToClient(): unknown {
  oauthArgs.length = 0
  getAuthenticatedClient()
  return oauthArgs[0]?.[1]
}

describe('google-auth — client_secret 저장', () => {
  beforeEach(() => {
    settings.clear()
    keychain.decryptFails = false
    disconnect() // 캐시된 OAuth2Client를 비운다
  })

  it('저장값은 평문이 아니라 safeStorage 암호문이고, client_id는 평문이다', () => {
    saveSettings('my-id.apps.googleusercontent.com', 'GOCSPX-secret')

    expect(settings.get('google_client_id')).toBe('my-id.apps.googleusercontent.com')
    const stored = settings.get('google_client_secret')
    expect(stored).not.toBe('GOCSPX-secret')
    expect(stored).not.toContain('GOCSPX-secret')
    expect(Buffer.from(stored!, 'base64').toString()).toBe('v10GOCSPX-secret')
  })

  it('암호화해 저장한 값은 복호화해서 OAuth 클라이언트에 넘긴다', () => {
    saveSettings('my-id', 'GOCSPX-secret')
    expect(hasCredentials()).toBe(true)
    expect(secretPassedToClient()).toBe('GOCSPX-secret')
  })

  it('구버전 평문 행도 그대로 읽히고, 읽은 뒤 암호문으로 바뀐다', () => {
    settings.set('google_client_id', 'legacy-id')
    settings.set('google_client_secret', 'GOCSPX-legacy')

    expect(secretPassedToClient()).toBe('GOCSPX-legacy')
    const migrated = settings.get('google_client_secret')!
    expect(migrated).not.toBe('GOCSPX-legacy')
    expect(Buffer.from(migrated, 'base64').toString()).toBe('v10GOCSPX-legacy')

    // 마이그레이션 후에도 같은 값으로 읽힌다
    disconnect()
    expect(secretPassedToClient()).toBe('GOCSPX-legacy')
  })

  it('암호문인데 복호화가 실패하면 행을 다시 쓰지 않고 자격 증명이 없는 것으로 본다', () => {
    saveSettings('my-id', 'GOCSPX-secret')
    const stored = settings.get('google_client_secret')
    disconnect()
    keychain.decryptFails = true

    expect(hasCredentials()).toBe(false)
    expect(secretPassedToClient()).toBeUndefined() // OAuth2Client를 만들지 않는다
    expect(getAuthenticatedClient()).toBeNull()
    // 이중 암호화로 덮어쓰지 않는다 — 키체인 접근이 돌아오면 원래 값으로 다시 읽힌다
    expect(settings.get('google_client_secret')).toBe(stored)

    keychain.decryptFails = false
    expect(secretPassedToClient()).toBe('GOCSPX-secret')
  })

  it('복원 등으로 client_secret이 없으면 자격 증명이 없는 것으로 본다', () => {
    settings.set('google_client_id', 'restored-id')
    expect(hasCredentials()).toBe(false)
    expect(getAuthenticatedClient()).toBeNull()
  })
})
