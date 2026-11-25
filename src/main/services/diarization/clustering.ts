// 창 임베딩 클러스터링 — 순수 함수.
// 창마다 뽑은 화자 임베딩(L2 정규화)을 average linkage AHC 로 묶고, centroid 반복 병합·소수 조각
// 재할당으로 화자 수를 다듬는다. 네이티브 호출이 없어 단위 테스트로 검증한다.
// 상수는 이 파일 한 곳에 둔다(창 설정은 window-plan.ts).

/** AHC 덴드로그램 컷 높이(코사인 거리 = 1 - cos). */
export const CUT_THRESHOLD = 0.5
/** 자동 모드: centroid 최유사 쌍의 코사인이 이 값 이상이면 같은 사람으로 보고 병합한다. */
export const MERGE_COS = 0.72
/** 지정 모드: 먼저 병합하는 "확실한 동일인" 코사인. */
export const SURE_MERGE_COS = 0.8
/** 소수 클러스터 기준(누적 발화 초) = max(MINOR_SEC, 전체 × MINOR_RATIO). */
export const MINOR_SEC = 15
export const MINOR_RATIO = 0.02
/** 자동 모드 화자 수 상한. */
export const MAX_AUTO_SPEAKERS = 10
/** AHC 에 넣는 창 수 상한. 초과하면 균등 추출한다(거리 행렬 n² × 4바이트 ≤ 64MB). */
export const MAX_CLUSTER_WINDOWS = 4000

export type Vec = Float32Array

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0
  const n = Math.min(a.length, b.length)
  for (let k = 0; k < n; k++) d += a[k] * b[k]
  return d
}

/** L2 정규화한 새 벡터. 영벡터는 그대로(0) 돌려준다. */
export function l2normalize(v: ArrayLike<number>): Vec {
  let s = 0
  for (let k = 0; k < v.length; k++) s += v[k] * v[k]
  const n = Math.sqrt(s) || 1
  const out = new Float32Array(v.length)
  for (let k = 0; k < v.length; k++) out[k] = v[k] / n
  return out
}

/** 두 임베딩 벡터의 코사인 유사도 (-1~1). 영벡터면 0. */
export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  let d = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    d += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return d / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 같은 그룹(세그먼트) 안에서 앞뒤 ±1 창을 평균한 뒤 L2 정규화한다.
 * groups[i]는 창 i의 그룹 id. 같은 그룹의 창은 배열에서 연속한다고 가정한다.
 */
export function smoothNeighbors(X: ReadonlyArray<Vec>, groups: ReadonlyArray<number>): Vec[] {
  return X.map((v, i) => {
    const s = new Float64Array(v.length)
    for (const j of [i - 1, i, i + 1]) {
      if (j < 0 || j >= X.length || groups[j] !== groups[i]) continue
      const x = X[j]
      for (let k = 0; k < v.length; k++) s[k] += x[k]
    }
    return l2normalize(s)
  })
}

/** 병합 기록: [남는 클러스터, 흡수된 클러스터, 병합 높이(평균 코사인 거리)] */
export type Merge = [number, number, number]

/**
 * 코사인 거리 average linkage AHC (NN-chain, O(n²) 시간·메모리).
 * X는 L2 정규화돼 있어야 한다. 병합 기록은 발생 순서이며 높이 순 정렬은 보장하지 않는다
 * (average linkage 는 reducible 이라 높이로 자르는 결과는 정렬과 무관하게 같다).
 */
export function ahcAverageLinkage(X: ReadonlyArray<Vec>): Merge[] {
  const n = X.length
  const merges: Merge[] = []
  if (n < 2) return merges
  const D = new Float32Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = 1 - dot(X[i], X[j])
      D[i * n + j] = d
      D[j * n + i] = d
    }
  }
  const size = new Int32Array(n).fill(1)
  const active = new Uint8Array(n).fill(1)
  const chain: number[] = []
  let left = n
  let firstActive = 0
  while (left > 1) {
    if (chain.length === 0) {
      while (!active[firstActive]) firstActive++
      chain.push(firstActive)
    }
    for (;;) {
      const a = chain[chain.length - 1]
      const prev = chain.length > 1 ? chain[chain.length - 2] : -1
      let best = -1
      let bd = Infinity
      const row = a * n
      for (let j = 0; j < n; j++) {
        if (!active[j] || j === a) continue
        const d = D[row + j]
        if (d < bd || (d === bd && j === prev)) {
          bd = d
          best = j
        }
      }
      if (best === prev) {
        chain.pop()
        chain.pop()
        merges.push([a, best, bd])
        const sa = size[a]
        const sb = size[best]
        for (let k = 0; k < n; k++) {
          if (!active[k] || k === a || k === best) continue
          const d = (sa * D[row + k] + sb * D[best * n + k]) / (sa + sb)
          D[row + k] = d
          D[k * n + a] = d
        }
        size[a] = sa + sb
        active[best] = 0
        left--
        break
      }
      chain.push(best)
    }
  }
  return merges
}

