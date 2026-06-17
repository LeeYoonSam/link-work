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

export interface CentroidMergeOptions {
  /**
   * 코사인 유사도가 이 값 이상인 centroid 쌍을 같은 화자로 병합. 기본 0.55.
   * CAM++ 임베딩 기준 동일화자 centroid는 보통 0.6+, 다른화자는 0.45 이하.
   * 높일수록 보수적(덜 합침), 낮출수록 공격적(많이 합침).
   */
  threshold?: number
  /**
   * 목표 화자 수. 지정 시 threshold를 무시하고, 가장 유사한 쌍부터 차례로 병합해
   * 클러스터 수가 이 값이 될 때까지 줄인다(참석자 수를 대략 알 때 유용).
   */
  targetCount?: number
}

/**
 * 화자 id 목록과 화자별 centroid 임베딩을 받아, 각 화자가 귀속될 대표 id 매핑을 반환.
 * - centroid가 없는 화자(임베딩 추출 실패/너무 짧음)는 병합하지 않고 자기 자신을 유지.
 * - 대표 id는 병합 그룹 내 최소 화자 id로 정한다(등장 순서 보존에 유리).
 *
 * @param speakers  전체 화자 id 목록 (중복 없는 정수)
 * @param centroids 화자 id → L2 정규화 여부 무관한 임베딩 벡터
 */
export function planCentroidMerge(
  speakers: number[],
  centroids: Map<number, Float32Array>,
  opts: CentroidMergeOptions = {}
): Map<number, number> {
  const { threshold = 0.55, targetCount } = opts

  // ── union-find ──
  const parent = new Map<number, number>()
  for (const s of speakers) parent.set(s, s)

  const find = (x: number): number => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) as number
    // path compression
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as number
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    // 작은 id를 대표로 (등장 순서/라벨 안정성)
    if (ra < rb) parent.set(rb, ra)
    else parent.set(ra, rb)
  }

  // centroid가 있는 화자만 병합 후보
  const candidates = speakers.filter((s) => centroids.has(s))

  // 모든 후보 쌍의 유사도 (유사도 내림차순 정렬)
  const pairs: Array<{ a: number; b: number; sim: number }> = []
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]
      const b = candidates[j]
      pairs.push({
        a,
        b,
        sim: cosineSim(centroids.get(a) as Float32Array, centroids.get(b) as Float32Array)
      })
    }
  }
  pairs.sort((x, y) => y.sim - x.sim)

  if (targetCount && targetCount > 0) {
    // 목표 화자 수까지 가장 유사한 쌍부터 병합 (AHC, 거리 무시)
    let clusters = candidates.length
    for (const p of pairs) {
      if (clusters <= targetCount) break
      if (find(p.a) !== find(p.b)) {
        union(p.a, p.b)
        clusters--
      }
    }
  } else {
    // threshold 이상인 쌍만 병합
    for (const p of pairs) {
      if (p.sim >= threshold) union(p.a, p.b)
    }
  }

  const result = new Map<number, number>()
  for (const s of speakers) result.set(s, parent.has(s) ? find(s) : s)
  return result
}
