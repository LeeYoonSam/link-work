#!/usr/bin/env node
// 화자 분리 실측 회귀 검사 (npm run check:diar).
//
// 실제 녹음으로 diarization-cli 를 배포 Electron 런타임(ELECTRON_RUN_AS_NODE=1)에서 돌려
// 화자 수·창 길이·처리 시간·회의 간 목소리 매칭을 단언한다. 기준은 docs/MEETING_RECORDING.md §5-3·§5-4.
//
// 사용: node scripts/diar-regress.mjs [--only 53,50] [--verbose] [--model <onnx>] [--tag <이름>] [--num N]
//                                    [--dump-hyp <dir>] [--chunk N]
//   --model     임베딩 모델(기본: 앱 모델 <userData>/models/sherpa-embedding.onnx). 기본 모델이 아니면
//               회의 간 목소리 매칭(CROSS 0.70/0.62) 단언은 '참고'로만 출력하고 판정에서 뺀다.
//               화자 수·창 길이·처리 시간 단언은 그대로 판정한다.
//   --tag       가설 파일 이름의 모델 태그(기본: 모델 파일명에서 만든 짧은 이름, 앱 모델은 campplus)
//   --num       화자 수를 고정해 cli 에 넘긴다(평가 oracle 모드용)
//   --chunk     창 임베딩을 N개씩 cli 자식 프로세스에 나눠 뽑는다(cli --chunk N). sherpa-onnx-node 가 창마다
//               네이티브 메모리를 돌려주지 않아 큰 후보 모델이 긴 회의에서 죽는 것을 막는다. 처리 시간에 자식
//               프로세스 기동·모델 로드가 더해진다. 기본 0(나누지 않음, 앱과 같은 경로)
//   --dump-hyp  (--only 에 기대값이 없는 회의도 넣을 수 있다 — 화자 수 단언 없이 돌린다)
//               회의마다 <dir>/hyp_<id>_<tag>.json (SegLST {meeting_id, duration_ms, segments:[{start_ms,end_ms,speaker}]})
//               과 <dir>/stats_<id>_<tag>.json (화자 수·창·처리 시간·화자 목소리)을 쓴다(cli --emit-segments 1).
// 환경 변수:
//   LINKWORK_ELECTRON  Electron 실행 파일 (기본 /Applications/LinkWork.app/Contents/MacOS/LinkWork)
//   LINKWORK_DIAR_CLI  cli 번들 (기본 <repo>/out/main/diarization-cli.js)
//   LINKWORK_USERDATA  앱 데이터 폴더 (기본 ~/Library/Application Support/linkwork)
// 종료 코드: 0 = 전부 통과, 1 = 단언 실패(또는 cli 실행 실패), 2 = 준비물 없음(녹음·DB·바이너리·cli·모델)
//
// DB 는 sqlite3 -readonly 로만 읽는다. 외부 의존성 없음.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const USERDATA = process.env.LINKWORK_USERDATA || join(homedir(), 'Library/Application Support/linkwork')
const DB_PATH = join(USERDATA, 'linkwork.db')
const DEFAULT_MODEL_PATH = join(USERDATA, 'models/sherpa-embedding.onnx')
/** 알려진 모델 파일명 → 짧은 태그 */
const MODEL_TAGS = {
  'sherpa-embedding.onnx': 'campplus',
  '3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx': 'eres2netv2',
  'wespeaker_en_voxceleb_resnet34_LM.onnx': 'wespeaker_r34lm'
}
const ELECTRON = process.env.LINKWORK_ELECTRON || '/Applications/LinkWork.app/Contents/MacOS/LinkWork'
const CLI = resolve(REPO, process.env.LINKWORK_DIAR_CLI || 'out/main/diarization-cli.js')

