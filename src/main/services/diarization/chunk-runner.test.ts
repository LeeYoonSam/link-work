import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { planChunks, runChunkedDiarization, type DiarWorkerChild } from './chunk-runner'
import { diarizeFromEmbeddings, planWindowsFromWav } from './embedding-diarizer'
import type { DiarWorkerRequest, DiarWorkerResponse } from './worker'

const SR = 16000
const dir = mkdtempSync(join(tmpdir(), 'diar-chunk-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => vi.useRealTimers())

function writeWav(path: string, samples: number): void {
  const data = Buffer.alloc(samples * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(SR, 24)
  h.writeUInt32LE(SR * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}

// 세그먼트 1개(1초)가 창 1개. 창 650개를 만든다.
const N_WIN = 650
const audioPath = join(dir, 'long.wav')
writeWav(audioPath, (N_WIN + 1) * SR)
const segments = Array.from({ length: N_WIN }, (_, i) => ({ start_ms: i * 1000, end_ms: i * 1000 + 1000 }))

/** 창 인덱스 기반 결정론적 192차원 L2 벡터 — 앞 절반은 화자 A 방향, 뒤 절반은 화자 B 방향. */
function embOf(idx: number): number[] {
  const v = new Array<number>(192).fill(0)
  v[idx < N_WIN / 2 ? 0 : 1] = 1
  v[2 + (idx % 50)] = 0.05
  const n = Math.hypot(...v)
  return v.map((x) => Float32Array.from([x / n])[0])
}

interface FakeOpts {
  /** 청크 index → 행동 */
  behave?: (call: number, req: DiarWorkerRequest, child: FakeChild) => 'reply' | 'hang' | 'exit' | 'short'
}

class FakeChild implements DiarWorkerChild {
  msgL: ((m: DiarWorkerResponse) => void)[] = []
  exitL: ((c: number) => void)[] = []
  killed = 0
  req: DiarWorkerRequest | undefined
  constructor(
    private readonly call: number,
    private readonly opts: FakeOpts,
    private readonly winIndex: (w: { s: number }) => number
  ) {}
  on(event: 'message' | 'exit', l: ((m: DiarWorkerResponse) => void) | ((c: number) => void)): unknown {
    if (event === 'message') this.msgL.push(l as (m: DiarWorkerResponse) => void)
    else this.exitL.push(l as (c: number) => void)
    return this
  }
  kill(): unknown {
    this.killed++
    return true
  }
  emit(m: DiarWorkerResponse): void {
    for (const l of this.msgL) l(m)
  }
  exit(code: number): void {
    for (const l of this.exitL) l(code)
  }
  postMessage(req: DiarWorkerRequest): void {
    this.req = req
    const how = this.opts.behave?.(this.call, req, this) ?? 'reply'
    queueMicrotask(() => {
      if (how === 'hang') return
      if (how === 'exit') {
        this.exit(9)
        return
      }
      if (req.op === 'embed') {
        const n = req.wins.length
        this.emit({ type: 'progress', done: Math.floor(n / 2) })
        this.emit({ type: 'progress', done: n })
        let embeddings = req.wins.map((w) => embOf(this.winIndex(w)))
        if (how === 'short') embeddings = embeddings.slice(1)
        this.emit({ type: 'embedded', embeddings, maxWindowSec: 1, peakRssMb: 100 + this.call })
      } else {
        const result = diarizeFromEmbeddings(
          { numSpeakers: req.numSpeakers, maxSpeakers: req.maxSpeakers },
          req.wins,
          req.embeddings.map((e) => Float32Array.from(e)),
          req.maxWindowSec
        )
        this.emit({ type: 'clustered', result, peakRssMb: 50 })
      }
    })
  }
}

function makeFork(opts: FakeOpts = {}): { fork: () => DiarWorkerChild; children: FakeChild[] } {
  const children: FakeChild[] = []
  const winIndex = (w: { s: number }): number => Math.round(w.s)
  return {
    children,
    fork: () => {
      const c = new FakeChild(children.length, opts, winIndex)
      children.push(c)
      return c
    }
  }
}

const base = { audioPath, embModel: 'x', segments, timeoutMs: 60_000 }

describe('planChunks', () => {
  it('size 개씩 나누고 0 이하면 한 청크', () => {
    expect(planChunks(650, 300)).toEqual([
      [0, 300],
      [300, 600],
      [600, 650]
    ])
    expect(planChunks(650, 0)).toEqual([[0, 650]])
    expect(planChunks(0, 300)).toEqual([])
  })
})

describe('runChunkedDiarization', () => {
  it('(a) 창 650개를 300·300·50 으로 나눠 임베딩하고 cluster 1회 — 직접 클러스터링과 같다', async () => {
    const { fork, children } = makeFork()
    const r = await runChunkedDiarization({ ...base, fork, chunkWindows: 300 })
    const embeds = children.filter((c) => c.req?.op === 'embed')
    const clusters = children.filter((c) => c.req?.op === 'cluster')
    expect(embeds.map((c) => (c.req as { wins: unknown[] }).wins.length)).toEqual([300, 300, 50])
    expect(clusters).toHaveLength(1)
    for (const c of children) expect(c.killed).toBeGreaterThan(0)
    const wins = planWindowsFromWav(audioPath, segments)
    expect(wins).toHaveLength(N_WIN)
    const creq = clusters[0].req as Extract<DiarWorkerRequest, { op: 'cluster' }>
    expect(creq.embeddings).toEqual(wins.map((_, i) => embOf(i)))
    const direct = diarizeFromEmbeddings({}, wins, wins.map((_, i) => Float32Array.from(embOf(i))), 1)
    const { chunks, peakWorkerRssMb, ...rest } = r
    expect(rest).toEqual(direct)
    expect(chunks).toBe(3)
    expect(peakWorkerRssMb).toBe(102)
    expect(r.info.speakers).toBe(2)
  })

  it('(b) 세그먼트가 없으면 fork 없이 빈 결과', async () => {
    const { fork, children } = makeFork()
    const r = await runChunkedDiarization({ ...base, segments: [], fork })
    expect(children).toHaveLength(0)
    expect(r.turns).toEqual([])
    expect(r.voices).toEqual([])
    expect(r.chunks).toBe(0)
  })

  it('시작 전에 취소됐으면 fork 없이 AbortError', async () => {
    const { fork, children } = makeFork()
    const ac = new AbortController()
    ac.abort()
    await expect(runChunkedDiarization({ ...base, fork, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(children).toHaveLength(0)
  })

  it('(c) 두 번째 청크 중 취소 — 현재 워커 kill, AbortError, 이후 fork 없음', async () => {
    const ac = new AbortController()
    const { fork, children } = makeFork({
      behave: (call) => {
        if (call === 1) {
          queueMicrotask(() => ac.abort())
          return 'hang'
        }
        return 'reply'
      }
    })
    const p = runChunkedDiarization({ ...base, fork, chunkWindows: 300, signal: ac.signal })
    await expect(p).rejects.toMatchObject({ name: 'AbortError', message: '화자분리가 취소되었습니다.' })
    expect(children).toHaveLength(2)
    expect(children[1].killed).toBeGreaterThan(0)
  })

  it('(d) 워커가 응답 없이 종료하면 비정상 종료 오류(창 범위 포함)', async () => {
    const { fork } = makeFork({ behave: (call) => (call === 1 ? 'exit' : 'reply') })
    const err = await runChunkedDiarization({ ...base, fork, chunkWindows: 300 }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('비정상 종료')
    expect((err as Error).message).toContain('300:600')
  })

  it('cluster 워커가 종료하면 창 cluster 로 알린다', async () => {
    const { fork } = makeFork({ behave: (_c, req) => (req.op === 'cluster' ? 'exit' : 'reply') })
    await expect(runChunkedDiarization({ ...base, fork, chunkWindows: 300 })).rejects.toThrow(/창 cluster/)
  })

  it('워커 error 응답은 그 문구로 reject', async () => {
    const { fork } = makeFork({
      behave: (_c, _r, child) => {
        queueMicrotask(() => child.emit({ type: 'error', error: '모델 로드 실패' }))
        return 'hang'
      }
    })
    await expect(runChunkedDiarization({ ...base, fork })).rejects.toThrow('모델 로드 실패')
  })

  it('(e) 전체 기한을 넘으면 시간 초과', async () => {
    vi.useFakeTimers()
    const { fork, children } = makeFork({ behave: () => 'hang' })
    const p = runChunkedDiarization({ ...base, fork, timeoutMs: 1000 })
    const caught = p.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(1001)
    const err = await caught
    expect((err as Error).message).toBe('화자분리가 시간 초과되었습니다')
    expect(children[0].killed).toBeGreaterThan(0)
    expect(children).toHaveLength(1)
  })

  it('(f) 진행률은 비감소이고 마지막이 1', async () => {
    const { fork } = makeFork()
    const seen: number[] = []
    await runChunkedDiarization({ ...base, fork, chunkWindows: 300, onProgress: (r) => seen.push(r) })
    expect(seen.length).toBeGreaterThan(3)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    expect(seen[seen.length - 1]).toBe(1)
    expect(Math.max(...seen.slice(0, -1))).toBeLessThanOrEqual(0.95)
  })

  it('(g) 임베딩 수가 다르면 reject', async () => {
    const { fork } = makeFork({ behave: (call) => (call === 0 ? 'short' : 'reply') })
    await expect(runChunkedDiarization({ ...base, fork, chunkWindows: 300 })).rejects.toThrow(/창 0:300 임베딩 수 불일치/)
  })

  it('(h) chunkWindows 0 이면 한 청크', async () => {
    const { fork, children } = makeFork()
    const r = await runChunkedDiarization({ ...base, fork, chunkWindows: 0 })
    expect(r.chunks).toBe(1)
    expect(children.filter((c) => c.req?.op === 'embed').map((c) => (c.req as { wins: unknown[] }).wins.length)).toEqual([
      N_WIN
    ])
  })
})