function unionLabels(n: number, merges: ReadonlyArray<Merge>): number[] {
  const p = Int32Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (p[i] !== i) {
      p[i] = p[p[i]]
      i = p[i]
    }
    return i
  }
  for (const [a, b] of merges) p[find(b)] = find(a)
  return Array.from({ length: n }, (_, i) => find(i))
}

/** 높이 ≤ threshold 인 병합만 적용한 라벨(클러스터 대표 인덱스). */
export function cutByThreshold(n: number, merges: ReadonlyArray<Merge>, threshold: number): number[] {
  return unionLabels(
    n,
    merges.filter((m) => m[2] <= threshold)
  )
}

/** 낮은 병합부터 적용해 정확히 count 개 클러스터가 되게 자른다(count ≥ n 이면 창마다 하나). */
export function cutByCount(n: number, merges: ReadonlyArray<Merge>, count: number): number[] {
  const k = Math.max(1, Math.min(n, count))
  const sorted = merges
    .map((m, i) => ({ m, i }))
    .sort((x, y) => x.m[2] - y.m[2] || x.i - y.i)
    .slice(0, n - k)
    .map((x) => x.m)
  return unionLabels(n, sorted)
}

interface Centroid {
  /** L2 정규화한 가중 평균 */
  c: Vec
  /** 가중치 합(누적 발화 초) */
  w: number
}

/** 라벨별 가중 centroid. 맵 순서는 라벨 첫 등장 순(결정적). */
export function centroids(
  X: ReadonlyArray<Vec>,
  w: ReadonlyArray<number>,
  labels: ReadonlyArray<number>
): Map<number, Centroid> {
  const dim = X.length > 0 ? X[0].length : 0
  const acc = new Map<number, { sum: Float64Array; w: number }>()
  for (let i = 0; i < X.length; i++) {
    let c = acc.get(labels[i])
    if (!c) {
      c = { sum: new Float64Array(dim), w: 0 }
      acc.set(labels[i], c)
    }
    const x = X[i]
    const wi = w[i]
    for (let k = 0; k < dim; k++) c.sum[k] += x[k] * wi
    c.w += wi
  }
  const out = new Map<number, Centroid>()
  for (const [k, c] of acc) out.set(k, { c: l2normalize(c.sum), w: c.w })
  return out
}

/**
 * centroid 최유사 쌍을 반복 병합한다. stop(최고 유사도, 현재 클러스터 수)가 true 면 멈춘다.
 * labels 를 제자리에서 바꾼다.
 */
function mergeLoop(
  X: ReadonlyArray<Vec>,
  w: ReadonlyArray<number>,
  labels: number[],
  stop: (bestSim: number, count: number) => boolean
): void {
  for (;;) {
    const m = centroids(X, w, labels)
    const ks = [...m.keys()]
    if (ks.length < 2) return
    let best = -2
    let bi = ks[0]
    let bj = ks[1]
    for (let i = 0; i < ks.length; i++) {
      const ci = m.get(ks[i])!.c
      for (let j = i + 1; j < ks.length; j++) {
        const s = dot(ci, m.get(ks[j])!.c)
        if (s > best) {
          best = s
          bi = ks[i]
          bj = ks[j]
        }
      }
    }
    if (stop(best, ks.length)) return
    for (let i = 0; i < labels.length; i++) if (labels[i] === bj) labels[i] = bi
  }
}

/** 소수 클러스터(가중치 < minor)의 창을 가장 가까운 주요 centroid 로 옮긴다. 주요가 없으면 그대로. */
function reassignMinor(X: ReadonlyArray<Vec>, w: ReadonlyArray<number>, labels: number[], minor: number): void {
  const m = centroids(X, w, labels)
  const major = [...m.entries()].filter(([, c]) => c.w >= minor)
  if (major.length === 0) return
  for (let i = 0; i < labels.length; i++) {
    if (m.get(labels[i])!.w >= minor) continue
    labels[i] = nearest(X[i], major)
  }
}

function nearest(x: Vec, cands: ReadonlyArray<[number, Centroid]>): number {
  let b = -Infinity
  let bk = cands[0][0]
  for (const [k, c] of cands) {
    const s = dot(x, c.c)
    if (s > b) {
      b = s
      bk = k
    }
  }
  return bk
}

export interface ClusterOptions {
  /** 지정 화자 수(>0이면 정확히 그 수). 미지정·0이면 자동 추정. */
  numSpeakers?: number
  /** 자동 모드 상한(기본 MAX_AUTO_SPEAKERS). */
  maxSpeakers?: number
  /** AHC 창 수 상한(기본 MAX_CLUSTER_WINDOWS). 테스트용. */
  maxClusterWindows?: number
}

