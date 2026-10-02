// Jira 설명(ADF, Atlassian Document Format) 해석 — 순수 함수만 둔다.
// 프로젝트 싱크업(project-sync-plan.ts)이 신규 프로젝트 설명(평문)과 문서 링크 추출에 쓴다.

interface AdfNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>
  content?: AdfNode[]
}

export interface ExtractedLink {
  name: string
  url: string
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === 'object' && value !== null
}

function attrString(node: AdfNode, key: string): string | null {
  const v = node.attrs?.[key]
  return typeof v === 'string' ? v : null
}

// 줄 단위로 끊기는 블록. 이 블록이 끝날 때 줄바꿈을 넣는다.
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'rule',
  'panel',
  'mediaSingle',
  'tableRow'
])

/** ADF를 사람이 읽을 평문으로 바꾼다. 내용이 없으면 null */
export function adfToPlainText(doc: unknown): string | null {
  if (typeof doc === 'string') return doc.trim() || null
  if (!isNode(doc)) return null

  const out: string[] = []
  const walk = (node: AdfNode, listDepth: number): void => {
    switch (node.type) {
      case 'text':
        out.push(node.text ?? '')
        return
      case 'hardBreak':
        out.push('\n')
        return
      case 'mention':
      case 'emoji':
        out.push(attrString(node, 'text') ?? attrString(node, 'shortName') ?? '')
        return
      case 'inlineCard':
      case 'blockCard':
      case 'embedCard':
        out.push(attrString(node, 'url') ?? '')
        if (node.type !== 'inlineCard') out.push('\n')
        return
      case 'listItem':
        out.push(`${'  '.repeat(Math.max(0, listDepth - 1))}- `)
        for (const child of node.content ?? []) walk(child, listDepth)
        return
      case 'bulletList':
      case 'orderedList':
        for (const child of node.content ?? []) walk(child, listDepth + 1)
        return
      case 'tableCell':
      case 'tableHeader':
        for (const child of node.content ?? []) walk(child, listDepth)
        out.push(' | ')
        return
    }
    for (const child of node.content ?? []) walk(child, listDepth)
    if (node.type && BLOCK_TYPES.has(node.type)) out.push('\n')
  }
  walk(doc, 0)

  const text = out
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    // 블록 사이 빈 줄은 하나까지만 남긴다
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text === '' ? null : text
}

// 괄호는 일단 포함해서 잡고(위키 `Foo_(bar)`), 짝이 안 맞는 끝 괄호는 아래에서 뗀다.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`\]]+/g

const countOf = (text: string, ch: string): number => text.split(ch).length - 1

// 문장 끝 구두점과 짝 없는 닫는 괄호가 URL 끝에 붙어 들어오는 것을 떼어낸다
// ("참고: https://a.com/x.", "(https://a.com/x)"). 둘이 섞여 붙을 수 있어 안 바뀔 때까지 반복한다.
function trimTrailingPunctuation(url: string): string {
  let out = url
  for (;;) {
    const before = out
    out = out.replace(/[.,;:!?]+$/, '')
    if (out.endsWith(')') && countOf(out, ')') > countOf(out, '(')) out = out.slice(0, -1)
    if (out === before) return out
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * URL 호스트로 문서 이름을 추정한다. 실제 프로젝트 문서 목록에서 쓰던 이름에 맞췄다.
 * Jira 이슈 링크는 키를 살려 `Jira 티켓 (KEY)`로 부른다.
 */
export function guessLinkName(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  const host = u.hostname.toLowerCase()
  if (host === 'notion.so' || host.endsWith('.notion.so') || host.endsWith('.notion.site')) {
    return 'Notion 문서'
  }
  if (host === 'figma.com' || host.endsWith('.figma.com')) return 'Figma'
  if (host === 'docs.google.com') return 'Google 문서'
  if (host.endsWith('.atlassian.net')) {
    if (u.pathname.startsWith('/wiki')) return 'Confluence'
    const browse = /^\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/.exec(u.pathname)
    if (browse) return `Jira 티켓 (${browse[1]})`
  }
  return host.replace(/^www\./, '')
}

/**
 * ADF 안의 링크를 모은다: link mark, inlineCard/blockCard/embedCard, 본문 텍스트 속 URL.
 * http(s)만 남기고, 같은 URL은 처음 나온 것 하나만 둔다.
 */
export function extractAdfLinks(doc: unknown): ExtractedLink[] {
  if (!isNode(doc)) return []
  const links: ExtractedLink[] = []
  const seen = new Set<string>()

  const add = (rawUrl: string, label: string | null): void => {
    const url = trimTrailingPunctuation(rawUrl.trim())
    if (!isHttpUrl(url) || seen.has(url)) return
    seen.add(url)
    // 링크 텍스트가 URL 자체이면 의미 없는 이름이라 호스트로 추정한다
    const text = label?.trim() ?? ''
    const name = text !== '' && !/^https?:\/\//i.test(text) ? text : guessLinkName(url)
    links.push({ name, url })
  }

  const walk = (node: AdfNode): void => {
    if (node.type === 'text') {
      const text = node.text ?? ''
      const linkMark = node.marks?.find((m) => m.type === 'link')
      const href = linkMark?.attrs?.href
      if (typeof href === 'string') {
        add(href, text)
      } else {
        for (const match of text.match(URL_IN_TEXT) ?? []) add(match, null)
      }
      return
    }
    if (node.type === 'inlineCard' || node.type === 'blockCard' || node.type === 'embedCard') {
      const url = attrString(node, 'url')
      if (url) add(url, null)
      return
    }
    for (const child of node.content ?? []) {
      if (isNode(child)) walk(child)
    }
  }
  walk(doc)
  return links
}
