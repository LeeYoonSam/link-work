#!/usr/bin/env node
// 화자분리 앱 경로 메모리 실측 (npm run check:diar-mem).
//
// 실제 녹음으로 diarization-mem-probe(창 없는 Electron main — 앱과 같은 runChunkedDiarization + utilityProcess 워커)를
// 띄우고, 250ms 마다 ps 로 probe 를 루트로 하는 프로세스 트리의 RSS 합을 재 최대값을 판정한다.
// sherpa-onnx-node 가 창마다 네이티브 메모리를 돌려주지 않아 워커 RSS 가 창 수에 비례하므로, 앱은 창 N개마다
// 워커를 새로 띄운다(src/main/services/diarization/chunk-runner.ts). 이 스크립트가 그 상한을 확인한다.
//
// 사용: node scripts/diar-mem.mjs --id <meetingId> [--chunk 300] [--max-rss-mb 2048] [--compare-cli] [--num N]
//   --chunk        embed 워커 하나가 맡는 창 수(0 = 창 전체를 워커 하나에 — 변경 전 단일 워커와 같은 메모리 특성)
//   --max-rss-mb   프로세스 트리 최대 RSS 상한(MB). 넘으면 실패
//   --compare-cli  단일 프로세스 기존 경로(diarization-cli.js, 청크 없음)를 돌려 결과가 같은지 확인한다:
//                  segments 의 (start_ms, end_ms, speaker) 완전 일치, voices 개수·speaker_key 일치,
//                  embedding 최대 절대 차 ≤ 1e-6
// 출력: 마지막 줄에 {id, windows, chunks, peakTreeRssMb, peakSingleRssMb, peakWorkerRssMb, elapsedMs} JSON 한 줄.
// 환경 변수:
//   LINKWORK_ELECTRON_DEV  probe 를 띄울 Electron 실행 파일 (기본 node_modules 의 electron)
//   LINKWORK_ELECTRON      --compare-cli 의 cli 런타임 (기본 /Applications/LinkWork.app/Contents/MacOS/LinkWork)
//   LINKWORK_USERDATA      앱 데이터 폴더 (기본 ~/Library/Application Support/linkwork)
// 종료 코드: 0 = 상한 이하(+ compare 통과), 1 = 초과·불일치·실행 실패, 2 = 준비물 없음(DB·녹음·모델·out 빌드)
//
// DB 는 sqlite3 -readonly 로만 읽는다. 외부 의존성 없음.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USERDATA = process.env.LINKWORK_USERDATA || join(homedir(), 'Library/Application Support/linkwork')
const DB_PATH = join(USERDATA, 'linkwork.db')
const MODEL_PATH = join(USERDATA, 'models/sherpa-embedding.onnx')
const PROBE = join(REPO, 'out/main/diarization-mem-probe.js')
const WORKER = join(REPO, 'out/main/diarization-worker.js')
const CLI = join(REPO, 'out/main/diarization-cli.js')
const CLI_ELECTRON = process.env.LINKWORK_ELECTRON || '/Applications/LinkWork.app/Contents/MacOS/LinkWork'
const RUN_TIMEOUT_MS = 30 * 60_000
const SAMPLE_MS = 250
const EMB_TOL = 1e-6

function die(code, msg) {
  console.error(`[check:diar-mem] ${msg}`)
  process.exit(code)
}

function parseArgs(argv) {
  const out = { id: null, chunk: 300, maxRssMb: 2048, compareCli: false, num: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--compare-cli') {
      out.compareCli = true
      continue
    }
    if (a === '--help' || a === '-h') {
      console.log('사용: node scripts/diar-mem.mjs --id <meetingId> [--chunk 300] [--max-rss-mb 2048] [--compare-cli] [--num N]')
      process.exit(0)
    }
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a
    if (!['--id', '--chunk', '--max-rss-mb', '--num'].includes(name)) die(2, `모르는 인자: ${a}`)
    const v = String(a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[++i] ?? '')).trim()
    const n = Number(v)
    if (!v || !Number.isFinite(n)) die(2, `${name} 값이 잘못됐습니다: ${v}`)
    if (name === '--id') {
      if (!Number.isInteger(n) || n < 1) die(2, `--id 는 1 이상의 정수여야 합니다: ${v}`)
      out.id = n
    } else if (name === '--chunk') {
      if (!Number.isInteger(n) || n < 0) die(2, `--chunk 는 0 이상의 정수여야 합니다: ${v}`)
      out.chunk = n
    } else if (name === '--max-rss-mb') {
      if (!(n > 0)) die(2, `--max-rss-mb 는 양수여야 합니다: ${v}`)
      out.maxRssMb = n
    } else {
      if (!Number.isInteger(n) || n < 1) die(2, `--num 은 1 이상의 정수여야 합니다: ${v}`)
      out.num = n
    }
  }
  if (out.id == null) die(2, '--id 가 필요합니다')
  return out
}

