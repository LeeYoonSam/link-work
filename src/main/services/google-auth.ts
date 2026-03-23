import { OAuth2Client } from 'google-auth-library'
import { BrowserWindow } from 'electron'
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
  return { clientId: clientId.value, clientSecret: clientSecret.value }
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
  stmt.run('google_client_secret', clientSecret)
  oauth2Client = null
}

export async function authenticate(): Promise<boolean> {
  const client = getOAuth2Client()
  if (!client) throw new Error('Google OAuth2 credentials not configured')

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  })

  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      width: 500,
      height: 700,
      show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    })

    const http = require('http')
    const server = http.createServer(async (req: any, res: any) => {
      const url = new URL(req.url, 'http://localhost:8945')
      const code = url.searchParams.get('code')
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

    server.listen(8945, () => {
      authWindow.loadURL(authUrl)
    })

    authWindow.on('closed', () => {
      server.close()
      resolve(false)
    })
  })
}

function saveTokens(tokens: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null; [key: string]: unknown }): void {
  const db = getDatabase()
  db.prepare(
    `INSERT OR REPLACE INTO auth_tokens (id, provider, access_token, refresh_token, expiry_date, updated_at)
     VALUES (1, 'google', ?, ?, ?, datetime('now'))`
  ).run(
    tokens.access_token as string,
    tokens.refresh_token as string || null,
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
    access_token: row.access_token,
    refresh_token: row.refresh_token,
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
