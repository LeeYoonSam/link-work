// 모바일 화면 정적 파일 해석 — out/renderer/mobile.html 과 out/renderer/assets/* 만 서빙한다.
// 경로 탈출(.., 절대경로, 인코딩된 슬래시·역슬래시, NUL)은 null 로 거부한다.
import { extname, resolve, sep } from 'path'

const MOBILE_HTML = 'mobile.html'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
}

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

const SAFE_SEGMENT = /^[A-Za-z0-9._@+-]+$/

/**
 * `/assets/...` 요청 경로(쿼리 제외, 인코딩된 원문)를 정적 루트 안의 절대 경로로 바꾼다.
 * 허용하지 않는 경로면 null.
 */
export function resolveAssetPath(staticRoot: string, rawPathname: string): string | null {
  if (!rawPathname.startsWith('/assets/')) return null
  const rest = rawPathname.slice('/assets/'.length)
  if (!rest) return null
  // 인코딩된 구분자·NUL·역슬래시는 디코딩 전에 거부한다
  if (/%2f|%5c|%00/i.test(rest) || rest.includes('\\')) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.startsWith('/')) return null
  const segments = decoded.split('/')
  for (const s of segments) {
    if (!s || s === '.' || s === '..' || !SAFE_SEGMENT.test(s)) return null
  }
  const assetsRoot = resolve(staticRoot, 'assets')
  const full = resolve(assetsRoot, ...segments)
  if (!full.startsWith(assetsRoot + sep)) return null
  return full
}

export function mobileHtmlPath(staticRoot: string): string {
  return resolve(staticRoot, MOBILE_HTML)
}

// ── 자산 허용 목록 ──
// out/renderer/assets 에는 데스크톱 번들(index-*.js 약 2MB)도 함께 있다. 휴대폰에는 mobile.html 이
// 참조하는 그래프만 내준다: html 의 ./assets/… → js 의 상대 import(정적·동적·__vite__mapDeps)
// → css 의 url(). 재귀로 따라간다. 그래프 계산이 실패하면 html 직접 참조 파일만 허용한다.

const ASSET_NAME = '[A-Za-z0-9._@+-]+'
const HTML_REF_RE = new RegExp(`(?:src|href)\\s*=\\s*["'](?:\\./|/)?assets/(${ASSET_NAME})(?:[?#][^"']*)?["']`, 'g')
// js: "./x-hash.js" (같은 폴더 상대 import), "assets/x-hash.js"·"/assets/x.css" (mapDeps·preload 목록)
const JS_REF_RE = new RegExp(`["'\`](?:\\./|(?:\\.?/)?assets/)(${ASSET_NAME}\\.(?:js|mjs|css|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|wasm))["'\`]`, 'g')
// css: url(./x.woff2) / url("/assets/x.png") / url(x.svg)
const CSS_URL_RE = new RegExp(`url\\(\\s*["']?(?:\\./|(?:\\.?/)?assets/)?(${ASSET_NAME})(?:[?#][^"')]*)?["']?\\s*\\)`, 'g')

function collect(re: RegExp, text: string): string[] {
  const out: string[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const name = m[1]
    if (name && name !== '.' && name !== '..' && SAFE_SEGMENT.test(name)) out.push(name)
  }
  return out
}

/** mobile.html 이 직접 참조하는 assets 파일 이름 */
export function htmlAssetRefs(html: string): string[] {
  return [...new Set(collect(HTML_REF_RE, html))]
}

export function jsAssetRefs(js: string): string[] {
  return [...new Set(collect(JS_REF_RE, js))]
}

export function cssAssetRefs(css: string): string[] {
  return [...new Set(collect(CSS_URL_RE, css).filter((n) => !n.startsWith('data:')))]
}

/**
 * html 에서 시작해 assets 그래프를 따라간 허용 파일 이름 집합.
 * readAsset 은 assets 폴더 안 파일 이름 → 내용(없으면 null). 읽기 실패(예외)면 직접 참조만 돌려준다.
 */
export async function computeAssetAllowlist(
  html: string,
  readAsset: (name: string) => Promise<string | null>
): Promise<{ allowed: Set<string>; complete: boolean }> {
  const direct = htmlAssetRefs(html)
  try {
    const allowed = new Set<string>()
    const queue = [...direct]
    while (queue.length > 0) {
      const name = queue.shift()!
      if (allowed.has(name)) continue
      const text = await readAsset(name)
      if (text === null) continue // 없는 파일은 허용하지 않는다(요청돼도 404)
      allowed.add(name)
      const ext = extname(name).toLowerCase()
      const refs = ext === '.js' || ext === '.mjs' ? jsAssetRefs(text) : ext === '.css' ? cssAssetRefs(text) : []
      for (const r of refs) if (!allowed.has(r)) queue.push(r)
      if (allowed.size > 500) throw new Error('자산 그래프가 너무 큽니다.')
    }
    return { allowed, complete: true }
  } catch {
    return { allowed: new Set(direct), complete: false }
  }
}
