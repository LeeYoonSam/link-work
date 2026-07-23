// 전사 후처리 정제 — whisper 환각/반복/filler 제거
// 무음 구간에서 whisper가 직전 문장을 반복 생성하거나("…구경이" 12연속),
// "아"/"음" 같은 비언어 filler를 다량 segment로 만드는 문제를 후처리로 걷어낸다.
// 외부 의존성 없이 Node 내장 zlib만 사용.
import { gzipSync } from 'zlib'
import type { SttSegment } from './meeting-types'

// 단독으로 등장하면 노이즈로 보는 비언어 filler(감탄/주저음).
// '네'/'예'(동의), '그'/'저'(지시어)는 의미를 가질 수 있어 제외 — 오제거 방지.
const FILLER_CHARS = new Set(['아', '어', '음', '으', '흠', '에', '오', '애', '엇', '윽', '읔'])

// 근접 윈도 dedup 파라미터: 직전 K개 세그먼트, 그리고 시간 창(ms) 이내만 검사.
// 인접 병합(prev)만으로는 못 잡는 "몇 개 건너뛰고 재등장하는 반복"을 걷어낸다.
const PROXIMITY_WINDOW = 8
const PROXIMITY_TIME_MS = 30000
// 정규화 후 이 길이 이하는 자연스러운 맞장구("네", "그렇죠" 등)로 보고 dedup에서 제외 — 오제거 방지.
const BACKCHANNEL_MAX_LEN = 4

// 세그먼트 내부 어절 루프 붕괴 파라미터.
const NGRAM_UNIT = 4 // 반복 판정 최소 구절 길이(어절 수) — 짧은 반복은 자연 발화일 수 있어 건드리지 않는다
const NGRAM_MIN_REPEATS = 3 // 이 횟수 이상 연속 반복될 때만 붕괴

