// 창 라벨 → 화자 turn — 순수 함수.
import type { DiarTurn } from '../meeting-types'

/**
 * 라벨이 붙은 창(초)을 화자 turn(ms)으로 만든다.
 * - 창은 시작 시각 순으로 처리한다. 앞 창과 겹치면 겹친 구간의 중점을 경계로 나눈다.
 * - 바로 붙은(경계가 맞닿거나 겹친) 같은 화자 turn 은 하나로 합친다. 떨어진 turn 은 합치지 않는다.
 * - speaker_key 는 `spk_${label}`.
 */
export function buildTurns(
  windows: ReadonlyArray<{ s: number; e: number }>,
  labels: ReadonlyArray<number>
): DiarTurn[] {
  const order = windows.map((_, i) => i).sort((a, b) => windows[a].s - windows[b].s || a - b)
  const pieces: { s: number; e: number; label: number }[] = []
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi]
    let s = windows[i].s
    let e = windows[i].e
    if (oi > 0) {
      const p = windows[order[oi - 1]]
      if (p.e > s) s = Math.max(s, (s + p.e) / 2)
    }
    if (oi + 1 < order.length) {
      const nx = windows[order[oi + 1]]
      if (nx.s < e) e = Math.min(e, (nx.s + e) / 2)
    }
    if (e > s) pieces.push({ s, e, label: labels[i] })
  }

  const turns: DiarTurn[] = []
  let cur: { s: number; e: number; label: number } | null = null
  for (const p of pieces) {
    if (cur && cur.label === p.label && p.s <= cur.e + 1e-9) {
      cur.e = Math.max(cur.e, p.e)
      continue
    }
    if (cur) turns.push(toTurn(cur))
    cur = { ...p }
  }
  if (cur) turns.push(toTurn(cur))
  return turns
}

function toTurn(p: { s: number; e: number; label: number }): DiarTurn {
  return {
    start_ms: Math.round(p.s * 1000),
    end_ms: Math.round(p.e * 1000),
    speaker_key: `spk_${p.label}`
  }
}
