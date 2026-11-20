/**
 * 화자 임베딩 centroid 기반 클러스터 병합 (over-clustering 정밀 보정)
 *
 * sherpa의 자동 클러스터링(threshold)이 한 사람의 목소리를 톤/볼륨 차이로 여러
 * 화자로 쪼갠 경우, 발화량 기반 흡수(postprocess.ts)로는 "둘 다 충분히 말한"
 * 중복 화자를 합칠 수 없다. 이 모듈은 각 화자 클러스터의 평균 임베딩(centroid)
 * 코사인 유사도가 높으면 동일 화자로 보고 병합한다.
 *
 * 순수 함수 — 임베딩 추출(네이티브)은 worker.ts가 담당하고, 여기서는 centroid
 * 벡터만 받아 "어떤 화자를 어디로 합칠지"의 매핑을 계산한다(테스트 가능).
 */

/** 두 임베딩 벡터의 코사인 유사도 (-1~1). 영벡터면 0. */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

interface IterativeCentroidMergeOptions {
  /**
   * 병합 임계 코사인 유사도. 기본 0.8 (3D-Speaker 공식 화자분리 파이프라인 merge_by_cos의 기본값).
   * 현재 클러스터들 중 centroid 유사도가 최대인 쌍이 이 값 이상이면 병합한다.
   */
  threshold?: number
  /**
   * 화자 수 상한(안전장치). threshold 병합과 소수 재할당이 끝난 뒤에도 (centroid가 있는)
   * 클러스터 수가 이보다 많을 때만, 가장 유사한 쌍부터 병합해 이 수까지 줄인다.
   * centroid 없는 화자는 세지 않는다.
   */
  maxSpeakers?: number
  /**
   * 소수 클러스터 기준 가중치(누적 발화 시간 등). threshold 병합 뒤 가중치 합이 이 값 미만인
   * 클러스터를 주요 클러스터로 재할당한다 (3D-Speaker filter_minor_cluster 대응).
   * centroid가 있으면 가장 유사한 주요 클러스터로, 없으면 가중치가 가장 큰 주요 클러스터로 보낸다.
   */
  minorWeight?: number
}

interface WorkCluster {
  members: number[]
  centroid: Float32Array // L2 정규화된 벡터
  weight: number
}

/** L2 정규화 사본. 영벡터면 그대로 사본 반환. */
function l2normalize(v: Float32Array): Float32Array {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  const out = new Float32Array(v.length)
  if (n === 0) return out
  const inv = 1 / Math.sqrt(n)
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv
  return out
}

/** 두 클러스터를 합친 centroid: 가중(weight) 평균을 L2 정규화. 가중치 합이 0이면 단순 평균. */
function mergedCentroid(a: WorkCluster, b: WorkCluster): Float32Array {
  const sum = a.weight + b.weight
  const wa = sum > 0 ? a.weight / sum : 0.5
  const wb = sum > 0 ? b.weight / sum : 0.5
  const n = Math.min(a.centroid.length, b.centroid.length)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = a.centroid[i] * wa + b.centroid[i] * wb
  return l2normalize(out)
}

/** 현재 클러스터 중 centroid 유사도가 최대인 쌍. 클러스터가 2개 미만이면 null. */
function mostSimilarPair(clusters: WorkCluster[]): { i: number; j: number; sim: number } | null {
  let best: { i: number; j: number; sim: number } | null = null
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const sim = cosineSim(clusters[i].centroid, clusters[j].centroid)
      if (!best || sim > best.sim) best = { i, j, sim }
    }
  }
  return best
}

/** clusters[i]와 clusters[j](i < j)를 병합해 i 자리에 둔다. centroid는 가중 평균으로 재계산. */
function mergeAt(clusters: WorkCluster[], i: number, j: number): void {
  const a = clusters[i]
  const b = clusters[j]
  const merged: WorkCluster = {
    members: [...a.members, ...b.members],
    centroid: mergedCentroid(a, b),
    weight: a.weight + b.weight
  }
  clusters.splice(j, 1) // j > i 이므로 뒤쪽부터 제거
  clusters[i] = merged
}

