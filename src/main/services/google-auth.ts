import { OAuth2Client } from 'google-auth-library'
import { BrowserWindow, safeStorage } from 'electron'
import { randomBytes } from 'crypto'
import { getDatabase } from '../db/database'

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']

let oauth2Client: OAuth2Client | null = null

function getSettings(): { clientId: string; clientSecret: string } | null {
  const db = getDatabase()
  const clientId = db.prepare("SELECT value FROM app_settings WHERE key = 'google_client_id'").get() as
    | { value: string }
    | undefined
  const clientSecret = db
    .prepare("SELECT value FROM app_settings WHERE key = 'google_client_secret'")
    .get() as { value: string } | undefined

  if (!clientId || !clientSecret) return null
  const secret = readClientSecret(clientSecret.value)
  if (secret === null) return null
  return { clientId: clientId.value, clientSecret: secret }
}

/** base64로 저장된 safeStorage 암호문인지 — macOS 암호문은 'v10'/'v11' 버전 접두어 바이트로 시작한다. */
function isSafeStorageBlob(stored: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stored)) return false
  return /^v1\d/.test(Buffer.from(stored, 'base64').subarray(0, 3).toString('latin1'))
}

/**
 * client_secret은 safeStorage로 암호화해 저장한다 (client_id는 공개값이라 평문).
 * - 암호문: 복호화해 쓴다. 복호화에 실패하면(키체인 거부, 재서명으로 ACL 불일치, 다른 기기 DB) 행을 건드리지 않고
 *   null → hasCredentials() false → 캘린더 설정에서 다시 입력. 암호문을 다시 암호화해 덮어쓰면 영구 복구 불가가 된다.
 * - 암호문이 아닌 값: 구버전이 남긴 평문 행이므로 그대로 쓰고, 읽는 김에 암호문으로 바꿔 둔다.
 */
function readClientSecret(stored: string): string | null {
  if (isSafeStorageBlob(stored)) {
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return null
    }
  }
  if (safeStorage.isEncryptionAvailable()) {
    getDatabase()
      .prepare("UPDATE app_settings SET value = ?, updated_at = datetime('now') WHERE key = 'google_client_secret'")
      .run(encrypt(stored))
  }
  return stored
}

function getOAuth2Client(): OAuth2Client | null {
  if (oauth2Client) return oauth2Client
  const settings = getSettings()
  if (!settings) return null
  oauth2Client = new OAuth2Client(settings.clientId, settings.clientSecret, 'http://localhost:8945/callback')
  return oauth2Client
}

export function saveSettings(clientId: string, clientSecret: string): void {
  const db = getDatabase()
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  )
  stmt.run('google_client_id', clientId)
  stmt.run('google_client_secret', encrypt(clientSecret))
  oauth2Client = null
}

export async function authenticate(): Promise<boolean> {
  const client = getOAuth2Client()
  if (!client) throw new Error('Google OAuth2 credentials not configured')

  const state = randomBytes(32).toString('hex')

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state
  })

  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      width: 500,
      height: 700,
      show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: true }
    })

    const http = require('http')
    const server = http.createServer(async (req: any, res: any) => {
      const url = new URL(req.url, 'http://localhost:8945')
      const returnedState = url.searchParams.get('state')
      const code = url.searchParams.get('code')

      if (!returnedState || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Invalid state parameter</h2></body></html>')
        return
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Authentication successful! You can close this window.</h2></body></html>')
        server.close()
        authWindow.close()
        try {
          const { tokens } = await client.getToken(code)
          client.setCredentials(tokens)
          saveTokens(tokens as { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null })
          resolve(true)
        } catch (err) {
          reject(err)
        }
      }
    })

    server.on('error', (err: Error) => {
      authWindow.close()
      reject(new Error(`OAuth server failed to start: ${err.message}`))
    })

    // 콜백은 같은 기기의 브라우저 창에서만 온다 — 모든 인터페이스가 아닌 루프백에만 바인딩한다.
    // redirect URI(http://localhost:8945/callback)는 Google 콘솔 등록값이라 그대로 둔다.
    server.listen(8945, '127.0.0.1', () => {
      authWindow.loadURL(authUrl)
    })

    authWindow.on('closed', () => {
      server.close()
      resolve(false)
    })
  })
}

function encrypt(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64')
  }
  return value
}

function decrypt(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return value
    }
  }
  return value
}

function saveTokens(tokens: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null; [key: string]: unknown }): void {
  const db = getDatabase()
  db.prepare(
    `INSERT OR REPLACE INTO auth_tokens (id, provider, access_token, refresh_token, expiry_date, updated_at)
     VALUES (1, 'google', ?, ?, ?, datetime('now'))`
  ).run(
    tokens.access_token ? encrypt(tokens.access_token) : null,
    tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
    tokens.expiry_date ? String(tokens.expiry_date) : null
  )
}

export function loadTokens(): Record<string, unknown> | null {
  const db = getDatabase()
  const row = db.prepare("SELECT * FROM auth_tokens WHERE provider = 'google'").get() as
    | { access_token: string; refresh_token: string; expiry_date: string }
    | undefined
  if (!row) return null
  return {
    access_token: row.access_token ? decrypt(row.access_token) : null,
    refresh_token: row.refresh_token ? decrypt(row.refresh_token) : null,
    expiry_date: row.expiry_date ? Number(row.expiry_date) : undefined
  }
}

export function getAuthenticatedClient(): OAuth2Client | null {
  const client = getOAuth2Client()
  if (!client) return null
  const tokens = loadTokens()
  if (!tokens) return null
  client.setCredentials(tokens)
  return client
}

export function disconnect(): void {
  const db = getDatabase()
  db.prepare("DELETE FROM auth_tokens WHERE provider = 'google'").run()
  oauth2Client = null
}

export function isConnected(): boolean {
  return loadTokens() !== null
}

export function hasCredentials(): boolean {
  return getSettings() !== null
}