/** 회의별 기대값. speakers: 정확한 화자 수 또는 [min,max]. maxElapsedMs: 처리 시간 상한 */
const CASES = [
  { id: 53, speakers: 2 },
  { id: 50, speakers: 2 },
  { id: 40, speakers: 2 },
  { id: 45, speakers: 2 },
  { id: 46, speakers: 2 },
  { id: 51, speakers: [2, 8], maxElapsedMs: 180_000 }
]
const MAX_WINDOW_SEC = 2.25
/** 회의 간 목소리 매칭: PROBE 회의의 두 주요 화자를 PROFILE 회의 화자와 대조 */
const CROSS = { probe: 53, profile: 50, minMatch: 0.7, maxCross: 0.62 }
const RUN_TIMEOUT_MS = 15 * 60_000

function parseArgs(argv) {
  const out = { only: null, verbose: false, model: null, tag: null, num: null, dumpHyp: null, chunk: 0 }
  const valueOf = (a, i) => (a.includes('=') ? { v: a.slice(a.indexOf('=') + 1), i } : { v: argv[i + 1], i: i + 1 })
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a
    if (a === '--verbose' || a === '-v') out.verbose = true
    else if (name === '--model' || name === '--tag' || name === '--dump-hyp' || name === '--num' || name === '--chunk') {
      const r = valueOf(a, i)
      i = r.i
      const v = String(r.v ?? '').trim()
      if (!v) die(2, `${name} 값이 비었습니다`)
      if (name === '--model') out.model = resolve(v)
      else if (name === '--tag') {
        if (!/^[A-Za-z0-9_.-]+$/.test(v)) die(2, `--tag 는 영숫자·_.- 만 쓸 수 있습니다: ${v}`)
        out.tag = v
      } else if (name === '--dump-hyp') out.dumpHyp = resolve(v)
      else if (name === '--chunk') {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 0) die(2, `--chunk 는 0 이상의 정수여야 합니다: ${v}`)
        out.chunk = n
      } else {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1) die(2, `--num 은 1 이상의 정수여야 합니다: ${v}`)
        out.num = n
      }
    }
    else if (a === '--only' || a.startsWith('--only=')) {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]
      out.only = new Set(
        String(v ?? '')
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0)
      )
      if (out.only.size === 0) die(2, `--only 값이 비었거나 잘못됐습니다: ${v}`)
    } else if (a === '--help' || a === '-h') {
      console.log(
        '사용: node scripts/diar-regress.mjs [--only 53,50] [--verbose] [--model <onnx>] [--tag <이름>] [--num N] [--dump-hyp <dir>] [--chunk N]'
      )
      process.exit(0)
    } else die(2, `모르는 인자: ${a}`)
  }
  return out
}

function die(code, msg) {
  console.error(`[check:diar] ${msg}`)
  process.exit(code)
}

function sqlJson(sql) {
  let out
  try {
    out = execFileSync('sqlite3', ['-readonly', '-json', DB_PATH, sql], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    })
  } catch (e) {
    if (e.code === 'ENOENT') die(2, 'sqlite3 명령이 없습니다.')
    die(2, `DB 조회 실패: ${(e.stderr || e.message || '').toString().trim()}`)
  }
  return out.trim() ? JSON.parse(out) : []
}

function runCli(args) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const child = spawn(ELECTRON, [CLI, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ code: -1, signal: null, stdout, stderr: stderr + String(err), wallMs: Date.now() - started })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr, wallMs: Date.now() - started })
    })
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

function l2(v) {
  let s = 0
  for (const x of v) s += x * x
  const n = Math.sqrt(s) || 1
  return v.map((x) => x / n)
}

function cos(a, b) {
  let d = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) d += a[i] * b[i]
  return d
}

function checkSpeakers(expect, n) {
  if (expect == null) return true
  return Array.isArray(expect) ? n >= expect[0] && n <= expect[1] : n === expect
}

function fmtExpect(expect) {
  if (expect == null) return '-'
  return Array.isArray(expect) ? `${expect[0]}~${expect[1]}` : `=${expect}`
}

