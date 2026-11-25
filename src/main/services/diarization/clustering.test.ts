import { describe, it, expect } from 'vitest'
import {
  ahcAverageLinkage,
  clusterEmbeddings,
  cosineSim,
  cutByCount,
  cutByThreshold,
  dot,
  l2normalize,
  smoothNeighbors,
  MAX_CLUSTER_WINDOWS,
  type Vec
} from './clustering'

// 결정적 의사난수(LCG) + Box-Muller 정규분포
function rng(seed: number): () => number {
  let s = seed >>> 0
  const u = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return (s + 0.5) / 4294967296
  }
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u())
}

function randomUnit(dim: number, g: () => number): Vec {
  return l2normalize(Array.from({ length: dim }, () => g()))
}

/** center 주변 샘플 n개. noise 는 잡음 벡터의 기대 노름. */
function samples(center: Vec, n: number, noise: number, g: () => number): Vec[] {
  const dim = center.length
  const sd = noise / Math.sqrt(dim)
  return Array.from({ length: n }, () => l2normalize(Array.from(center, (c) => c + g() * sd)))
}

/** a 와 코사인이 cos 인 단위 벡터 */
function rotated(a: Vec, cos: number, g: () => number): Vec {
  const r = randomUnit(a.length, g)
  const p = dot(r, a)
  const perp = l2normalize(Array.from(r, (x, k) => x - p * a[k]))
  const sin = Math.sqrt(1 - cos * cos)
  return l2normalize(Array.from(a, (x, k) => cos * x + sin * perp[k]))
}

const W = 0.75
const weights = (n: number): number[] => new Array(n).fill(W)
const count = (labels: number[]): number => new Set(labels).size

describe('ahcAverageLinkage / cut', () => {
  it('가까운 점끼리 먼저 묶고 높이로 자른다', () => {
    const X = [l2normalize([1, 0]), l2normalize([0.99, 0.1]), l2normalize([0, 1]), l2normalize([0.1, 0.99])]
    const merges = ahcAverageLinkage(X)
    expect(merges).toHaveLength(3)
    const lab = cutByThreshold(4, merges, 0.5)
    expect(lab[0]).toBe(lab[1])
    expect(lab[2]).toBe(lab[3])
    expect(lab[0]).not.toBe(lab[2])
    expect(count(cutByCount(4, merges, 1))).toBe(1)
    expect(count(cutByCount(4, merges, 3))).toBe(3)
    expect(count(cutByCount(4, merges, 9))).toBe(4)
  })
})

describe('smoothNeighbors', () => {
  it('같은 그룹 안 ±1 창만 평균하고 L2 정규화한다', () => {
    const X = [l2normalize([1, 0]), l2normalize([0, 1]), l2normalize([1, 0])]
    const out = smoothNeighbors(X, [0, 0, 1])
    // 0: (1,0)+(0,1) / 1: (1,0)+(0,1) / 2: 그룹이 달라 자기 자신만
    expect(out[0][0]).toBeCloseTo(Math.SQRT1_2)
    expect(out[1][1]).toBeCloseTo(Math.SQRT1_2)
    expect(Array.from(out[2])).toEqual([1, 0])
  })
})