/**
 * 반복 centroid 병합 + 소수 클러스터 재할당 + 화자 수 상한
 * (3D-Speaker merge_by_cos / filter_minor_cluster 방식).
 *
 * 단계 순서: ① threshold 병합 → ② 소수 재할당 → ③ maxSpeakers 상한.
 * 상한을 소수 재할당보다 먼저 적용하면, 조각 클러스터는 누구와도 닮지 않아 자리를 차지한 채
 * 남고 centroid가 좋은 실제 주요 화자끼리 강제 병합되는 문제가 있었다(실측: 37개 → 2명으로 붕괴).
 * 그래서 조각을 먼저 걷어낸 뒤 상한을 적용한다(거의 발동하지 않는 안전장치).
 *
 * ① 매 단계 "현재" 클러스터들 사이 최대 유사도 쌍 하나만 병합하고 centroid를 가중 평균으로
 *    다시 계산한 뒤 반복한다. A~B, B~C만 유사하고 A~C는 먼 경우에도 AB 병합 뒤 AB~C 유사도로
 *    다시 판정하므로 연쇄(chaining) 과병합이 없다.
 * ② 가중치 합이 minorWeight 미만인 클러스터를 주요 클러스터로 보낸다. centroid가 있으면 가장
 *    유사한 주요 클러스터로, centroid가 없는 소수 화자는 임베딩 근거가 없으므로 가중치가 가장 큰
 *    주요 클러스터로 보낸다(postprocess absorbMinority와 같은 규칙). 주요 클러스터(centroid 있음)가
 *    하나도 없으면 아무도 재할당하지 않는다. centroid가 없어도 가중치가 minorWeight 이상이면 유지.
 * ③ centroid가 있는 클러스터 수가 maxSpeakers를 넘으면 가장 유사한 쌍부터 병합한다.
 *
 * - minorWeight 미지정이면 centroid 없는 화자는 병합·재할당 대상이 아니며 자기 자신을 유지한다.
 * - 반환: 화자 id → 대표 id(최종 그룹 내 최소 id).
 *
 * @param speakers  전체 화자 id 목록 (중복 없는 정수)
 * @param centroids 화자 id → 임베딩 벡터 (정규화 여부 무관, 내부에서 L2 정규화)
 * @param weights   화자 id → 가중치(누적 발화 시간 등). 없으면 0으로 본다.
 */
export function planIterativeCentroidMerge(
  speakers: number[],
  centroids: Map<number, Float32Array>,
  weights: Map<number, number>,
  opts: IterativeCentroidMergeOptions = {}
): Map<number, number> {
  const { threshold = 0.8, maxSpeakers, minorWeight } = opts
  const weightOf = (s: number): number => Math.max(0, weights.get(s) ?? 0)

  let clusters: WorkCluster[] = speakers
    .filter((s) => centroids.has(s))
    .map((s) => ({
      members: [s],
      centroid: l2normalize(centroids.get(s) as Float32Array),
      weight: weightOf(s)
    }))

  // ── ① threshold 병합: 최대 유사도 쌍이 threshold 이상인 동안 ──
  for (;;) {
    const p = mostSimilarPair(clusters)
    if (!p || p.sim < threshold) break
    mergeAt(clusters, p.i, p.j)
  }

  // ── ② 소수 재할당 (주요 클러스터가 없으면 생략) ──
  if (minorWeight !== undefined && minorWeight > 0) {
    const majors = clusters.filter((c) => c.weight >= minorWeight)
    if (majors.length > 0) {
      const minors = clusters.filter((c) => c.weight < minorWeight)
      // 주요 클러스터의 centroid·가중치는 재할당 중 갱신하지 않는다(처리 순서에 결과가 흔들리지 않도록).
      for (const m of minors) {
        let target = majors[0]
        let best = -Infinity
        for (const c of majors) {
          const sim = cosineSim(m.centroid, c.centroid)
          if (sim > best) {
            best = sim
            target = c
          }
        }
        target.members.push(...m.members)
      }
      // centroid 없는 소수 화자 → 가중치가 가장 큰 주요 클러스터
      let heaviest = majors[0]
      for (const c of majors) if (c.weight > heaviest.weight) heaviest = c
      for (const s of speakers) {
        if (!centroids.has(s) && weightOf(s) < minorWeight) heaviest.members.push(s)
      }
      clusters = majors
    }
  }

  // ── ③ 화자 수 상한 (안전장치) ──
  if (maxSpeakers !== undefined && maxSpeakers > 0) {
    while (clusters.length > maxSpeakers) {
      const p = mostSimilarPair(clusters)
      if (!p) break
      mergeAt(clusters, p.i, p.j)
    }
  }

  // ── 대표 id 매핑: 그룹 내 최소 id ──
  const result = new Map<number, number>()
  for (const s of speakers) result.set(s, s)
  for (const c of clusters) {
    const rep = Math.min(...c.members)
    for (const s of c.members) result.set(s, rep)
  }
  return result
}
