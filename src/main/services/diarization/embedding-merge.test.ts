import { describe, it, expect } from 'vitest'
import { planIterativeCentroidMerge, cosineSim } from './embedding-merge'

const v = (...xs: number[]): Float32Array => Float32Array.from(xs)
// 단위 벡터 (cosθ, sinθ) — 두 벡터의 유사도는 cos(각도 차)
const ang = (deg: number): Float32Array => {
  const r = (deg * Math.PI) / 180
  return v(Math.cos(r), Math.sin(r))
}
const weightsOf = (entries: Array<[number, number]>): Map<number, number> => new Map(entries)

describe('planIterativeCentroidMerge', () => {
  it('연쇄(chaining) 병합이 일어나지 않는다: A~B, B~C만 유사하면 C는 독립 유지', () => {
    // A=0°, B=35°, C=70° → A~B = B~C ≈ 0.819, A~C ≈ 0.342
    // AB 병합 centroid(≈17.5°)와 C의 유사도 ≈ cos(52.5°) ≈ 0.61 < 0.8 → 정지
    const centroids = new Map([
      [0, ang(0)],
      [1, ang(35)],
      [2, ang(70)]
    ])
    expect(cosineSim(ang(0), ang(35))).toBeGreaterThan(0.8)
    expect(cosineSim(ang(35), ang(70))).toBeGreaterThan(0.8)
    // B와 C가 아니라 A와 B가 먼저 병합되도록 A~B를 아주 약간 더 가깝게
    centroids.set(1, ang(34.9))
    const map = planIterativeCentroidMerge([0, 1, 2], centroids, weightsOf([[0, 10], [1, 10], [2, 10]]))
    expect(map.get(0)).toBe(0)
    expect(map.get(1)).toBe(0)
    expect(map.get(2)).toBe(2)
  })

  it('유사도 0.8 이상 쌍은 병합하고, 미만 쌍은 유지한다', () => {
    const centroids = new Map([
      [0, ang(0)],
      [1, ang(20)], // 0과 cos20° ≈ 0.94
      [2, ang(90)] // 다른 화자
    ])
    const map = planIterativeCentroidMerge([0, 1, 2], centroids, weightsOf([[0, 5], [1, 5], [2, 5]]))
    expect(map.get(1)).toBe(0)
    expect(map.get(2)).toBe(2)
  })

  it('maxSpeakers가 주어지면 threshold 미만이라도 상한까지 가장 유사한 쌍부터 병합한다', () => {
    const centroids = new Map([
      [0, ang(0)],
      [1, ang(60)], // 0~1: 0.5
      [2, ang(90)], // 1~2: cos30° ≈ 0.87 → threshold 병합
      [3, ang(180)]
    ])
    const w = weightsOf([[0, 5], [1, 5], [2, 5], [3, 5]])
    // 상한 없음: 1,2만 병합 → 3명
    const free = planIterativeCentroidMerge([0, 1, 2, 3], centroids, w)
    expect(new Set(free.values()).size).toBe(3)
    // 상한 2: (1,2) 병합 뒤 centroid 75°와 0의 유사도 cos75°≈0.26 > 3과의 유사도 → 0과 병합
    const capped = planIterativeCentroidMerge([0, 1, 2, 3], centroids, w, { maxSpeakers: 2 })
    expect(new Set(capped.values()).size).toBe(2)
    expect(capped.get(1)).toBe(0)
    expect(capped.get(2)).toBe(0)
    expect(capped.get(3)).toBe(3)
  })

  it('가중 평균 centroid: 발화가 많은 쪽으로 centroid가 치우친다', () => {
    // 0(가중 9)과 1(가중 1, 28.9°)이 먼저 병합된다(0~1 유사도가 1~2보다 근소하게 크다).
    // 가중 centroid ≈ 2.8° → 2(58°)와 cos55° ≈ 0.57 < 0.7 → 2는 독립 유지.
    // 동일 가중이었다면 centroid ≈ 14.5° → 2와 cos43.5° ≈ 0.73 ≥ 0.7 → 병합됐을 것.
    const centroids = new Map([
      [0, ang(0)],
      [1, ang(29)],
      [2, ang(58)]
    ])
    // 1~2는 cos29°로 0~1과 같으므로 1을 0 쪽으로 살짝 당긴다
    centroids.set(1, ang(28.9))
    const weighted = planIterativeCentroidMerge([0, 1, 2], centroids, weightsOf([[0, 9], [1, 1], [2, 5]]), {
      threshold: 0.7
    })
    expect(weighted.get(1)).toBe(0)
    expect(weighted.get(2)).toBe(2)
    const equal = planIterativeCentroidMerge([0, 1, 2], centroids, weightsOf([[0, 1], [1, 1], [2, 1]]), {
      threshold: 0.7
    })
    expect(equal.get(2)).toBe(0)
  })

  it('소수 클러스터는 가장 가까운 주요 클러스터로 재할당된다', () => {
    const centroids = new Map([
      [0, ang(0)],
      [1, ang(90)],
      [2, ang(70)] // 소수: 1(90°)에 가장 가깝다(cos20°)지만 threshold 위 병합을 피하려 가중치로만 판정
    ])
    const w = weightsOf([[0, 30], [1, 30], [2, 1]])
    // threshold를 높여 병합 단계는 건너뛰고 재할당만 검증
    const map = planIterativeCentroidMerge([0, 1, 2], centroids, w, { threshold: 0.99, minorWeight: 4 })
    expect(map.get(2)).toBe(1)
    expect(map.get(0)).toBe(0)
    expect(map.get(1)).toBe(1)
  })

  it('주요 클러스터가 없으면 소수 재할당을 하지 않는다', () => {
    const centroids = new Map([
      [0, ang(0)],
      [1, ang(90)]
    ])
    const map = planIterativeCentroidMerge([0, 1], centroids, weightsOf([[0, 1], [1, 1]]), {
      minorWeight: 4
    })
    expect(map.get(0)).toBe(0)
    expect(map.get(1)).toBe(1)
  })

  it('centroid 없는 소수 화자는 가중치가 가장 큰 주요 클러스터로 재할당된다', () => {
    const centroids = new Map([
      [0, ang(0)],
      [2, ang(90)]
    ])
    const map = planIterativeCentroidMerge([0, 1, 2], centroids, weightsOf([[0, 10], [1, 0.1], [2, 30]]), {
      minorWeight: 4
    })
    expect(map.get(1)).toBe(1) // 2 그룹으로 갔고, 그룹 내 최소 id가 1
    expect(map.get(2)).toBe(1)
    expect(map.get(0)).toBe(0)
  })

  it('centroid 없는 주요 화자, 그리고 minorWeight 미지정 시 centroid 없는 화자는 자기 자신을 유지한다', () => {
    const centroids = new Map([
      [0, ang(0)],
      [2, ang(5)]
    ])
    const major = planIterativeCentroidMerge([0, 1, 2], centroids, weightsOf([[0, 10], [1, 8], [2, 10]]), {
      maxSpeakers: 1,
      minorWeight: 4
    })
    expect(major.get(1)).toBe(1)
    expect(major.get(2)).toBe(0)
    const noMinor = planIterativeCentroidMerge([0, 1, 2], centroids, weightsOf([[0, 10], [1, 0.1], [2, 10]]), {
      maxSpeakers: 1
    })
    expect(noMinor.get(1)).toBe(1)
  })

  it('순서 회귀: 상한은 소수 재할당 뒤에 적용돼 주요 화자끼리 강제 병합하지 않는다', () => {
    // 8차원. 큰 클러스터 b0~b2 = e_i + 0.9·e7 → 서로 유사도 ≈ 0.45 (< 0.5, 0.8 미만이라 병합 안 됨)
    // 조각 f3~f6 = e_k + 0.2·e_(k-3 mod 3) → 큰 클러스터와 유사도 ≈ 0.15, 서로 0
    // 상한을 먼저 적용했다면 가장 유사한 쌍(큰 클러스터끼리)부터 합쳐졌을 것이다.
    const e = (k: number, extra?: [number, number]): Float32Array => {
      const out = new Float32Array(8)
      out[k] = 1
      if (extra) out[extra[0]] += extra[1]
      return out
    }
    const centroids = new Map<number, Float32Array>([
      [0, e(0, [7, 0.9])],
      [1, e(1, [7, 0.9])],
      [2, e(2, [7, 0.9])],
      [3, e(3, [0, 0.2])],
      [4, e(4, [1, 0.2])],
      [5, e(5, [2, 0.2])],
      [6, e(6, [0, 0.2])]
    ])
    const w = weightsOf([[0, 300], [1, 200], [2, 100], [3, 1], [4, 1], [5, 1], [6, 1]])
    const map = planIterativeCentroidMerge([0, 1, 2, 3, 4, 5, 6], centroids, w, {
      threshold: 0.8,
      maxSpeakers: 3,
      minorWeight: 4
    })
    expect(new Set(map.values())).toEqual(new Set([0, 1, 2]))
    expect(map.get(3)).toBe(0)
    expect(map.get(4)).toBe(1)
    expect(map.get(5)).toBe(2)
    expect(map.get(6)).toBe(0)
  })

  it('대표 id는 그룹 내 최소 id다 (소수 재할당 포함)', () => {
    const centroids = new Map([
      [5, ang(0)],
      [3, ang(10)], // 5와 병합
      [7, ang(90)],
      [1, ang(85)] // 소수 → 7 그룹으로, 대표는 1
    ])
    const w = weightsOf([[5, 10], [3, 10], [7, 10], [1, 0.5]])
    const map = planIterativeCentroidMerge([5, 3, 7, 1], centroids, w, { threshold: 0.999, minorWeight: 4 })
    // threshold 0.999 → 5,3(cos10°≈0.985)은 병합되지 않음, 1은 7로 재할당
    expect(map.get(1)).toBe(1)
    expect(map.get(7)).toBe(1)
    const map2 = planIterativeCentroidMerge([5, 3, 7, 1], centroids, w, { minorWeight: 4 })
    expect(map2.get(5)).toBe(3)
    expect(map2.get(3)).toBe(3)
  })
})
