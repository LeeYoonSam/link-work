import { isAbsolute, posix } from 'path'
import { fileURLToPath } from 'url'

/**
 * document:open이 shell로 넘기기 전에 렌더러가 보낸 url/path를 검사한다.
 * 렌더러가 오염되거나 DB에 악성 값이 들어와도 임의 스킴 실행·앱 실행으로 이어지지 않게 하는 마지막 관문.
 *
 * - 링크(type !== 'file'): `http:` / `https:` / `mailto:`만 shell.openExternal로 연다.
 *   `javascript:`·`file:`·`data:`·`vbscript:`·커스텀 앱 스킴(`notion://`, `x-apple…:` 등)은 거부한다.
 *   커스텀 스킴은 다른 앱의 URL 핸들러를 인자와 함께 호출하므로 허용 목록 밖은 막는다.
 * - 파일(type === 'file'): 로컬 절대경로만 shell.openPath로 연다. `file://` URL은 경로로 바꿔 허용하고,
 *   그 외 스킴(`smb:`, `http:` 등)·상대경로·`~` 경로는 거부한다.
 *   openPath는 실행 파일도 "기본 앱으로 열기" = 실행하므로, macOS에서 더블클릭만으로 코드가 도는
 *   확장자(앱 번들·스크립트·설치 패키지 등)와 앱 번들 내부 경로는 거부한다.
 *   실행 비트 검사는 하지 않는다 — SMB·USB(FAT) 볼륨은 일반 문서도 전부 0777로 보여 정상 문서가 막힌다.
 */

const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** 더블클릭(= openPath)만으로 코드가 실행되거나 설치가 시작되는 확장자. 폴더·일반 문서는 해당 없음. */
const BLOCKED_FILE_EXTENSIONS = new Set([
  '.app',
  '.command',
  '.tool',
  '.sh',
  '.bash',
  '.zsh',
  '.csh',
  '.ksh',
  '.terminal',
  '.pkg',
  '.mpkg',
  '.scpt',
  '.scptd',
  '.applescript',
  '.workflow',
  '.action',
  '.jar',
  '.prefpane',
  '.webloc',
  '.inetloc',
  '.fileloc',
  '.afploc',
  '.ftploc',
  '.saver',
  '.mobileconfig',
  '.shortcut'
])

/** URL 스킴처럼 보이는 접두어 (`smb:`, `http:` …). 2글자 이상이라 Windows 드라이브 문자와 겹치지 않는다. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]+:/i

export type OpenTarget =
  | { ok: true; kind: 'external'; target: string }
  | { ok: true; kind: 'path'; target: string }
  | { ok: false; error: string }

export function resolveOpenTarget(url: unknown, type: unknown): OpenTarget {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, error: '열 주소가 비어 있습니다.' }
  }
  const value = url.trim()
  return type === 'file' ? resolveFilePath(value) : resolveLink(value)
}

function resolveLink(value: string): OpenTarget {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, error: `주소를 해석하지 못했습니다: ${value.slice(0, 100)}` }
  }
  if (!ALLOWED_LINK_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, error: `허용되지 않은 주소 형식입니다 (${parsed.protocol}). http/https 링크만 열 수 있습니다.` }
  }
  return { ok: true, kind: 'external', target: parsed.href }
}

function resolveFilePath(value: string): OpenTarget {
  let path = value
  if (/^file:/i.test(path)) {
    try {
      path = fileURLToPath(path)
    } catch {
      return { ok: false, error: `파일 주소를 해석하지 못했습니다: ${value.slice(0, 100)}` }
    }
  } else if (SCHEME_PATTERN.test(path)) {
    return { ok: false, error: '파일 문서는 로컬 절대경로만 열 수 있습니다.' }
  }

  if (path.includes('\0') || !isAbsolute(path)) {
    return { ok: false, error: '파일 문서는 로컬 절대경로(/로 시작)만 열 수 있습니다.' }
  }

  // 경로의 모든 구간을 본다 — `Foo.app/` (끝 슬래시)와 `Foo.app/Contents/MacOS/Foo` (번들 내부 실행 파일)도 막는다.
  const segments = path.split(/[\\/]+/).filter(Boolean)
  const blocked = segments.find((segment) => BLOCKED_FILE_EXTENSIONS.has(posix.extname(segment).toLowerCase()))
  if (blocked) {
    return { ok: false, error: `실행 가능한 파일은 열 수 없습니다: ${blocked}` }
  }
  return { ok: true, kind: 'path', target: path }
}
