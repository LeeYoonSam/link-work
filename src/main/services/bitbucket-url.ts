// Bitbucket Cloud 웹 URL 파서 (순수 함수 — 단위 테스트 대상).
//
// 지원 형식:
// - https://bitbucket.org/{ws}/{repo}
// - https://bitbucket.org/{ws}/{repo}/src
// - https://bitbucket.org/{ws}/{repo}/src/{ref}
// - https://bitbucket.org/{ws}/{repo}/src/{ref}/{path...}
// - /raw/ 는 /src/ 와 같게 읽는다.
//
// ref 에 슬래시가 든 브랜치(feature/x)는 URL 만으로 경계를 알 수 없다.
// 이 파서는 ?at= 값이 경로 앞부분과 맞으면 그 값을 ref 로 쓴다.
// 그 외에는 첫 세그먼트를 ref 로 본다. 남은 모호성은 bitbucket.ts 가 404 재시도로 처리한다.

export interface BitbucketLocation {
  workspace: string
  repo: string
  ref: string | null
  path: string
}

const BITBUCKET_HOSTS = new Set(['bitbucket.org', 'www.bitbucket.org'])
// workspace·저장소 슬러그에 허용하는 문자. API 경로 조작을 막는다.
const SLUG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const SOURCE_SECTIONS = new Set(['src', 'raw'])

function parseUrl(url: string): URL | null {
  try {
    return new URL(url.trim())
  } catch {
    return null
  }
}

export function isBitbucketUrl(url: string): boolean {
  const parsed = parseUrl(url)
  if (!parsed) return false
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  return BITBUCKET_HOSTS.has(parsed.hostname.toLowerCase())
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

// '.'·'..' 세그먼트는 API URL 정규화 때 상위 경로로 바뀐다. 그래서 거부한다.
function hasDotSegment(value: string): boolean {
  return value.split('/').some((s) => s === '.' || s === '..')
}

export function parseBitbucketUrl(url: string): BitbucketLocation | null {
  if (!isBitbucketUrl(url)) return null
  const parsed = parseUrl(url)
  if (!parsed) return null

  const rawSegments = parsed.pathname.split('/').filter((s) => s.length > 0)
  const segments: string[] = []
  for (const raw of rawSegments) {
    const decoded = decodeSegment(raw)
    if (decoded === null) return null
    segments.push(decoded)
  }
  if (segments.length < 2) return null

  const workspace = segments[0]
  const repo = segments[1].replace(/\.git$/i, '')
  if (!SLUG_RE.test(workspace) || !SLUG_RE.test(repo)) return null

  if (segments.length === 2) return { workspace, repo, ref: null, path: '' }
  if (!SOURCE_SECTIONS.has(segments[2])) return null

  const rest = segments.slice(3)
  if (rest.length === 0) return { workspace, repo, ref: null, path: '' }

  let ref = rest[0]
  let pathSegments = rest.slice(1)

  // ?at=feature/x 가 경로 앞부분과 맞으면 그 값을 ref 로 쓴다.
  const at = parsed.searchParams.get('at')?.trim()
  if (at && at.includes('/')) {
    const atSegments = at.split('/').filter((s) => s.length > 0)
    const matches =
      atSegments.length > 0 &&
      atSegments.length <= rest.length &&
      atSegments.every((s, i) => rest[i] === s)
    if (matches) {
      ref = atSegments.join('/')
      pathSegments = rest.slice(atSegments.length)
    }
  }

  const path = pathSegments.join('/').replace(/^\/+|\/+$/g, '')
  if (!ref || hasDotSegment(ref) || hasDotSegment(path)) return null
  return { workspace, repo, ref, path }
}