export interface ClusterResult {
  /** 창별 화자 번호(0..k-1, 첫 등장 순) */
  labels: number[]
  /** 덴드로그램 컷 직후 클러스터 수(추출 경로면 추출본 기준) */
  rawClusters: number
  /** 화자 번호별 centroid(L2)와 가중치 합. 인덱스 = 화자 번호 */
  centroids: { c: Vec; w: number }[]
}

/** AHC + 병합·재할당. labels 는 클러스터 대표 인덱스(압축 전). */
function clusterCore(
  X: ReadonlyArray<Vec>,
  w: ReadonlyArray<number>,
  numSpeakers: number,
  maxSpeakers: number
): { labels: number[]; raw: number } {
  const n = X.length
  const merges = ahcAverageLinkage(X)
  const labels = cutByThreshold(n, merges, CUT_THRESHOLD)
  const raw = new Set(labels).size
  let total = 0
  for (const x of w) total += x
  const minor = Math.max(MINOR_SEC, total * MINOR_RATIO)

  if (numSpeakers > 0) {
    const target = Math.min(numSpeakers, n)
    if (raw < target) return { labels: cutByCount(n, merges, target), raw }
    // 확실한 동일인만 먼저 병합(목표 수 아래로는 내려가지 않는다).
    mergeLoop(X, w, labels, (s, cnt) => s < SURE_MERGE_COS || cnt <= target)
    for (;;) {
      const m = centroids(X, w, labels)
      if (m.size <= target) break
      const e = [...m.entries()].sort((a, b) => a[1].w - b[1].w)
      const majors = e.filter(([, c]) => c.w >= minor).length
      if (majors >= target && e[0][1].w < minor) {
        // 가장 작은 소수 조각을 가장 가까운 다른 클러스터로.
        const k0 = e[0][0]
        const others = e.filter(([k]) => k !== k0)
        for (let i = 0; i < n; i++) if (labels[i] === k0) labels[i] = nearest(X[i], others)
      } else {
        const before = m.size
        mergeLoop(X, w, labels, (_s, cnt) => cnt <= before - 1)
      }
    }
    return { labels, raw }
  }

  mergeLoop(X, w, labels, (s) => s < MERGE_COS)
  reassignMinor(X, w, labels, minor)
  mergeLoop(X, w, labels, (s) => s < MERGE_COS)
  mergeLoop(X, w, labels, (_s, cnt) => cnt <= maxSpeakers)
  return { labels, raw }
}

/**
 * 창 임베딩(L2)과 가중치(초)로 화자를 나눈다. 결정적이다(같은 입력 → 같은 결과).
 * 창이 maxClusterWindows 를 넘으면 균등 추출본으로 클러스터링한 뒤 나머지 창을 가장 가까운
 * centroid 로 보낸다.
 */
export function clusterEmbeddings(
  X: ReadonlyArray<Vec>,
  w: ReadonlyArray<number>,
  opts: ClusterOptions = {}
): ClusterResult {
  const n = X.length
  if (n === 0) return { labels: [], rawClusters: 0, centroids: [] }
  const numSpeakers = opts.numSpeakers && opts.numSpeakers > 0 ? Math.floor(opts.numSpeakers) : 0
  const maxSpeakers = opts.maxSpeakers && opts.maxSpeakers > 0 ? opts.maxSpeakers : MAX_AUTO_SPEAKERS
  const limit = opts.maxClusterWindows ?? MAX_CLUSTER_WINDOWS

  let labels: number[]
  let raw: number
  if (n <= limit) {
    const r = clusterCore(X, w, numSpeakers, maxSpeakers)
    labels = r.labels
    raw = r.raw
  } else {
    // 균등 추출. 가중치는 n/m 배로 늘려 소수 기준(초)이 전체 녹음 기준을 유지하게 한다.
    const idx: number[] = []
    for (let i = 0; i < limit; i++) idx.push(Math.floor((i * n) / limit))
    const scale = n / limit
    const sx = idx.map((i) => X[i])
    const sw = idx.map((i) => w[i] * scale)
    const r = clusterCore(sx, sw, numSpeakers, maxSpeakers)
    raw = r.raw
    const cents = [...centroids(sx, sw, r.labels).entries()]
    labels = new Array<number>(n)
    const picked = new Map<number, number>()
    idx.forEach((i, j) => picked.set(i, r.labels[j]))
    for (let i = 0; i < n; i++) labels[i] = picked.get(i) ?? nearest(X[i], cents)
  }

  // 첫 등장 순으로 0..k-1 로 압축.
  const remap = new Map<number, number>()
  const out = labels.map((l) => {
    let v = remap.get(l)
    if (v === undefined) {
      v = remap.size
      remap.set(l, v)
    }
    return v
  })
  const cm = centroids(X, w, out)
  const cents: { c: Vec; w: number }[] = []
  for (let k = 0; k < remap.size; k++) cents.push(cm.get(k)!)
  return { labels: out, rawClusters: raw, centroids: cents }
}
