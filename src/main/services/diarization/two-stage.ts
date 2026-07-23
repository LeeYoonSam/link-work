// 2-스테이지 화자분리 재정합 (순수 함수, 모델 호출 없음)
//
// 왜 이 방식인가 — 제약에서 출발한다:
//   mic+system 녹음은 저장 시 16k mono 믹스 WAV 한 개로만 남는다. 원본 스테레오
//   (mic=L / system=R)는 보존되지 않으므로 "system 채널 오디오만 떼어내 sherpa에
//   먹여 상대편 여러 명을 분리"하는 방법은 불가능하다. 살아남는 채널 정보는
//   {id}.channels.json의 100ms hop L/R RMS envelope뿐이고, 이건 channel-adapter가
//   segment를 mic/system 2진 분류하는 데만 쓸 수 있다.
//
//   그래서 대안: 전체 mono를 sherpa로 클러스터링(여러 명 구분 가능)한 뒤, 그
//   클러스터 라벨을 채널 기반 mic/system 확정과 시간축에서 재정합한다.
//   - channel이 'mic'으로 라벨한 구간 = 나. sherpa 클러스터 중 이 시간과 가장 많이
//     겹치는 클러스터가 '나 클러스터'.
//   - channel이 'system'으로 라벨한 구간 = 상대편. 이 구간을 sherpa 클러스터별로
//     쪼개 상대 1('sys_0'), 상대 2('sys_1')… 로 분리한다.
import type { DiarTurn } from '../meeting-types'

/** 두 시간 구간의 겹침 ms. 겹치지 않으면 0. */
function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

/** Map에서 값이 최대인 key. 비어 있으면 null. 동률은 먼저 삽입된 key. */
function argmaxKey(m: Map<string, number>): string | null {
  let bestKey: string | null = null
  let bestVal = -Infinity
  for (const [k, v] of m) {
    if (v > bestVal) {
      bestVal = v
      bestKey = k
    }
  }
  return bestKey
}

/**
 * 채널 기반 mic/system 라벨과 sherpa 클러스터(spk_N)를 시간축에서 재정합한다.
 *
 * 절차:
 *  1. '나 클러스터' 식별 — mic 라벨 시간과 겹침 총량이 최대인 sherpa 클러스터.
 *  2. system 라벨 turn을 sherpa 클러스터로 귀속하며 등장 순 'sys_N'으로 재번호.
 *     - 최대 겹침 클러스터가 나 클러스터면 → 나 제외 차선 클러스터.
 *     - 겹침이 아예 없으면 → 'system' 유지.
 *  3. 재정합 결과가 2화자 이하면(분리 실패) channelTurns를 그대로 반환(무해 폴백).
 *
 * mic으로 라벨된 turn은 시간·키 모두 불변('나' 확정).
 *
 * @param channelTurns STT segment별 'mic'/'system' 라벨 turn (channel-adapter 결과)
 * @param sherpaTurns  전체 파일 sherpa 클러스터 turn ('spk_N')
 */
export function combineTwoStage(channelTurns: DiarTurn[], sherpaTurns: DiarTurn[]): DiarTurn[] {
  // sherpa 결과가 없으면 재정합할 근거가 없다 → 채널 결과 그대로.
  if (sherpaTurns.length === 0) return channelTurns

  // 1. '나 클러스터' 식별: mic 라벨 시간과 겹침 총량이 최대인 sherpa 클러스터.
  const micOverlapByCluster = new Map<string, number>()
  for (const ct of channelTurns) {
    if (ct.speaker_key !== 'mic') continue
    for (const st of sherpaTurns) {
      const ov = overlapMs(ct.start_ms, ct.end_ms, st.start_ms, st.end_ms)
      if (ov > 0) {
        micOverlapByCluster.set(
          st.speaker_key,
          (micOverlapByCluster.get(st.speaker_key) ?? 0) + ov
        )
      }
    }
  }
  const micCluster = argmaxKey(micOverlapByCluster)

  // 2. system 라벨 turn을 sherpa 클러스터로 귀속. 등장 순으로 sys_N 부여.
  const sysIndexByCluster = new Map<string, number>()
  const result: DiarTurn[] = channelTurns.map((ct) => {
    // mic('나')은 확정 — 시간·키 불변.
    if (ct.speaker_key === 'mic') return { ...ct }

    // system 구간: 이 구간과 각 sherpa 클러스터의 겹침을 계산.
    //  - bestKey       : 전체 최대 겹침 클러스터
    //  - bestNonMicKey : 나 클러스터를 제외한 최대 겹침 클러스터
    let bestKey: string | null = null
    let bestOv = 0
    let bestNonMicKey: string | null = null
    let bestNonMicOv = 0
    for (const st of sherpaTurns) {
      const ov = overlapMs(ct.start_ms, ct.end_ms, st.start_ms, st.end_ms)
      if (ov <= 0) continue
      if (ov > bestOv) {
        bestOv = ov
        bestKey = st.speaker_key
      }
      if (st.speaker_key !== micCluster && ov > bestNonMicOv) {
        bestNonMicOv = ov
        bestNonMicKey = st.speaker_key
      }
    }

    // 최대 겹침이 나 클러스터면 차선(비-나) 클러스터로 귀속한다.
    const chosen = bestKey === micCluster ? bestNonMicKey : bestKey

    // 귀속할 클러스터가 없으면(겹침 0 또는 비-나 클러스터 부재) 'system' 유지.
    if (!chosen) return { ...ct, speaker_key: 'system' }

    let idx = sysIndexByCluster.get(chosen)
    if (idx === undefined) {
      idx = sysIndexByCluster.size
      sysIndexByCluster.set(chosen, idx)
    }
    return { ...ct, speaker_key: `sys_${idx}` }
  })

  // 3. 재정합 결과가 2화자 이하면 상대편을 실제로 쪼개지 못한 것 → 채널 결과 그대로.
  //    (mic + system 2화자와 동일하므로 채널 결과 반환이 무해한 폴백이다.)
  const distinct = new Set(result.map((t) => t.speaker_key)).size
  if (distinct <= 2) return channelTurns

  return result
}
