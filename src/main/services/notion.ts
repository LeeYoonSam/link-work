import { safeStorage } from 'electron'
import { getDatabase } from '../db/database'
import {
  blocksToMarkdown,
  extractNotionPageId,
  extractPageTitle,
  type NotionBlock
} from './notion-markdown'

// Notion internal integration 연동 (읽기 전용 사용).
//
// [가드레일]
// - 토큰은 app_settings에 safeStorage로 암호화해 저장한다 (google-auth.ts와 동일 패턴).
// - 이 모듈은 조회 API(search, pages, blocks)만 호출한다 — 쓰기 API 호출 금지.
// - 페이지 본문은 글자 수 상한으로 잘라 토큰 낭비/과대 응답을 막는다.

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const REQUEST_TIMEOUT_MS = 15_000
// 본문 수집 상한 — 페이지가 아무리 커도 이 이상 읽지 않는다
const MAX_BLOCKS = 500
const MAX_DEPTH = 3
const MAX_CONTENT_CHARS = 15_000

const TOKEN_KEY = 'notion_token'

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

export function getNotionToken(): string | null {
  const row = getDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(TOKEN_KEY) as { value: string } | undefined
  return row ? decrypt(row.value) : null
}

export function isNotionConnected(): boolean {
  return getNotionToken() !== null
}

export function disconnectNotion(): void {
  getDatabase().prepare('DELETE FROM app_settings WHERE key = ?').run(TOKEN_KEY)
}

// 토큰을 검증(API 호출)한 뒤 저장한다. 성공 시 워크스페이스/봇 이름을 반환.
export async function saveNotionToken(token: string): Promise<{ workspace: string }> {
  const trimmed = token.trim()
  if (!trimmed) throw new Error('토큰이 비어 있습니다.')
  const me = (await notionRequest('/users/me', { method: 'GET' }, trimmed)) as {
    name?: string
    bot?: { workspace_name?: string }
  }
  const workspace = me.bot?.workspace_name ?? me.name ?? 'Notion'
  getDatabase()
    .prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    )
    .run(TOKEN_KEY, encrypt(trimmed))
  return { workspace }
}

async function notionRequest(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
  tokenOverride?: string
): Promise<unknown> {
  const token = tokenOverride ?? getNotionToken()
  if (!token) throw new Error('NOTION_NOT_CONNECTED')

  const res = await fetch(`${NOTION_API}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Notion 토큰이 유효하지 않습니다. 연동 설정에서 토큰을 다시 등록해 주세요.')
    }
    if (res.status === 404) {
      throw new Error(
        '페이지를 찾을 수 없거나 통합(integration)에 공유되지 않았습니다. Notion에서 해당 페이지의 연결(Connections)에 통합을 추가해 주세요.'
      )
    }
    if (res.status === 429) {
      throw new Error('Notion API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.')
    }
    const body = await res.text().catch(() => '')
    throw new Error(`Notion API 오류 (${res.status}): ${body.slice(0, 200)}`)
  }
  return res.json()
}

export interface NotionSearchResult {
  id: string
  type: 'page' | 'database'
  title: string
  url: string
  last_edited: string
}

export async function searchNotion(query: string): Promise<NotionSearchResult[]> {
  const data = (await notionRequest('/search', {
    method: 'POST',
    body: { query, page_size: 20, sort: { direction: 'descending', timestamp: 'last_edited_time' } }
  })) as {
    results: Array<{
      id: string
      object: string
      url?: string
      last_edited_time?: string
      properties?: Record<string, unknown>
      title?: Array<{ plain_text?: string }>
    }>
  }

  return data.results.map((r) => ({
    id: r.id,
    type: r.object === 'database' ? 'database' : 'page',
    title:
      r.object === 'database'
        ? (r.title ?? []).map((t) => t.plain_text ?? '').join('') || '(제목 없음)'
        : extractPageTitle(r.properties),
    url: r.url ?? '',
    last_edited: r.last_edited_time ?? ''
  }))
}

export interface NotionPageContent {
  id: string
  title: string
  url: string
  markdown: string
  truncated: boolean
}

export async function getNotionPageContent(idOrUrl: string): Promise<NotionPageContent> {
  const pageId = extractNotionPageId(idOrUrl)
  if (!pageId) {
    throw new Error(
      `Notion 페이지 ID를 인식할 수 없습니다: ${idOrUrl.slice(0, 100)} — notion.so URL 또는 32자리 ID를 전달하세요.`
    )
  }

  const page = (await notionRequest(`/pages/${pageId}`, { method: 'GET' })) as {
    id: string
    url?: string
    properties?: Record<string, unknown>
  }

  const counter = { blocks: 0 }
  const blocks = await fetchBlockTree(pageId, 0, counter)
  let markdown = blocksToMarkdown(blocks)
  let truncated = counter.blocks >= MAX_BLOCKS
  if (markdown.length > MAX_CONTENT_CHARS) {
    markdown = markdown.slice(0, MAX_CONTENT_CHARS)
    truncated = true
  }

  return {
    id: page.id,
    title: extractPageTitle(page.properties),
    url: page.url ?? '',
    markdown,
    truncated
  }
}

// 블록 트리를 페이지네이션 따라 재귀 수집 (깊이/총량 상한)
async function fetchBlockTree(
  blockId: string,
  depth: number,
  counter: { blocks: number }
): Promise<NotionBlock[]> {
  if (depth >= MAX_DEPTH || counter.blocks >= MAX_BLOCKS) return []

  const blocks: NotionBlock[] = []
  let cursor: string | undefined
  do {
    const params = new URLSearchParams({ page_size: '100' })
    if (cursor) params.set('start_cursor', cursor)
    const data = (await notionRequest(`/blocks/${blockId}/children?${params}`, {
      method: 'GET'
    })) as { results: NotionBlock[]; has_more: boolean; next_cursor: string | null }

    for (const block of data.results) {
      if (counter.blocks >= MAX_BLOCKS) return blocks
      counter.blocks += 1
      // child_page/child_database는 링크로만 표시하고 내용은 내려가지 않는다
      if (block.has_children && block.type !== 'child_page' && block.type !== 'child_database') {
        block.children = await fetchBlockTree(block.id, depth + 1, counter)
      }
      blocks.push(block)
    }
    cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined
  } while (cursor)

  return blocks
}

// 데이터베이스 첫 페이지 조회 (제목/URL 목록) — get_notion_page가 database id를 받았을 때 사용
export async function getNotionDatabaseEntries(
  databaseId: string
): Promise<Array<{ id: string; title: string; url: string }>> {
  const data = (await notionRequest(`/databases/${databaseId}/query`, {
    method: 'POST',
    body: { page_size: 50 }
  })) as { results: Array<{ id: string; url?: string; properties?: Record<string, unknown> }> }
  return data.results.map((r) => ({
    id: r.id,
    title: extractPageTitle(r.properties),
    url: r.url ?? ''
  }))
}
