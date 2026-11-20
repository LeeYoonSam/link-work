#!/usr/bin/env node
// 문서 동기화 검사. 의존성 없이 Node 22 로 돈다.
//
//   node scripts/check-docs.mjs              문서 검사 (a)(b)(c). 오류가 있으면 종료 코드 1
//   node scripts/check-docs.mjs --changed    바뀐 코드 구역의 문서 중 함께 바뀌지 않은 문서(확인 대상)를 알려 준다
//   node scripts/check-docs.mjs --changed --json   같은 결과를 JSON 으로
//
// (a) 문서에 적힌 저장소 경로·마크다운 상대 링크가 실제로 있는지
// (b) 문서에 백틱으로 적힌 IPC 채널(`알려진접두사:이름`)이 코드에 있는지
// (c) docs/docs-map.json 의 문서가 모두 있고, docs/*.md 가 모두 매핑(또는 매핑 불필요 목록)에 있는지
//
// 바뀐 파일 목록은 git 에서 읽는다. 환경 변수 CHECK_DOCS_CHANGED_FILES(줄바꿈·쉼표 구분)를 주면 그것을 대신 쓴다.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MAP_PATH = 'docs/docs-map.json'

// ─── 공통 ────────────────────────────────────────────────────────────

const toPosix = (p) => p.split(sep).join('/')

/** glob → 정규식. `**` 는 경로 구분자를 넘고 `*`·`?` 는 넘지 않는다. `{a,b}` 를 지원한다 */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) {
        re += '\\{'
        continue
      }
      const alts = glob.slice(i + 1, end).split(',')
      re += '(?:' + alts.map((a) => globToRegExp(a).source.slice(1, -1)).join('|') + ')'
      i = end
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp('^' + re + '$')
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path))
}

/** 각 줄에 대해 펜스 코드 블록 안인지 표시한다 */
function fenceFlags(lines) {
  let inFence = false
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return true
    }
    return inFence
  })
}

// ─── (a) 경로 ────────────────────────────────────────────────────────

