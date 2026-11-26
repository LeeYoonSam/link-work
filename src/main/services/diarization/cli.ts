// 화자분리 실측 CLI — 앱과 같은 본체(runEmbeddingDiarization)를 배포 Electron 런타임에서 돌린다.
// electron 모듈을 import 하지 않는다(ELECTRON_RUN_AS_NODE=1 로 실행). 빌드 산출물: out/main/diarization-cli.js
//
// 사용: ELECTRON_RUN_AS_NODE=1 <LinkWork 바이너리> out/main/diarization-cli.js \
//         --audio <wav> --segments <json [{start_ms,end_ms}]> --model <onnx> [--num N] [--emit-segments 1]
// stdout 마지막 줄에 결과 JSON 한 줄을 쓴다. 진행 상황은 stderr.
// --emit-segments 1: 결과에 segments [{start_ms, end_ms, speaker}]를 더한다. speaker는 앱이 세그먼트에
//   화자를 붙이는 규칙(speaker-assign.ts assignSpeaker, 후처리 뒤 turn 기준)의 키다. 평가(SegLST 가설)용.
// --chunk N: 창 임베딩을 N개씩 자식 프로세스(같은 런타임·같은 cli, --embed-range)에 나눠 뽑고 클러스터링은 여기서 한다.
//   sherpa-onnx-node 가 창마다 네이티브 메모리를 돌려주지 않아 큰 모델(ERes2NetV2 약 8MB/창)이 긴 회의에서
//   메모리 부족으로 죽기 때문이다. 임베딩 값은 나누지 않을 때와 같다. 결과 JSON 끝에 chunks(자식 수)를 더한다.
// --embed-range a:b (내부용): 창 [a, b) 의 L2 임베딩만 뽑아 {from, to, maxWindowSec, embeddings} 한 줄을 쓴다.
// sherpa-onnx-node 로드 순서: LINKWORK_SHERPA_MODULE → 일반 해석(require) → 배포 앱 app.asar 내부.
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import {
  diarizeFromEmbeddings,
  emptyDiarizeResult,
  extractWindowEmbeddings,
  planDiarizationWindows,
  runEmbeddingDiarization,
  type EmbeddingDiarizeResult,
  type SherpaEmbeddingApi
} from './embedding-diarizer'
import { postprocessTurns } from './postprocess'
import { assignSpeaker, resolvePostprocessOptions } from '../speaker-assign'

const APP_SHERPA_MODULE = '/Applications/LinkWork.app/Contents/Resources/app.asar/node_modules/sherpa-onnx-node'

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1] ?? ''
      i++
    }
  }
  return out
}