/** probe 화자 2명 × profile 화자들의 최적 1:1 매칭(유사도 합 최대) */
function crossMatch(probeVoices, profileVoices) {
  const probe = [...probeVoices].sort((a, b) => b.speech_ms - a.speech_ms).slice(0, 2)
  if (probe.length < 2 || profileVoices.length < 2) {
    return { ok: false, reason: `화자 목소리가 부족합니다(probe ${probe.length}, profile ${profileVoices.length})` }
  }
  const P = probe.map((v) => l2(v.embedding))
  const Q = profileVoices.map((v) => l2(v.embedding))
  const S = P.map((p) => Q.map((q) => cos(p, q)))
  let best = null
  for (let i = 0; i < Q.length; i++) {
    for (let j = 0; j < Q.length; j++) {
      if (i === j) continue
      const sum = S[0][i] + S[1][j]
      if (!best || sum > best.sum) best = { sum, pick: [i, j] }
    }
  }
  const [i, j] = best.pick
  const matched = [S[0][i], S[1][j]]
  const cross = [S[0][j], S[1][i]]
  const fails = []
  matched.forEach((s, k) => {
    if (s < CROSS.minMatch) fails.push(`매칭 ${probe[k].speaker_key}→${profileVoices[best.pick[k]].speaker_key} ${s.toFixed(3)} < ${CROSS.minMatch}`)
  })
  cross.forEach((s, k) => {
    if (s > CROSS.maxCross) fails.push(`교차 ${probe[k].speaker_key}→${profileVoices[best.pick[1 - k]].speaker_key} ${s.toFixed(3)} > ${CROSS.maxCross}`)
  })
  return {
    ok: fails.length === 0,
    reason: fails.join('; '),
    pairs: probe.map((v, k) => ({
      probe: v.speaker_key,
      profile: profileVoices[best.pick[k]].speaker_key,
      match: matched[k],
      cross: cross[k]
    })),
    matrix: S.map((row, k) => ({ probe: probe[k].speaker_key, sims: row }))
  }
}