describe('clusterEmbeddings', () => {
  const dim = 192

  it('합성 2군집 → 2명', () => {
    const g = rng(1)
    const A = randomUnit(dim, g)
    const B = randomUnit(dim, g)
    const X = [...samples(A, 60, 0.7, g), ...samples(B, 60, 0.7, g)]
    const r = clusterEmbeddings(X, weights(X.length))
    expect(r.centroids).toHaveLength(2)
    expect(count(r.labels.slice(0, 60))).toBe(1)
    expect(count(r.labels.slice(60))).toBe(1)
    expect(r.labels[0]).not.toBe(r.labels[60])
    for (const c of r.centroids) expect(Math.hypot(...c.c)).toBeCloseTo(1)
  })

  it('2군집 + 소수 조각 → 소수 조각은 주요 화자로 재할당돼 2명', () => {
    const g = rng(2)
    const A = randomUnit(dim, g)
    const B = randomUnit(dim, g)
    const C = randomUnit(dim, g)
    // 조각: 5창 × 0.75초 = 3.75초 < 15초
    const X = [...samples(A, 60, 0.7, g), ...samples(C, 5, 0.7, g), ...samples(B, 60, 0.7, g)]
    const r = clusterEmbeddings(X, weights(X.length))
    expect(r.rawClusters).toBeGreaterThanOrEqual(3)
    expect(r.centroids).toHaveLength(2)
  })

  it('한 사람이 두 군집으로 쪼개져도(centroid 코사인 0.8) 병합한다', () => {
    const g = rng(3)
    const A = randomUnit(dim, g)
    const A2 = rotated(A, 0.8, g)
    const B = randomUnit(dim, g)
    expect(cosineSim(A, A2)).toBeCloseTo(0.8)
    const X = [...samples(A, 60, 0.9, g), ...samples(A2, 60, 0.9, g), ...samples(B, 60, 0.9, g)]
    const r = clusterEmbeddings(X, weights(X.length))
    expect(r.rawClusters).toBeGreaterThanOrEqual(3)
    expect(r.centroids).toHaveLength(2)
    expect(count(r.labels.slice(0, 120))).toBe(1)
    expect(r.labels[0]).not.toBe(r.labels[120])
  })

  it('지정 화자 수 N → 정확히 N명 (병합 방향·분할 방향 모두)', () => {
    const g = rng(4)
    const cs = [randomUnit(dim, g), randomUnit(dim, g), randomUnit(dim, g)]
    const X = cs.flatMap((c) => samples(c, 40, 0.7, g))
    expect(clusterEmbeddings(X, weights(X.length), { numSpeakers: 2 }).centroids).toHaveLength(2)
    expect(clusterEmbeddings(X, weights(X.length), { numSpeakers: 3 }).centroids).toHaveLength(3)
    expect(clusterEmbeddings(X, weights(X.length), { numSpeakers: 5 }).centroids).toHaveLength(5)
    // 확실한 동일인(≥0.8) 병합도 지정 수 아래로는 내려가지 않는다
    const A = randomUnit(dim, g)
    const Y = [...samples(A, 40, 0.3, g), ...samples(rotated(A, 0.9, g), 40, 0.3, g)]
    expect(clusterEmbeddings(Y, weights(Y.length), { numSpeakers: 2 }).centroids).toHaveLength(2)
    // 창 수보다 큰 N 은 창 수로 제한
    expect(clusterEmbeddings(X.slice(0, 3), weights(3), { numSpeakers: 5 }).centroids).toHaveLength(3)
  })

  it(`창이 ${MAX_CLUSTER_WINDOWS}개를 넘으면 균등 추출 후 나머지를 가장 가까운 화자로 보낸다`, () => {
    const g = rng(5)
    const d = 16
    const A = randomUnit(d, g)
    const B = randomUnit(d, g)
    const n = MAX_CLUSTER_WINDOWS + 100
    const truth: number[] = []
    const X: Vec[] = []
    for (let i = 0; i < n; i++) {
      const k = Math.floor(i / 50) % 2
      truth.push(k)
      X.push(samples(k === 0 ? A : B, 1, 0.5, g)[0])
    }
    const r = clusterEmbeddings(X, weights(n))
    expect(r.labels).toHaveLength(n)
    expect(r.centroids).toHaveLength(2)
    for (let i = 0; i < n; i++) expect(r.labels[i]).toBe(truth[i])
  }, 60_000)

  it('추출 상한을 낮춰도 같은 군집을 낸다', () => {
    const g = rng(6)
    const A = randomUnit(dim, g)
    const B = randomUnit(dim, g)
    const X = [...samples(A, 80, 0.7, g), ...samples(B, 80, 0.7, g)]
    const full = clusterEmbeddings(X, weights(X.length))
    const sampled = clusterEmbeddings(X, weights(X.length), { maxClusterWindows: 40 })
    expect(sampled.labels).toEqual(full.labels)
  })

  it('결정적이다: 같은 입력이면 같은 라벨·centroid', () => {
    const g = rng(7)
    const cs = [randomUnit(dim, g), randomUnit(dim, g), randomUnit(dim, g)]
    const X = cs.flatMap((c) => samples(c, 30, 1.0, g))
    const a = clusterEmbeddings(X, weights(X.length))
    const b = clusterEmbeddings(X.map((x) => Float32Array.from(x)), weights(X.length))
    expect(b.labels).toEqual(a.labels)
    expect(b.rawClusters).toBe(a.rawClusters)
    expect(b.centroids.map((c) => Array.from(c.c))).toEqual(a.centroids.map((c) => Array.from(c.c)))
    // 라벨은 첫 등장 순 0..k-1
    expect(a.labels[0]).toBe(0)
  })

  it('빈 입력·창 1개', () => {
    expect(clusterEmbeddings([], [])).toEqual({ labels: [], rawClusters: 0, centroids: [] })
    const one = clusterEmbeddings([l2normalize([1, 2, 3])], [W])
    expect(one.labels).toEqual([0])
    expect(one.centroids).toHaveLength(1)
  })
})