const PATH_ROOTS = ['src', 'scripts', 'resources', 'docs', '.claude']
// 경로 앞 글자가 단어·경로 문자면 URL 이나 더 긴 경로의 일부다
const PATH_RE =
  /(?<![\w./@-])((?:src|scripts|resources|docs|\.claude)\/[A-Za-z0-9_@.+/-]*\.[A-Za-z0-9]+)(?![A-Za-z0-9_*{/])/g
const LINK_RE = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g

/**
 * 문서 본문에서 저장소 경로 후보를 뽑는다.
 * 반환: [{ line, path, kind: 'path' | 'link' }]. 링크의 path 는 저장소 루트 기준으로 풀어 둔다.
 */
export function extractRepoPaths(text, docPath) {
  const out = []
  const lines = text.split('\n')
  const docDir = posix.dirname(docPath)
  lines.forEach((line, idx) => {
    for (const m of line.matchAll(PATH_RE)) {
      const p = m[1]
      if (p.includes('//')) continue
      out.push({ line: idx + 1, path: p, kind: 'path' })
    }
    for (const m of line.matchAll(LINK_RE)) {
      let target = m[1]
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
      target = target.split('#')[0].split('?')[0]
      if (!target) continue
      try {
        target = decodeURIComponent(target)
      } catch {
        /* 그대로 쓴다 */
      }
      const resolved = target.startsWith('/')
        ? posix.normalize(target.slice(1))
        : posix.normalize(posix.join(docDir, target))
      if (resolved.startsWith('..')) continue
      out.push({ line: idx + 1, path: resolved, kind: 'link' })
    }
  })
  return out
}

// ─── (b) IPC 채널 ────────────────────────────────────────────────────

// 채널을 첫 인자로 받는 호출. 메인→렌더러 송신 도우미(sendToMainWindow 등)도 포함한다
const CHANNEL_CALL_RE =
  /\b(?:handle|handleOnce|on|once|off|invoke|send|sendSync|sendTo\w*|removeListener|removeAllListeners|removeHandler)\(\s*(['"`])([A-Za-z][\w-]*:[A-Za-z][\w:.-]*)\1/g

/** 코드 본문에서 IPC 채널 문자열을 뽑는다 */
export function extractChannels(code) {
  const set = new Set()
  for (const m of code.matchAll(CHANNEL_CALL_RE)) set.add(m[2])
  return set
}

export function channelPrefixes(channels) {
  return new Set([...channels].map((c) => c.slice(0, c.indexOf(':'))))
}

// 이름이 대문자로 시작하면(`jira:KEY`, `task:N`) 자리표시자로 보고 후보에서 뺀다. 채널 이름은 camelCase 다
const CHANNEL_TOKEN_RE = /^([A-Za-z][\w-]*):([a-z][\w.-]*)(?:\(.*\))?$/

/**
 * 문서 본문에서 IPC 채널처럼 보이는 백틱 토큰을 뽑는다.
 * 토큰 전체가 `접두사:이름` 또는 `접두사:이름(...)` 꼴일 때만 후보다. 펜스 코드 블록 안은 보지 않는다.
 */
export function extractChannelTokens(text) {
  const out = []
  const lines = text.split('\n')
  const fenced = fenceFlags(lines)
  lines.forEach((line, idx) => {
    if (fenced[idx]) return
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const tm = m[1].trim().match(CHANNEL_TOKEN_RE)
      if (!tm) continue
      out.push({ line: idx + 1, token: `${tm[1]}:${tm[2]}`, prefix: tm[1] })
    }
  })
  return out
}

/**
 * 알려진 접두사를 쓰는데 채널 집합에 없는 토큰.
 * retired: 기능을 통째로 지워 코드에서 사라진 접두사(docs-map.json 의 retiredIpcPrefixes). 이 접두사의 토큰은 모두 오류다
 */
export function findUnknownChannels(tokens, channels, prefixes, retired = new Set()) {
  return tokens.filter(
    (t) => (prefixes.has(t.prefix) || retired.has(t.prefix)) && !channels.has(t.token)
  )
}

// ─── (c) 매핑 ────────────────────────────────────────────────────────

export function loadMap(root) {
  return JSON.parse(readFileSync(join(root, MAP_PATH), 'utf8'))
}

/** 매핑에 나오는 모든 문서 경로 */
export function mappedDocs(map) {
  const set = new Set()
  for (const area of map.areas ?? []) for (const d of area.docs ?? []) set.add(d)
  return set
}

/**
 * 매핑 대조. existing: 저장소에 있는 파일인지 판정하는 함수, docFiles: docs/*.md 목록.
 * 반환: [{ file, line, message }]
 */
export function checkMapping(map, docFiles, exists) {
  const problems = []
  const mapped = mappedDocs(map)
  const exempt = new Set(Object.keys(map.unmappedDocs ?? {}))
  for (const d of [...mapped, ...exempt]) {
    if (!exists(d)) problems.push({ file: MAP_PATH, line: 0, message: `매핑의 문서가 없다: ${d}` })
  }
  if (map.retiredIpcPrefixes !== undefined) {
    const r = map.retiredIpcPrefixes
    if (!Array.isArray(r) || r.some((p) => typeof p !== 'string' || !/^[A-Za-z][\w-]*$/.test(p)))
      problems.push({ file: MAP_PATH, line: 0, message: 'retiredIpcPrefixes 는 접두사 문자열 배열이어야 한다' })
  }
  for (const area of map.areas ?? []) {
    if (!Array.isArray(area.patterns) || area.patterns.length === 0)
      problems.push({ file: MAP_PATH, line: 0, message: `구역 "${area.name}" 에 patterns 가 없다` })
    if (!Array.isArray(area.docs))
      problems.push({ file: MAP_PATH, line: 0, message: `구역 "${area.name}" 에 docs 배열이 없다(문서가 없으면 [])` })
  }
  for (const f of docFiles) {
    if (!mapped.has(f) && !exempt.has(f))
      problems.push({
        file: f,
        line: 0,
        message: `${MAP_PATH} 에 매핑되지 않은 문서다. 구역의 docs 에 넣거나 unmappedDocs 에 사유와 함께 적는다`
      })
  }
  return problems
}

// ─── 바뀐 파일 → 확인할 문서 ─────────────────────────────────────────

/**
 * 바뀐 파일 목록을 매핑에 대어, 바뀐 코드 구역의 문서 중 함께 바뀌지 않은 문서를 돌려준다.
 * 반환: { pending: [{ doc, areas, files }], unmapped: [파일], noDocAreas: [{ area, files }] }
 */
export function pendingDocs(map, changedFiles) {
  const ignore = map.ignore ?? []
  const changed = new Set(changedFiles)
  const byDoc = new Map()
  const unmapped = []
  const noDoc = new Map()
  for (const file of changedFiles) {
    if (matchesAny(file, ignore)) continue
    // 문서 자체의 변경은 코드 변경으로 치지 않는다. docs/ 아래는 매핑 파일만 설정으로 본다
    if (file.startsWith('docs/') && file !== MAP_PATH) continue
    if (file.endsWith('.md') && !file.startsWith('.claude/')) continue
    const areas = (map.areas ?? []).filter((a) => matchesAny(file, a.patterns ?? []))
    if (areas.length === 0) {
      unmapped.push(file)
      continue
    }
    for (const area of areas) {
      if ((area.docs ?? []).length === 0) {
        if (!noDoc.has(area.name)) noDoc.set(area.name, [])
        noDoc.get(area.name).push(file)
      }
      for (const doc of area.docs ?? []) {
        if (doc === file) continue
        if (!byDoc.has(doc)) byDoc.set(doc, { doc, areas: new Set(), files: new Set() })
        const e = byDoc.get(doc)
        e.areas.add(area.name)
        e.files.add(file)
      }
    }
  }
  const pending = [...byDoc.values()]
    .filter((e) => !changed.has(e.doc))
    .map((e) => ({ doc: e.doc, areas: [...e.areas], files: [...e.files].sort() }))
    .sort((a, b) => a.doc.localeCompare(b.doc))
  return {
    pending,
    unmapped: unmapped.sort(),
    noDocAreas: [...noDoc.entries()].map(([area, files]) => ({ area, files: files.sort() }))
  }
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** git 에서 바뀐 파일: 스테이징·미스테이징·추적 안 된 새 파일 + 업스트림에 없는 커밋(@{u}..HEAD) */
export function gitChangedFiles(root) {
  const files = new Set()
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const parts = status.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    const code = entry.slice(0, 2)
    files.add(entry.slice(3))
    // 이름 바꾸기·복사는 다음 칸에 원래 이름이 온다
    if (code.includes('R') || code.includes('C')) {
      i++
      if (parts[i]) files.add(parts[i])
    }
  }
  let upstream = null
  try {
    upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim()
  } catch {
    upstream = null
  }
  if (upstream) {
    try {
      for (const f of git(root, ['diff', '--name-only', '@{u}..HEAD']).split('\n')) if (f) files.add(f)
    } catch {
      /* 업스트림을 못 읽으면 작업 트리만 본다 */
    }
  }
  return [...files].filter(Boolean).sort()
}

export function changedFiles(root, env = process.env) {
  const injected = env.CHECK_DOCS_CHANGED_FILES
  if (injected !== undefined) {
    return injected
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return gitChangedFiles(root)
}

// ─── 저장소 대상 실행 ────────────────────────────────────────────────

function listFiles(root, dir, filter) {
  const abs = join(root, dir)
  if (!existsSync(abs)) return []
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) {
        if (name === 'node_modules') continue
        walk(p)
      } else {
        const rel = toPosix(relative(root, p))
        if (filter(rel)) out.push(rel)
      }
    }
  }
  walk(abs)
  return out.sort()
}

/** 검사 대상 문서 목록 */
export function docFilesToScan(root) {
  const files = []
  for (const f of ['README.md', 'CLAUDE.md']) if (existsSync(join(root, f))) files.push(f)
  files.push(...listFiles(root, 'docs', (p) => p.endsWith('.md') && !p.startsWith('docs/references/')))
  files.push(...listFiles(root, '.claude/agents', (p) => p.endsWith('.md')))
  files.push(...listFiles(root, '.claude/skills', (p) => p.endsWith('/SKILL.md')))
  return files
}

/** docs 바로 아래의 .md (매핑 대조 대상) */
export function topLevelDocs(root) {
  return listFiles(root, 'docs', (p) => /^docs\/[^/]+\.md$/.test(p))
}

/** src/main 과 src/preload 에서 IPC 채널 집합을 만든다 */
export function collectChannels(root) {
  const files = [
    ...listFiles(root, 'src/main', (p) => /\.(ts|js|mjs)$/.test(p) && !/\.test\./.test(p)),
    ...listFiles(root, 'src/preload', (p) => /\.(ts|js|mjs)$/.test(p) && !/\.test\./.test(p))
  ]
  const channels = new Set()
  for (const f of files) for (const c of extractChannels(readFileSync(join(root, f), 'utf8'))) channels.add(c)
  return channels
}

/** (a)(b)(c) 검사. 반환: [{ check, file, line, message }] */
export function runChecks(root = DEFAULT_ROOT) {
  const problems = []
  const exists = (p) => existsSync(join(root, p))
  const channels = collectChannels(root)
  const prefixes = channelPrefixes(channels)

  let map = null
  try {
    map = loadMap(root)
  } catch (err) {
    problems.push({ check: 'c', file: MAP_PATH, line: 0, message: `매핑 파일을 읽지 못했다: ${err.message}` })
  }
  const retired = new Set(Array.isArray(map?.retiredIpcPrefixes) ? map.retiredIpcPrefixes : [])

  for (const doc of docFilesToScan(root)) {
    const text = readFileSync(join(root, doc), 'utf8')
    const seen = new Set()
    for (const ref of extractRepoPaths(text, doc)) {
      if (ref.path.startsWith('docs/references/')) continue
      if (ref.kind === 'path' && !PATH_ROOTS.some((r) => ref.path.startsWith(r + '/'))) continue
      if (exists(ref.path)) continue
      const key = `${ref.line}:${ref.path}`
      if (seen.has(key)) continue
      seen.add(key)
      problems.push({
        check: 'a',
        file: doc,
        line: ref.line,
        message: `${ref.kind === 'link' ? '링크 대상이' : '경로가'} 없다: ${ref.path}`
      })
    }
    for (const t of findUnknownChannels(extractChannelTokens(text), channels, prefixes, retired)) {
      const why = prefixes.has(t.prefix) ? '코드에 없는 IPC 채널' : '지운 IPC 네임스페이스의 채널'
      problems.push({ check: 'b', file: doc, line: t.line, message: `${why}: ${t.token}` })
    }
  }

  if (!map) return problems
  for (const p of checkMapping(map, topLevelDocs(root), exists)) problems.push({ check: 'c', ...p })
  return problems
}

/** --changed 결과 */
export function runChanged(root = DEFAULT_ROOT, env = process.env) {
  const map = loadMap(root)
  const files = changedFiles(root, env)
  return { changed: files, ...pendingDocs(map, files) }
}

export function formatProblems(problems) {
  return problems
    .map((p) => `  [${p.check}] ${p.file}${p.line ? `:${p.line}` : ''} — ${p.message}`)
    .join('\n')
}

export function formatPending(result) {
  const lines = []
  for (const p of result.pending) {
    lines.push(`  - ${p.doc}  (${p.areas.join(', ')})`)
    for (const f of p.files.slice(0, 8)) lines.push(`      ← ${f}`)
    if (p.files.length > 8) lines.push(`      ← 외 ${p.files.length - 8}개`)
  }
  return lines.join('\n')
}

// ─── CLI ─────────────────────────────────────────────────────────────

function main(argv) {
  const args = new Set(argv)
  const root = DEFAULT_ROOT
  if (args.has('--changed')) {
    const result = runChanged(root)
    if (args.has('--json')) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      return 0
    }
    if (result.changed.length === 0) {
      console.log('바뀐 파일이 없다.')
      return 0
    }
    if (result.pending.length === 0) {
      console.log(`바뀐 파일 ${result.changed.length}개. 함께 확인할 문서가 모두 바뀌었거나 대응 문서가 없다.`)
    } else {
      console.log(`바뀐 코드에 대응하는데 함께 바뀌지 않은 문서 ${result.pending.length}개 (확인 대상):`)
      console.log(formatPending(result))
    }
    if (result.unmapped.length) console.log(`매핑 구역 밖의 바뀐 파일: ${result.unmapped.join(', ')}`)
    return 0
  }
  const problems = runChecks(root)
  if (args.has('--json')) {
    process.stdout.write(JSON.stringify({ problems }, null, 2) + '\n')
    return problems.length ? 1 : 0
  }
  if (problems.length === 0) {
    console.log('문서 검사 통과: 경로·IPC 채널·매핑 오류 없음.')
    return 0
  }
  console.error(`문서 검사 오류 ${problems.length}건:`)
  console.error(formatProblems(problems))
  return 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