function loadSherpa(): SherpaEmbeddingApi {
  const req = createRequire(__filename)
  const candidates = [process.env.LINKWORK_SHERPA_MODULE, 'sherpa-onnx-node', APP_SHERPA_MODULE].filter(
    (c): c is string => Boolean(c)
  )
  const errors: string[] = []
  for (const c of candidates) {
    try {
      const mod = req(c) as { default?: SherpaEmbeddingApi } & SherpaEmbeddingApi
      return mod.default ?? mod
    } catch (err) {
      errors.push(`${c}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`sherpa-onnx-node 를 불러오지 못했습니다.\n${errors.join('\n')}`)
}

/** --chunk N: 창을 N개씩 자식 프로세스에 맡겨 임베딩을 모은 뒤 클러스터링한다. */
function runChunked(
  args: Record<string, string>,
  segments: { start_ms: number; end_ms: number }[],
  num: number | undefined,
  chunk: number
): { result: EmbeddingDiarizeResult; chunks: number } {
  const { wins } = planDiarizationWindows({ audioPath: args.audio, segments })
  if (wins.length === 0) return { result: emptyDiarizeResult(), chunks: 0 }
  const raw: Float32Array[] = []
  let maxWindowSec = 0
  let chunks = 0
  for (let from = 0; from < wins.length; from += chunk) {
    const to = Math.min(wins.length, from + chunk)
    const child = spawnSync(
      process.execPath,
      [__filename, '--audio', args.audio, '--segments', args.segments, '--model', args.model, '--embed-range', `${from}:${to}`],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 1 << 30, encoding: 'utf8' }
    )
    if (child.status !== 0) {
      const tail = String(child.stderr ?? '').trim().split('\n').slice(-3).join(' / ')
      throw new Error(`창 ${from}:${to} 자식 프로세스 실패 (code ${child.status}, signal ${child.signal ?? '-'}) ${tail}`)
    }
    const lines = String(child.stdout).trim().split('\n')
    const part = JSON.parse(lines[lines.length - 1]) as { maxWindowSec: number; embeddings: number[][] }
    if (part.embeddings.length !== to - from) throw new Error(`창 ${from}:${to} 임베딩 수 불일치 (${part.embeddings.length})`)
    for (const e of part.embeddings) raw.push(Float32Array.from(e))
    maxWindowSec = Math.max(maxWindowSec, part.maxWindowSec)
    chunks++
    process.stderr.write(`embed ${Math.round((to / wins.length) * 100)}% (chunk ${chunks})\n`)
  }
  return { result: diarizeFromEmbeddings({ numSpeakers: num }, wins, raw, maxWindowSec), chunks }
}

/** --embed-range a:b: 창 [a, b) 의 임베딩만 뽑아 한 줄 JSON 으로 쓴다. */
function runEmbedRange(args: Record<string, string>, segments: { start_ms: number; end_ms: number }[]): void {
  const m = /^(\d+):(\d+)$/.exec(args['embed-range'])
  if (!m) throw new Error(`--embed-range 는 a:b 형식이어야 합니다: ${args['embed-range']}`)
  const { audio, wins } = planDiarizationWindows({ audioPath: args.audio, segments })
  const from = Number(m[1])
  const to = Math.min(wins.length, Number(m[2]))
  if (from > to) throw new Error(`--embed-range 범위가 잘못됐습니다: ${args['embed-range']} (창 ${wins.length}개)`)
  const r = extractWindowEmbeddings(loadSherpa(), { embModel: args.model }, audio, wins, from, to)
  process.stdout.write(
    `${JSON.stringify({ from, to, maxWindowSec: r.maxWindowSec, embeddings: r.embeddings.map((e) => Array.from(e)) })}\n`
  )
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!args.audio || !args.segments || !args.model) {
    process.stderr.write(
      'usage: diarization-cli --audio <wav> --segments <json> --model <onnx> [--num N] [--emit-segments 1] [--chunk N]\n'
    )
    process.exit(2)
  }
  const segments = (JSON.parse(readFileSync(args.segments, 'utf8')) as { start_ms: number; end_ms: number }[]).map(
    (s) => ({ start_ms: Number(s.start_ms), end_ms: Number(s.end_ms) })
  )
  if (args['embed-range'] !== undefined) {
    runEmbedRange(args, segments)
    return
  }
  const num = args.num ? Number(args.num) : undefined
  const chunk = args.chunk ? Number(args.chunk) : 0
  if (!Number.isInteger(chunk) || chunk < 0) throw new Error(`--chunk 는 0 이상의 정수여야 합니다: ${args.chunk}`)

  const t0 = Date.now()
  let lastPct = -1
  let chunks: number | undefined
  let r: EmbeddingDiarizeResult
  if (chunk > 0) {
    const c = runChunked(args, segments, num, chunk)
    r = c.result
    chunks = c.chunks
  } else {
    r = runEmbeddingDiarization(
      loadSherpa(),
      { audioPath: args.audio, embModel: args.model, segments, numSpeakers: num },
      (ratio) => {
        const pct = Math.floor(ratio * 10)
        if (pct !== lastPct) {
          lastPct = pct
          process.stderr.write(`embed ${Math.round(ratio * 100)}%\n`)
        }
      }
    )
  }
  const elapsedMs = Date.now() - t0

  const processed = postprocessTurns(
    r.turns,
    resolvePostprocessOptions({ adapter: 'sherpa', expectedSpeakers: num })
  )
  const assigned = segments.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, speaker: assignSpeaker(s, processed) }))
  const finalKeys = new Set(assigned.map((s) => s.speaker))
  const emitSegments = Boolean(args['emit-segments']) && args['emit-segments'] !== '0'

  const out: Record<string, unknown> = {
    rawClusters: r.info.rawClusters,
    speakersDiarized: r.info.speakers,
    speakersFinal: finalKeys.size,
    windows: r.info.windows,
    maxWindowSec: r.info.maxWindowSec,
    elapsedMs,
    voices: r.voices.map((v) => ({ speaker_key: v.speaker_key, speech_ms: v.speech_ms, embedding: v.embedding }))
  }
  if (emitSegments) out.segments = assigned
  if (chunks !== undefined) out.chunks = chunks
  process.stdout.write(`${JSON.stringify(out)}\n`)
}

try {
  main()
} catch (err) {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
}