function sqlJson(sql) {
  let out
  try {
    out = execFileSync('sqlite3', ['-readonly', '-json', DB_PATH, sql], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch (e) {
    if (e.code === 'ENOENT') die(2, 'sqlite3 명령이 없습니다.')
    die(2, `DB 조회 실패: ${(e.stderr || e.message || '').toString().trim()}`)
  }
  return out.trim() ? JSON.parse(out) : []
}

function devElectron() {
  if (process.env.LINKWORK_ELECTRON_DEV) return process.env.LINKWORK_ELECTRON_DEV
  try {
    const p = createRequire(import.meta.url)('electron')
    return typeof p === 'string' ? p : null
  } catch {
    return null
  }
}

/** ps 한 번: pid → {ppid, rssKb} */
function psSnapshot() {
  return new Promise((res) => {
    const child = spawn('ps', ['-axo', 'pid=,ppid=,rss='], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('error', () => res(new Map()))
    child.on('close', () => {
      const m = new Map()
      for (const line of out.split('\n')) {
        const p = line.trim().split(/\s+/)
        if (p.length < 3) continue
        const pid = Number(p[0])
        const ppid = Number(p[1])
        const rss = Number(p[2])
        if (Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(rss)) m.set(pid, { ppid, rss })
      }
      res(m)
    })
  })
}

/** 루트 pid 를 포함한 자손 트리의 RSS 합(KB)과 단일 프로세스 최대(KB) */
function treeRss(snap, root) {
  const children = new Map()
  for (const [pid, { ppid }] of snap) {
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  let sum = 0
  let single = 0
  const stack = [root]
  const seen = new Set()
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    const e = snap.get(pid)
    if (e) {
      sum += e.rss
      single = Math.max(single, e.rss)
    }
    for (const c of children.get(pid) ?? []) stack.push(c)
  }
  return { sum, single }
}

function run(bin, args, env, { measure = false } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let peakTree = 0
    let peakSingle = 0
    let done = false
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
    const sampler = async () => {
      while (measure && !done && child.pid) {
        const snap = await psSnapshot()
        if (done) break
        const r = treeRss(snap, child.pid)
        peakTree = Math.max(peakTree, r.sum)
        peakSingle = Math.max(peakSingle, r.single)
        await new Promise((r2) => setTimeout(r2, SAMPLE_MS))
      }
    }
    const sampling = sampler()
    const finish = (code, signal, extra = '') => {
      if (done) return
      done = true
      clearTimeout(timer)
      sampling.then(() =>
        resolvePromise({
          code,
          signal,
          stdout,
          stderr: stderr + extra,
          wallMs: Date.now() - started,
          peakTreeRssMb: Math.round(peakTree / 1024),
          peakSingleRssMb: Math.round(peakSingle / 1024)
        })
      )
    }
    child.on('error', (err) => finish(-1, null, String(err)))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

function lastJsonLine(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue
    try {
      return JSON.parse(lines[i])
    } catch {
      return null
    }
  }
  return null
}

function stderrTail(s, n = 5) {
  return s.trim().split('\n').slice(-n).join('\n    ')
}

/** probe 와 cli 결과 비교. 첫 차이를 문자열로 돌려준다(같으면 null). */
function compareResults(probe, cli) {
  const ps = probe.segments
  const cs = cli.segments
  if (!Array.isArray(ps) || !Array.isArray(cs)) return 'segments 가 없습니다'
  if (ps.length !== cs.length) return `segments 수 불일치 (probe ${ps.length}, cli ${cs.length})`
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i]
    const b = cs[i]
    if (a.start_ms !== b.start_ms || a.end_ms !== b.end_ms || a.speaker !== b.speaker) {
      return `segments[${i}] 불일치: probe ${JSON.stringify(a)} / cli ${JSON.stringify(b)}`
    }
  }
  const pv = probe.voices ?? []
  const cv = cli.voices ?? []
  if (pv.length !== cv.length) return `voices 수 불일치 (probe ${pv.length}, cli ${cv.length})`
  let maxDiff = 0
  for (let k = 0; k < pv.length; k++) {
    if (pv[k].speaker_key !== cv[k].speaker_key) return `voices[${k}].speaker_key 불일치 (${pv[k].speaker_key} / ${cv[k].speaker_key})`
    const ea = pv[k].embedding
    const eb = cv[k].embedding
    if (!Array.isArray(ea) || !Array.isArray(eb) || ea.length !== eb.length) return `voices[${k}].embedding 길이 불일치`
    for (let j = 0; j < ea.length; j++) {
      const d = Math.abs(ea[j] - eb[j])
      if (!(d <= EMB_TOL)) return `voices[${k}].embedding[${j}] 차 ${d} > ${EMB_TOL} (${ea[j]} / ${eb[j]})`
      maxDiff = Math.max(maxDiff, d)
    }
  }
  console.error(`[check:diar-mem] compare: segments ${ps.length}개 일치, voices ${pv.length}개, embedding 최대 차 ${maxDiff}`)
  return null
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const missing = []
  if (!existsSync(DB_PATH)) missing.push(`DB 없음: ${DB_PATH}`)
  if (!existsSync(MODEL_PATH)) missing.push(`임베딩 모델 없음: ${MODEL_PATH}`)
  if (!existsSync(PROBE)) missing.push(`probe 없음: ${PROBE} (npm run build 로 만든다)`)
  if (!existsSync(WORKER)) missing.push(`워커 없음: ${WORKER} (npm run build 로 만든다)`)
  const electron = devElectron()
  if (!electron || !existsSync(electron)) missing.push(`Electron 실행 파일 없음: ${electron ?? '-'} (LINKWORK_ELECTRON_DEV 로 지정)`)
  if (opts.compareCli) {
    if (!existsSync(CLI)) missing.push(`cli 없음: ${CLI} (npm run build 로 만든다)`)
    if (!existsSync(CLI_ELECTRON)) missing.push(`cli 런타임 없음: ${CLI_ELECTRON} (LINKWORK_ELECTRON 으로 지정)`)
  }
  if (missing.length) die(2, `준비물이 없습니다.\n  - ${missing.join('\n  - ')}`)

  const rows = sqlJson(`SELECT id, audio_path, duration_ms FROM meetings WHERE id = ${opts.id}`)
  const row = rows[0]
  if (!row) die(2, `회의 ${opts.id} 행 없음`)
  if (!row.audio_path) die(2, `회의 ${opts.id} audio_path 없음`)
  const audio = join(USERDATA, 'recordings', row.audio_path)
  if (!existsSync(audio)) die(2, `회의 ${opts.id} 녹음 파일 없음: ${audio}`)
  if (!audio.endsWith('.wav')) die(2, `회의 ${opts.id} 녹음이 WAV 가 아닙니다: ${audio}`)
  const segs = sqlJson(
    `SELECT start_ms, end_ms FROM meeting_segments WHERE meeting_id = ${opts.id} ORDER BY start_ms, id`
  ).map((s) => ({ start_ms: Number(s.start_ms), end_ms: Number(s.end_ms) }))
  if (segs.length === 0) die(2, `회의 ${opts.id} 전사 세그먼트가 없습니다.`)

  const tmp = mkdtempSync(join(tmpdir(), 'linkwork-diar-mem-'))
  let failed = false
  try {
    const segPath = join(tmp, `segments-${opts.id}.json`)
    writeFileSync(segPath, JSON.stringify(segs))
    const base = ['--audio', audio, '--segments', segPath, '--model', MODEL_PATH]
    if (opts.num) base.push('--num', String(opts.num))

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const probeArgs = [PROBE, ...base, '--chunk', String(opts.chunk)]
    if (opts.compareCli) probeArgs.push('--emit-segments', '1')
    process.stderr.write(
      `[check:diar-mem] 회의 ${opts.id} probe 실행 중 (세그먼트 ${segs.length}개, ${((Number(row.duration_ms) || 0) / 60000).toFixed(1)}분, chunk ${opts.chunk})...\n`
    )
    const pr = await run(electron, probeArgs, env, { measure: true })
    const out = pr.code === 0 ? lastJsonLine(pr.stdout) : null
    if (pr.code !== 0 || !out) {
      console.error(`[check:diar-mem] probe 실패 (code ${pr.code}${pr.signal ? `, ${pr.signal}` : ''})\n    ${stderrTail(pr.stderr)}`)
      process.exit(1)
    }
    const summary = {
      id: opts.id,
      windows: out.windows,
      chunks: out.chunks,
      peakTreeRssMb: pr.peakTreeRssMb,
      peakSingleRssMb: pr.peakSingleRssMb,
      peakWorkerRssMb: out.peakWorkerRssMb,
      elapsedMs: out.elapsedMs
    }
    if (!(pr.peakTreeRssMb <= opts.maxRssMb)) {
      console.error(`[check:diar-mem] 프로세스 트리 최대 RSS ${pr.peakTreeRssMb}MB > 상한 ${opts.maxRssMb}MB`)
      failed = true
    }

    if (opts.compareCli) {
      process.stderr.write('[check:diar-mem] 단일 프로세스 cli 실행 중...\n')
      const cr = await run(CLI_ELECTRON, [CLI, ...base, '--emit-segments', '1'], { ...process.env, ELECTRON_RUN_AS_NODE: '1' })
      const cout = cr.code === 0 ? lastJsonLine(cr.stdout) : null
      if (cr.code !== 0 || !cout) {
        console.error(`[check:diar-mem] cli 실패 (code ${cr.code}${cr.signal ? `, ${cr.signal}` : ''})\n    ${stderrTail(cr.stderr)}`)
        failed = true
      } else {
        const diff = compareResults(out, cout)
        if (diff) {
          console.error(`[check:diar-mem] cli 결과와 다릅니다: ${diff}`)
          failed = true
        }
        summary.compare = diff ? 'mismatch' : 'identical'
      }
    }
    console.log(JSON.stringify(summary))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => die(1, e?.stack || String(e)))
