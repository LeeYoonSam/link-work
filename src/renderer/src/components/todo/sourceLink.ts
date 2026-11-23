// 할 일의 출처 링크(todos.source_link)를 다루는 순수 함수. React·스토어·window 를 쓰지 않는다.
// 값 규칙은 main 의 normalizeSourceLink 와 같다: 'linkwork://' 앱 내 링크 또는 'https://' URL 만 받는다

const INTERNAL = 'linkwork://'
const HTTPS = 'https://'

// linkwork://{kind}/... 의 kind 별 칩 라벨
const INTERNAL_LABELS: Record<string, string> = {
  memo: '메모',
  note: '회의록',
  recording: '녹음'
}

// Jira 티켓 웹 주소의 키. 예: /browse/AB-123
const JIRA_KEY_RE = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#]|$)/

/** 열어도 되는 출처 링크인가. linkwork:// 또는 https:// 만 true 다(javascript: 등 차단) */
export function isSafeSourceLink(link: string): boolean {
  if (typeof link !== 'string') return false
  return link.startsWith(INTERNAL) || link.startsWith(HTTPS)
}

/** 출처 칩에 보일 짧은 이름. 메모·회의록·녹음, Jira 키, 아니면 호스트 이름 */
export function sourceLinkLabel(link: string): string {
  if (link.startsWith(INTERNAL)) {
    const kind = link.slice(INTERNAL.length).split('/')[0]
    return INTERNAL_LABELS[kind] ?? '원본'
  }
  try {
    const url = new URL(link)
    const m = JIRA_KEY_RE.exec(url.pathname)
    if (m) return m[1]
    return url.hostname || '링크'
  } catch {
    return '링크'
  }
}

/** 마크다운 한 줄에서 기호를 뺀 글자. 메모 첫 줄을 할 일 제목으로 쓸 때 쓴다 */
export function stripMarkdownLine(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*)[*_](?=\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 할 일 제목으로 미리 채울 글자의 최대 길이 */
export const PREFILL_MAX = 80

/** 메모 본문 → 빠른 추가 미리 채움. 첫 비어 있지 않은 줄에서 마크다운 기호를 빼고 80자로 자른다 */
export function memoTodoPrefill(memo: { id: number; content: string }): { text: string; sourceLink: string } {
  const first = memo.content.split(/\r\n|\r|\n/).find((l) => stripMarkdownLine(l) !== '') ?? ''
  return { text: stripMarkdownLine(first).slice(0, PREFILL_MAX), sourceLink: `linkwork://memo/${memo.id}` }
}

/** 회의록 → 빠른 추가 미리 채움. 회의록 링크(linkwork://note/{회의 id})는 회의록 메뉴에서 그 회의를 연다 */
export function meetingTodoPrefill(meeting: { id: number; title: string }): { text: string; sourceLink: string } {
  return { text: `${meeting.title} 후속`, sourceLink: `linkwork://note/${meeting.id}` }
}

/**
 * Jira 티켓 → 빠른 추가 미리 채움. 사이트 주소를 모르거나 https 가 아니면 null(버튼을 숨긴다)
 */
export function issueTodoPrefill(
  key: string,
  summary: string,
  siteUrl: string | null | undefined
): { text: string; sourceLink: string } | null {
  const base = (siteUrl ?? '').trim().replace(/\/+$/, '')
  if (!base.startsWith(HTTPS)) return null
  const text = summary ? `[${key}] ${summary}` : `[${key}]`
  return { text, sourceLink: `${base}/browse/${encodeURIComponent(key)}` }
}
