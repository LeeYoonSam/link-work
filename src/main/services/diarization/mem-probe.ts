// 화자분리 메모리 실측 probe — 창 없는 Electron main 엔트리. 빌드 산출물: out/main/diarization-mem-probe.js
// 앱과 같은 경로(runChunkedDiarization + utilityProcess 워커)로 화자분리를 돌려 워커 최대 메모리를 잰다.
// scripts/diar-mem.mjs 가 node_modules 의 Electron 으로 띄우고 프로세스 트리 RSS 를 따로 잰다.
//
// 사용: <electron> out/main/diarization-mem-probe.js --audio <wav> --segments <json [{start_ms,end_ms}]> --model <onnx>
//         [--num N] [--chunk N(기본 300, 0=한 청크)] [--emit-segments 1]
// stdout 마지막 줄에 결과 JSON 한 줄 {windows, chunks, peakWorkerRssMb, speakersFinal, elapsedMs, voices, segments?}.
// 후처리·세그먼트 화자 붙이기는 cli.ts 와 같다(결과 비교용).
import { app, utilityProcess } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DIAR_CHUNK_WINDOWS, runChunkedDiarization, type DiarWorkerChild } from './chunk-runner'
import { postprocessTurns } from './postprocess'
import { assignSpeaker, resolvePostprocessOptions } from '../speaker-assign'

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.audio || !args.segments || !args.model) {
    throw new Error(
      'usage: diarization-mem-probe --audio <wav> --segments <json> --model <onnx> [--num N] [--chunk N] [--emit-segments 1]'
    )
  }
  const segments = (JSON.parse(readFileSync(args.segments, 'utf8')) as { start_ms: number; end_ms: number }[]).map(
    (s) => ({ start_ms: Number(s.start_ms), end_ms: Number(s.end_ms) })
  )
  const num = args.num ? Number(args.num) : undefined
  const chunk = args.chunk !== undefined && args.chunk !== '' ? Number(args.chunk) : DIAR_CHUNK_WINDOWS
  if (!Number.isInteger(chunk) || chunk < 0) throw new Error(`--chunk 는 0 이상의 정수여야 합니다: ${args.chunk}`)

  const t0 = Date.now()
  let lastPct = -1
  const r = await runChunkedDiarization({
    audioPath: args.audio,
    embModel: args.model,
    segments,
    numSpeakers: num,
    fork: () => utilityProcess.fork(join(__dirname, 'diarization-worker.js')) as unknown as DiarWorkerChild,
    chunkWindows: chunk,
    timeoutMs: 30 * 60 * 1000,
    onProgress: (ratio) => {
      const pct = Math.floor(ratio * 10)
      if (pct !== lastPct) {
        lastPct = pct
        process.stderr.write(`progress ${Math.round(ratio * 100)}%\n`)
      }
    }
  })
  const elapsedMs = Date.now() - t0

  const processed = postprocessTurns(r.turns, resolvePostprocessOptions({ adapter: 'sherpa', expectedSpeakers: num }))
  const assigned = segments.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, speaker: assignSpeaker(s, processed) }))
  const emitSegments = Boolean(args['emit-segments']) && args['emit-segments'] !== '0'
  const out: Record<string, unknown> = {
    windows: r.info.windows,
    chunks: r.chunks,
    peakWorkerRssMb: r.peakWorkerRssMb,
    speakersFinal: new Set(assigned.map((s) => s.speaker)).size,
    elapsedMs,
    voices: r.voices.map((v) => ({ speaker_key: v.speaker_key, speech_ms: v.speech_ms, embedding: v.embedding }))
  }
  if (emitSegments) out.segments = assigned
  // macOS 에서 파이프 stdout 은 비동기라 app.exit 전에 다 써질 때까지 기다린다(긴 segments 가 잘리지 않게).
  await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(out)}\n`, () => resolve()))
}

app.dock?.hide()
app
  .whenReady()
  .then(main)
  .then(
    () => app.exit(0),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
      app.exit(1)
    }
  )
