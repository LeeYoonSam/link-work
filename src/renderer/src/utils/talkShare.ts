// 발화 점유율 계산. 순수 모듈이다.
// main services/meeting-notes.ts 의 computeTalkShare 와 같은 규칙이다(같은 테스트 표로 검증).

export interface TalkShareRow {
  speaker_id: number | null
  name: string
  ms: number
  pct: number
  turns: number
}

/**
 * 화자별 발화 시간·비율·발언 횟수. 길이 0인 세그먼트는 무시한다. pct 는 최대 나머지 방식으로
 * 합을 정확히 100으로 맞춘다. 화자 있는 줄은 ms 내림차순(같으면 speakers 순), 미지정(null)은 맨 뒤.
 */
export function computeTalkShare(
  segments: Array<{
    start_ms: number
    end_ms: number
    speaker_id: number | null
  }>,
  speakers: Array<{ id: number; label: string; display_name: string | null }>
): { rows: TalkShareRow[]; totalMs: number } {
  const timed = segments
    .map((g, i) => ({
      g,
      i,
      dur: Math.max(0, (g.end_ms ?? 0) - (g.start_ms ?? 0))
    }))
    .filter((x) => Number.isFinite(x.dur) && x.dur > 0)
    .sort((a, b) => a.g.start_ms - b.g.start_ms || a.i - b.i)

  const order = new Map<number, number>(speakers.map((sp, i) => [sp.id, i]))
  const keyOf = (id: number | null): string => (id === null ? 'null' : String(id))
  const acc = new Map<
    string,
    { speaker_id: number | null; ms: number; turns: number; rank: number }
  >()
  let unknownRank = speakers.length
  let prev: string | undefined
  for (const { g, dur } of timed) {
    const id = g.speaker_id ?? null
    const key = keyOf(id)
    let row = acc.get(key)
    if (!row) {
      const rank = id === null ? Number.POSITIVE_INFINITY : (order.get(id) ?? unknownRank++)
      row = { speaker_id: id, ms: 0, turns: 0, rank }
      acc.set(key, row)
    }
    row.ms += dur
    if (prev !== key) row.turns++
    prev = key
  }

  const totalMs = [...acc.values()].reduce((sum, r) => sum + r.ms, 0)
  if (totalMs <= 0) return { rows: [], totalMs: 0 }

  const list = [...acc.values()].filter((r) => r.ms > 0)
  const pct = new Map<string, number>()
  for (const r of list) pct.set(keyOf(r.speaker_id), Math.floor((r.ms * 100) / totalMs))
  let left = 100 - [...pct.values()].reduce((a, b) => a + b, 0)
  const byRemainder = [...list].sort(
    (a, b) => ((b.ms * 100) % totalMs) - ((a.ms * 100) % totalMs) || b.ms - a.ms || a.rank - b.rank
  )
  for (const r of byRemainder) {
    if (left <= 0) break
    const k = keyOf(r.speaker_id)
    pct.set(k, (pct.get(k) ?? 0) + 1)
    left--
  }

  const names = new Map(speakers.map((sp) => [sp.id, sp.display_name?.trim() || sp.label]))
  const rows = list
    .sort((a, b) => {
      if (a.speaker_id === null) return b.speaker_id === null ? 0 : 1
      if (b.speaker_id === null) return -1
      return b.ms - a.ms || a.rank - b.rank
    })
    .map((r) => ({
      speaker_id: r.speaker_id,
      name: r.speaker_id === null ? '미지정' : (names.get(r.speaker_id) ?? `화자${r.speaker_id}`),
      ms: r.ms,
      pct: pct.get(keyOf(r.speaker_id)) ?? 0,
      turns: r.turns
    }))
  return { rows, totalMs }
}

/** 1시간 미만 mm:ss, 이상 h:mm:ss. main formatClock 과 같다. */
export function formatTalkMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
