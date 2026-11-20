// 전사 세그먼트 분할(maxLen) 결과 방어용 순수 헬퍼 — whisper-adapter가 사용한다.
//
// whisper.node 1.0.22는 tokenTimestamps:true일 때만 maxLen(UTF-8 글자 수 기준)으로 세그먼트를
// 토큰 경계에서 자른다. 토큰 경계가 한 글자의 UTF-8 바이트 중간에 걸리면 잘린 양쪽 세그먼트에
// 깨진 글자(U+FFFD)가 생긴다 — 실측으로 확인됨(2026-11-18): 실제 녹음 3건(28초 청크 128개, 약 60분,
// large-v3-turbo-q8_0) 중 한 파일에서 세그먼트 566개 중 8개에 U+FFFD가 나왔다(나머지 두 파일은 0건).
// 같은 실측에서 비정상 타임스탬프는 0건이었지만, 토큰 단위 타임스탬프는 세그먼트 단위보다 흔들릴 수
// 있어 방어적으로 보정한다. 여기 함수들은 그 두 가지를 판정·보정한다.
import type { SttSegment } from '../meeting-types'

// 유니코드 대체 문자. 네이티브가 불완전한 UTF-8 바이트열을 문자열로 바꿀 때 들어간다.
const REPLACEMENT_CHAR = '�'

/**
 * 한 번의 네이티브 전사 결과에 깨진 글자(U+FFFD)가 든 세그먼트가 하나라도 있으면 true.
 * true면 호출측이 분할 옵션 없이 그 호출을 1회 다시 전사한다.
 */
export function hasBrokenText(segments: ReadonlyArray<{ text: string }>): boolean {
  return segments.some((s) => typeof s.text === 'string' && s.text.includes(REPLACEMENT_CHAR))
}

/**
 * 세그먼트 타임스탬프를 보정하고 start_ms 오름차순(동률은 원래 순서)으로 정렬한다.
 *  - 음수 → 0, 유한하지 않은 start → 직전 세그먼트의 end(없으면 0), 유한하지 않은 end → start
 *  - maxMs가 주어지면 그 값으로 상한 클램프(청크 길이를 넘는 타임스탬프 방지)
 *  - end < start → end = start
 * 입력 배열·원소는 변형하지 않는다.
 */
export function sanitizeSegmentTimes(segments: SttSegment[], maxMs?: number): SttSegment[] {
  const hasCap = typeof maxMs === 'number' && Number.isFinite(maxMs) && maxMs >= 0
  const cap = (v: number): number => (hasCap ? Math.min(v, maxMs as number) : v)

  let prevEnd = 0
  const fixed = segments.map((s, index) => {
    let start = Number.isFinite(s.start_ms) ? Math.max(0, s.start_ms) : prevEnd
    let end = Number.isFinite(s.end_ms) ? Math.max(0, s.end_ms) : start
    start = cap(start)
    end = cap(end)
    if (end < start) end = start
    prevEnd = end
    return { seg: { ...s, start_ms: start, end_ms: end }, index }
  })

  // 원래 순서를 보조 키로 둬 안정 정렬을 명시적으로 보장한다.
  fixed.sort((a, b) => a.seg.start_ms - b.seg.start_ms || a.index - b.index)
  return fixed.map((f) => f.seg)
}
