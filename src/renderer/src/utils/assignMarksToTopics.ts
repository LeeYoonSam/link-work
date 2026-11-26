// 메모(at_ms)를 요약 주제 구간에 배정한다(#11).
// 주제 i는 [start_i, start_{i+1}) 구간을 갖고 마지막 주제는 끝이 없다. 첫 주제 이전 메모는 0번에 둔다.
// 주제 시각이 하나라도 없거나 오름차순이 아니면 구간을 믿을 수 없으므로 전부 배정하지 않는다.
export function assignMarksToTopics<M extends { at_ms: number }>(
  topics: Array<{ start_ms: number | null }>,
  marks: M[]
): { byTopic: Map<number, M[]>; unassigned: M[] } {
  const byTopic = new Map<number, M[]>()
  if (topics.length === 0) return { byTopic, unassigned: [...marks] }
  const starts: number[] = []
  for (const t of topics) {
    if (typeof t.start_ms !== 'number' || !Number.isFinite(t.start_ms)) {
      return { byTopic, unassigned: [...marks] }
    }
    if (starts.length > 0 && t.start_ms < starts[starts.length - 1]) {
      return { byTopic, unassigned: [...marks] }
    }
    starts.push(t.start_ms)
  }

  const sorted = [...marks].sort((a, b) => a.at_ms - b.at_ms)
  for (const m of sorted) {
    // at_ms 이하인 마지막 시작점. 없으면(첫 주제 이전) 0번.
    let idx = 0
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] <= m.at_ms) idx = i
      else break
    }
    const list = byTopic.get(idx)
    if (list) list.push(m)
    else byTopic.set(idx, [m])
  }
  return { byTopic, unassigned: [] }
}