/** 모델 파일명 → 가설 파일 태그 */
function modelTag(modelPath, isDefaultModel) {
  if (isDefaultModel) return 'campplus'
  const file = basename(modelPath)
  return MODEL_TAGS[file] ?? (file.replace(/\.onnx$/i, '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 40) || 'model')
}

/** 회의 하나의 SegLST 가설과 실행 통계를 쓴다 */
function dumpHyp(dir, tag, c, out) {
  mkdirSync(dir, { recursive: true })
  const segments = Array.isArray(out.segments)
    ? out.segments.map((s) => ({ start_ms: Number(s.start_ms), end_ms: Number(s.end_ms), speaker: String(s.speaker) }))
    : []
  writeFileSync(
    join(dir, `hyp_${c.id}_${tag}.json`),
    JSON.stringify({ meeting_id: c.id, duration_ms: c.durationMs, segments })
  )
  const { segments: _omit, ...stats } = out
  writeFileSync(join(dir, `stats_${c.id}_${tag}.json`), JSON.stringify({ meeting_id: c.id, tag, ...stats }))
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const MODEL_PATH = opts.model ?? DEFAULT_MODEL_PATH
  const isDefaultModel = resolve(MODEL_PATH) === resolve(DEFAULT_MODEL_PATH)
  const tag = opts.tag ?? modelTag(MODEL_PATH, isDefaultModel)
  let cases = opts.only ? CASES.filter((c) => opts.only.has(c.id)) : CASES
  if (opts.only && opts.dumpHyp) {
    // 가설 덤프(평가)에서는 기대값이 없는 회의도 돌린다(화자 수 단언 없음, 창 길이 단언은 유지)
    const known = new Set(CASES.map((c) => c.id))
    const extra = [...opts.only].filter((id) => !known.has(id)).map((id) => ({ id, speakers: null }))
    cases = [...cases, ...extra]
  }
  if (cases.length === 0) die(2, `--only 에 해당하는 검사 회의가 없습니다. 가능: ${CASES.map((c) => c.id).join(',')}`)

  // ── 준비물 확인 (없으면 exit 2) ──
  const missing = []
  if (!existsSync(DB_PATH)) missing.push(`DB 없음: ${DB_PATH}`)
  if (!existsSync(ELECTRON)) missing.push(`Electron 실행 파일 없음: ${ELECTRON} (LINKWORK_ELECTRON 으로 지정)`)
  if (!existsSync(CLI)) missing.push(`cli 없음: ${CLI} (npm run build 로 만든다, LINKWORK_DIAR_CLI 로 지정)`)
  if (!existsSync(MODEL_PATH)) missing.push(`임베딩 모델 없음: ${MODEL_PATH}`)
  if (missing.length) die(2, `준비물이 없습니다.\n  - ${missing.join('\n  - ')}`)

  const ids = cases.map((c) => c.id)
  const rows = sqlJson(`SELECT id, audio_path, duration_ms FROM meetings WHERE id IN (${ids.join(',')})`)
  const byId = new Map(rows.map((r) => [Number(r.id), r]))
  const prepared = []
  for (const c of cases) {
    const row = byId.get(c.id)
    if (!row) missing.push(`회의 ${c.id} 행 없음`)
    else if (!row.audio_path) missing.push(`회의 ${c.id} audio_path 없음`)
    else {
      const audio = join(USERDATA, 'recordings', row.audio_path)
      if (!existsSync(audio)) missing.push(`회의 ${c.id} 녹음 파일 없음: ${audio}`)
      else if (!audio.endsWith('.wav')) missing.push(`회의 ${c.id} 녹음이 WAV 가 아닙니다: ${audio}`)
      else prepared.push({ ...c, audio, durationMs: Number(row.duration_ms) || 0 })
    }
  }
  if (missing.length) die(2, `준비물이 없습니다.\n  - ${missing.join('\n  - ')}`)

  const tmp = mkdtempSync(join(tmpdir(), 'linkwork-diar-'))
  const results = new Map()
  let failed = false
  try {
    for (const c of prepared) {
      const segs = sqlJson(
        `SELECT start_ms, end_ms FROM meeting_segments WHERE meeting_id = ${c.id} ORDER BY start_ms, id`
      ).map((s) => ({ start_ms: Number(s.start_ms), end_ms: Number(s.end_ms) }))
      if (segs.length === 0) die(2, `회의 ${c.id} 전사 세그먼트가 없습니다.`)
      const segPath = join(tmp, `segments-${c.id}.json`)
      writeFileSync(segPath, JSON.stringify(segs))
      process.stderr.write(`[check:diar] 회의 ${c.id} 실행 중 (세그먼트 ${segs.length}개, ${(c.durationMs / 60000).toFixed(1)}분)...\n`)
      const cliArgs = ['--audio', c.audio, '--segments', segPath, '--model', MODEL_PATH]
      if (opts.num) cliArgs.push('--num', String(opts.num))
      if (opts.dumpHyp) cliArgs.push('--emit-segments', '1')
      if (opts.chunk > 0) cliArgs.push('--chunk', String(opts.chunk))
      const run = await runCli(cliArgs)
      const out = run.code === 0 ? lastJsonLine(run.stdout) : null
      const r = { case: c, segs: segs.length, run, out, fails: [] }
      if (run.code !== 0) {
        r.fails.push(`cli 종료 코드 ${run.code}${run.signal ? ` (${run.signal})` : ''}`)
        const tail = run.stderr.trim().split('\n').slice(-5).join('\n    ')
        if (tail) r.fails.push(`stderr:\n    ${tail}`)
      } else if (!out) {
        r.fails.push('stdout 마지막 줄 JSON 을 읽지 못했습니다')
      } else {
        if (!checkSpeakers(c.speakers, out.speakersFinal)) r.fails.push(`speakersFinal ${out.speakersFinal} (기대 ${fmtExpect(c.speakers)})`)
        if (!(out.maxWindowSec <= MAX_WINDOW_SEC)) r.fails.push(`maxWindowSec ${out.maxWindowSec} > ${MAX_WINDOW_SEC}`)
        if (c.maxElapsedMs && !(out.elapsedMs <= c.maxElapsedMs)) r.fails.push(`elapsedMs ${out.elapsedMs} > ${c.maxElapsedMs}`)
        if (!Array.isArray(out.voices)) r.fails.push('voices 배열이 없습니다')
        if (opts.dumpHyp) dumpHyp(opts.dumpHyp, tag, c, out)
      }
      if (r.fails.length) failed = true
      results.set(c.id, r)
      if (opts.verbose && run.stderr.trim()) process.stderr.write(run.stderr)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  // ── 회의별 표 ──
  const header = ['회의', '길이(분)', '세그', '창', '최대창(s)', '원시', '분리', '최종', '기대', '시간(s)', '결과']
  const table = [header]
  for (const r of results.values()) {
    const o = r.out || {}
    table.push([
      String(r.case.id),
      (r.case.durationMs / 60000).toFixed(1),
      String(r.segs),
      o.windows ?? '-',
      o.maxWindowSec != null ? Number(o.maxWindowSec).toFixed(2) : '-',
      o.rawClusters ?? '-',
      o.speakersDiarized ?? '-',
      o.speakersFinal ?? '-',
      fmtExpect(r.case.speakers),
      o.elapsedMs != null ? (o.elapsedMs / 1000).toFixed(1) : (r.run.wallMs / 1000).toFixed(1),
      r.fails.length ? 'FAIL' : 'ok'
    ].map(String))
  }
  const widths = header.map((_, k) => Math.max(...table.map((row) => [...row[k]].length)))
  for (const row of table) console.log(row.map((cell, k) => cell.padStart(widths[k])).join('  '))
  for (const r of results.values()) for (const f of r.fails) console.log(`  회의 ${r.case.id}: ${f}`)

  // ── 회의 간 목소리 매칭 ──
  const probe = results.get(CROSS.probe)
  const profile = results.get(CROSS.profile)
  if (probe && profile) {
    if (!probe.out?.voices || !profile.out?.voices) {
      console.log(`목소리 매칭 ${CROSS.probe}→${CROSS.profile}: FAIL (cli 결과 없음)`)
      if (isDefaultModel) failed = true
    } else {
      const m = crossMatch(probe.out.voices, profile.out.voices)
      if (m.pairs) {
        console.log(`목소리 매칭 ${CROSS.probe}→${CROSS.profile} (매칭 ≥${CROSS.minMatch}, 교차 ≤${CROSS.maxCross}):`)
        for (const p of m.pairs) console.log(`  ${CROSS.probe}.${p.probe} → ${CROSS.profile}.${p.profile}  매칭 ${p.match.toFixed(3)}  교차 ${p.cross.toFixed(3)}`)
        if (opts.verbose) for (const row of m.matrix) console.log(`  ${row.probe}: [${row.sims.map((s) => s.toFixed(3)).join(', ')}]`)
      }
      if (isDefaultModel) {
        console.log(`목소리 매칭 결과: ${m.ok ? 'ok' : `FAIL — ${m.reason}`}`)
        if (!m.ok) failed = true
      } else {
        // 기준값은 앱 모델(CAM++)로 정한 것이라 다른 모델에는 판정하지 않는다
        console.log(`목소리 매칭 결과(참고, 판정 제외 — 기본 모델 아님): ${m.ok ? 'ok' : `기준 밖 — ${m.reason}`}`)
      }
    }
  } else {
    console.log(`목소리 매칭 ${CROSS.probe}→${CROSS.profile}: 건너뜀(--only 에 두 회의가 모두 있어야 한다)`)
  }

  console.log(failed ? 'check:diar 실패' : 'check:diar 통과')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => die(1, e?.stack || String(e)))
