// 모바일 서버 설정 저장 — 켜짐 여부와 페어링 토큰.
// 토큰은 jira.ts·notion.ts 처럼 safeStorage 암호문으로 app_settings 에 둔다.
// safeStorage 를 못 쓰면 평문으로 저장하지 않고 메모리에만 둔다(앱을 다시 켜면 새 토큰 → 다시 스캔).
// 두 키 모두 기기 종속이라 백업에서 빠진다(backup-groups SECRET_SETTING_KEYS).
import { safeStorage } from 'electron'
import { getDatabase } from '../../db/database'
import { generateToken } from './auth'
import { MOBILE_ENABLED_KEY, MOBILE_TOKEN_KEY } from './types'

let memoryToken: string | null = null

function readSetting(key: string): string | null {
  const row = getDatabase().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

function writeSetting(key: string, value: string): void {
  getDatabase()
    .prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")
    .run(key, value)
}

function deleteSetting(key: string): void {
  getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(key)
}

export function isMobileEnabled(): boolean {
  return readSetting(MOBILE_ENABLED_KEY) === '1'
}

export function setMobileEnabled(enabled: boolean): void {
  writeSetting(MOBILE_ENABLED_KEY, enabled ? '1' : '0')
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function storeToken(token: string): void {
  if (encryptionAvailable()) {
    writeSetting(MOBILE_TOKEN_KEY, safeStorage.encryptString(token).toString('base64'))
    memoryToken = token
  } else {
    deleteSetting(MOBILE_TOKEN_KEY)
    memoryToken = token
  }
}

/** 현재 토큰. 없거나 복호화할 수 없으면 새로 만들어 저장한다 */
export function getOrCreateToken(): string {
  if (memoryToken) return memoryToken
  const stored = readSetting(MOBILE_TOKEN_KEY)
  if (stored && encryptionAvailable()) {
    try {
      const token = safeStorage.decryptString(Buffer.from(stored, 'base64'))
      if (token) {
        memoryToken = token
        return token
      }
    } catch {
      // 다른 기기에서 옮겨 온 암호문 등 — 새로 만든다
    }
  }
  const token = generateToken()
  storeToken(token)
  return token
}

/** 새 토큰을 저장한다. 옛 토큰에서 유도한 쿠키는 즉시 맞지 않게 된다 */
export function regenerateToken(): string {
  const token = generateToken()
  storeToken(token)
  return token
}
