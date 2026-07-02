// 웹 페이지 읽기 (AI fetch_url 도구용).
//
// [가드레일]
// - http/https만 허용, 로컬호스트/사설망 주소는 차단한다 (프롬프트 인젝션으로
//   내부 서비스에 접근하는 경로 차단).
// - 리다이렉트는 수동으로 따라가며 매 단계 같은 검증을 거친다 (최대 5회).
// - 응답 크기(2MB)/시간(15초)/최종 텍스트 길이(12,000자) 상한.
// - GET만 사용 — 외부에 데이터를 쓰는 요청은 만들지 않는다.

const REQUEST_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 5
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_TEXT_CHARS = 12_000

const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/json'
]

// 차단 대상 호스트인지 검사한다. 반환값은 차단 사유(통과 시 null).
// DNS rebinding까지 막지는 못하지만(로컬 데스크톱 앱 위협 모델에서 수용),
// 명백한 로컬/사설망 접근은 URL 단계에서 거른다.
export function getUrlBlockReason(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return 'URL 형식이 올바르지 않습니다.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'http/https URL만 읽을 수 있습니다.'
  }
  if (url.username || url.password) {
    return '인증 정보가 포함된 URL은 읽을 수 없습니다.'
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return '로컬 주소는 읽을 수 없습니다.'
  }
  // IPv4 사설/루프백/링크로컬 대역
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      return '사설망/로컬 IP 주소는 읽을 수 없습니다.'
    }
  }
  // IPv6 루프백/링크로컬/ULA
  if (host === '::1' || host === '::' || /^(fe80|fc|fd)/i.test(host)) {
    return '사설망/로컬 IP 주소는 읽을 수 없습니다.'
  }
  return null
}

export interface FetchedPage {
  url: string
  title: string | null
  content: string
  contentType: string
  truncated: boolean
}

export async function fetchUrlAsText(rawUrl: string): Promise<FetchedPage> {
  let currentUrl = rawUrl.trim()

  for (let redirects = 0; ; redirects++) {
    const blockReason = getUrlBlockReason(currentUrl)
    if (blockReason) throw new Error(blockReason)

    const res = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'LinkWork/1.0 (AI assistant; +local desktop app)',
        Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error(`리다이렉트 응답에 Location이 없습니다 (${res.status}).`)
      if (redirects >= MAX_REDIRECTS) throw new Error('리다이렉트가 너무 많습니다.')
      currentUrl = new URL(location, currentUrl).toString()
      continue
    }

    if (!res.ok) {
      throw new Error(`페이지를 가져오지 못했습니다 (HTTP ${res.status}).`)
    }

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (contentType && !ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw new Error(
        `지원하지 않는 콘텐츠 타입입니다: ${contentType} (텍스트/HTML/JSON만 읽을 수 있습니다)`
      )
    }

    const raw = await readBodyWithCap(res, MAX_RESPONSE_BYTES)
    let title: string | null = null
    let content: string

    if (contentType === 'text/html' || contentType === 'application/xhtml+xml' || !contentType) {
      title = extractHtmlTitle(raw)
      content = htmlToText(raw)
    } else {
      content = raw
    }

    const truncated = content.length > MAX_TEXT_CHARS
    if (truncated) content = content.slice(0, MAX_TEXT_CHARS)

    return { url: currentUrl, title, content, contentType: contentType || 'text/html', truncated }
  }
}

async function readBodyWithCap(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    chunks.push(value)
    if (received >= maxBytes) {
      void reader.cancel().catch(() => {})
      break
    }
  }
  return Buffer.concat(chunks).toString('utf-8')
}

// ── HTML → 텍스트 (순수 함수 — 단위 테스트 대상) ──
// 외부 의존 없이 주요 구조(제목/문단/리스트/링크/코드)만 마크다운 유사 텍스트로 변환한다.
// JS 렌더링이 필요한 SPA는 본문이 비어 있을 수 있다 (알려진 한계).

export function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? decodeEntities(match[1]).trim() || null : null
}

export function htmlToText(html: string): string {
  let s = html
  // 내용이 아닌 영역 제거
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<(script|style|noscript|svg|head|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, '')

  // 구조 태그 → 마크다운 유사 표기
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => {
    return `\n\n${'#'.repeat(Number(level))} ${stripTags(inner)}\n\n`
  })
  s = s.replace(
    /<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, inner: string) => {
      const text = stripTags(inner).trim()
      if (!text) return ''
      // javascript: 등 비정상 스킴 링크는 텍스트만 남긴다
      if (/^(https?:)?\/\//i.test(href) || href.startsWith('/')) return `[${text}](${href})`
      return text
    }
  )
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
  s = s.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*')
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => `\n\`\`\`\n${stripTags(inner)}\n\`\`\`\n`)
  s = s.replace(/<li[^>]*>/gi, '\n- ')
  s = s.replace(/<blockquote[^>]*>/gi, '\n> ')
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|figure|header|footer|main)>/gi, '\n\n')
  s = s.replace(/<\/(td|th)>/gi, ' | ')

  s = stripTags(s)
  s = decodeEntities(s)

  // 공백 정리: 줄 내 연속 공백 축소, 3줄 이상 연속 개행 축소
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    middot: '·',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    copy: '©'
  }
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m)
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}