// 비교용 정규화: 공백/구두점 제거 + 소문자
function normalize(text: string): string {
  return text.replace(/[\s.,!?…·~"'`()\-]/g, '').toLowerCase()
}

// 반복 탐지용 compression ratio. 반복이 많을수록 gzip이 잘 압축되어 비율이 높아진다.
// whisper의 compression_ratio_threshold(2.4)와 동일 직관. 실제 음성은 보통 < 2.0.
function compressionRatio(text: string): number {
  const raw = Buffer.from(text, 'utf8')
  if (raw.length < 60) return 0 // 짧은 문장은 gzip 오버헤드로 비율이 왜곡되므로 검사 제외
  return raw.length / gzipSync(raw).length
}

// segment 내부 즉시 반복 축약: "문장 문장 문장" → "문장"
function collapseInnerRepeat(text: string): string {
  return text.replace(/(.{2,}?)(?:\s*\1){2,}/g, '$1').trim()
}

// words[a..a+p)와 words[b..b+p) 블록이 어절 단위로 완전히 같은지 비교
function blocksEqual(words: string[], a: number, b: number, p: number): boolean {
  for (let k = 0; k < p; k++) {
    if (words[a + k] !== words[b + k]) return false
  }
  return true
}

/**
 * segment 내부 어절 루프 붕괴.
 * 같은 구절(어절 unit개 이상)이 minRepeats회 이상 연속 반복되면 1회만 남긴다.
 * whisper가 한 세그먼트 안에서 동일 문장을 수십~수백 번 되풀이하는 환각 대응.
 * 공백 기준 어절 단위로 판정하며, 반복 구절이 unit(4어절) 미만이면 자연 발화일 수 있어 건드리지 않는다.
 * 붕괴가 전혀 없으면 원본 문자열을 그대로 반환(공백 재조합으로 인한 변형 방지).
 */
export function collapseNgramLoop(
  text: string,
  unit = NGRAM_UNIT,
  minRepeats = NGRAM_MIN_REPEATS
): string {
  const words = text.split(/\s+/).filter(Boolean)
  // 최소 한 구절이라도 minRepeats회 들어갈 분량이 아니면 검사 불필요
  if (words.length < unit * minRepeats) return text

  const out: string[] = []
  let changed = false
  let i = 0
  while (i < words.length) {
    let collapsed = false
    // minRepeats회가 들어갈 수 있는 최대 주기까지만 탐색. 최소 주기부터 보아 실제 반복 단위를 잡는다.
    const maxPeriod = Math.floor((words.length - i) / minRepeats)
    for (let p = unit; p <= maxPeriod; p++) {
      let count = 1
      while (i + (count + 1) * p <= words.length && blocksEqual(words, i, i + count * p, p)) {
        count++
      }
      if (count >= minRepeats) {
        for (let k = 0; k < p; k++) out.push(words[i + k]) // 1회분만 남김
        i += count * p
        collapsed = true
        changed = true
        break
      }
    }
    if (!collapsed) {
      out.push(words[i])
      i++
    }
  }
  return changed ? out.join(' ') : text
}

/**
 * 근접 윈도 dedup 판정.
 * recent(시간순 정렬된 정제 결과)의 마지막 windowSize개 중, startMs에서 timeWindowMs 이내에
 * 정규화 텍스트가 동일한 세그먼트가 있으면 true(= 제거 대상).
 * 정규화 후 BACKCHANNEL_MAX_LEN 이하인 짧은 맞장구는 자연스러운 반복이므로 항상 false(보존).
 */
export function hasRecentDuplicate(
  text: string,
  startMs: number,
  recent: SttSegment[],
  windowSize = PROXIMITY_WINDOW,
  timeWindowMs = PROXIMITY_TIME_MS
): boolean {
  const norm = normalize(text)
  if (norm.length <= BACKCHANNEL_MAX_LEN) return false
  const from = Math.max(0, recent.length - windowSize)
  for (let i = recent.length - 1; i >= from; i--) {
    const cand = recent[i]
    // recent는 start_ms 오름차순 → 뒤에서부터 보면 간격이 커진다. 시간 창을 벗어나면 더 볼 필요 없다.
    if (startMs - cand.start_ms > timeWindowMs) break
    if (normalize(cand.text) === norm) return true
  }
  return false
}

// filler-only 또는 무의미 segment 판정
function isNoise(stripped: string): boolean {
  if (stripped.length === 0) return true
  if (stripped.length === 1) return true // 한 글자 단독 발화는 타임라인 노이즈
  // 모든 글자가 filler 문자로만 구성("아아", "어어", "음음" 등)
  return [...stripped].every((ch) => FILLER_CHARS.has(ch))
}

/**
 * STT segment 배열을 정제한다.
 * 1) filler-only / 1글자 segment 제거
 * 2) segment 내부 어절 루프 붕괴 + 문자 단위 즉시 반복 축약
 * 3) compression-ratio가 높은(반복적 환각) segment 제거
 * 4) 인접 중복 segment 병합(텍스트는 버리고 직전 segment의 end_ms만 확장)
 * 5) 근접 윈도 dedup(직전 K개·30초 이내에 재등장한 동일 발언 제거, 짧은 맞장구 제외)
 * 입력 순서를 시간순으로 가정하지 않고 start_ms로 정렬 후 처리한다.
 */
export function cleanSegments(segments: SttSegment[]): SttSegment[] {
  const sorted = [...segments].sort((a, b) => a.start_ms - b.start_ms)
  const out: SttSegment[] = []

  for (const seg of sorted) {
    const text = seg.text.trim()
    if (!text) continue

    const stripped = text.replace(/[\s.,!?…·~"'`()\-]/g, '')
    if (isNoise(stripped)) continue

    // 세그먼트 내부 어절 루프를 먼저 붕괴한 뒤 문자 단위 즉시 반복까지 축약
    const collapsed = collapseInnerRepeat(collapseNgramLoop(text))
    if (!collapsed) continue

    if (compressionRatio(collapsed) > 2.4) continue

    // 직전 segment와 정규화 텍스트가 같으면 병합(반복 환각의 연속 출력 제거)
    const prev = out[out.length - 1]
    if (prev && normalize(prev.text) === normalize(collapsed)) {
      prev.end_ms = Math.max(prev.end_ms, seg.end_ms)
      continue
    }

    // 근접 윈도 dedup: 직전 K개·30초 이내에 같은 발언이 재등장하면 제거(짧은 맞장구는 보존)
    if (hasRecentDuplicate(collapsed, seg.start_ms, out)) continue

    out.push({ ...seg, text: collapsed })
  }

  return out
}
