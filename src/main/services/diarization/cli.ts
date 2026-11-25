// 화자분리 실측 CLI — 앱과 같은 본체(runEmbeddingDiarization)를 배포 Electron 런타임에서 돌린다.
// electron 모듈을 import 하지 않는다(ELECTRON_RUN_AS_NODE=1 로 실행). 빌드 산출물: out/main/diarization-cli.js
//
// 사용: ELECTRON_RUN_AS_NODE=1 <LinkWork 바이너리> out/main/diarization-cli.js \
//         --audio <wav> --segments <json [{start_ms,end_ms}]> --model <onnx> [--num N]
// stdout 마지막 줄에 결과 JSON 한 줄을 쓴다. 진행 상황은 stderr.
// sherpa-onnx-node 로드 순서: LINKWORK_SHERPA_MODULE → 일반 해석(require) → 배포 앱 app.asar 내부.
import { readFileSync } from 'fs'
import { createRequire } from 'module'
import { runEmbeddingDiarization, type SherpaEmbeddingApi } from './embedding-diarizer'
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

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!args.audio || !args.segments || !args.model) {
    process.stderr.write('usage: diarization-cli --audio <wav> --segments <json> --model <onnx> [--num N]\n')
    process.exit(2)
  }
  const segments = (JSON.parse(readFileSync(args.segments, 'utf8')) as { start_ms: number; end_ms: number }[]).map(
    (s) => ({ start_ms: Number(s.start_ms), end_ms: Number(s.end_ms) })
  )
  const num = args.num ? Number(args.num) : undefined
  const sherpa = loadSherpa()

  const t0 = Date.now()
  let lastPct = -1
  const r = runEmbeddingDiarization(
    sherpa,
    { audioPath: args.audio, embModel: args.model, segments, numSpeakers: num },
    (ratio) => {
      const pct = Math.floor(ratio * 10)
      if (pct !== lastPct) {
        lastPct = pct
        process.stderr.write(`embed ${Math.round(ratio * 100)}%\n`)
      }
    }
  )
  const elapsedMs = Date.now() - t0

  const processed = postprocessTurns(
    r.turns,
    resolvePostprocessOptions({ adapter: 'sherpa', expectedSpeakers: num })
  )
  const finalKeys = new Set(segments.map((s) => assignSpeaker(s, processed)))

  const out = {
    rawClusters: r.info.rawClusters,
    speakersDiarized: r.info.speakers,
    speakersFinal: finalKeys.size,
    windows: r.info.windows,
    maxWindowSec: r.info.maxWindowSec,
    elapsedMs,
    voices: r.voices.map((v) => ({ speaker_key: v.speaker_key, speech_ms: v.speech_ms, embedding: v.embedding }))
  }
  process.stdout.write(`${JSON.stringify(out)}\n`)
}

try {
  main()
} catch (err) {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
}
