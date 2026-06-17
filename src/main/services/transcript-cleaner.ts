// 전사 후처리 정제 — whisper 환각/반복/filler 제거
// 무음 구간에서 whisper가 직전 문장을 반복 생성하거나("…구경이" 12연속),
// "아"/"음" 같은 비언어 filler를 다량 segment로 만드는 문제를 후처리로 걷어낸다.
// 외부 의존성 없이 Node 내장 zlib만 사용.
import { gzipSync } from 'zlib'
import type { SttSegment } from './meeting-types'

// 단독으로 등장하면 노이즈로 보는 비언어 filler(감탄/주저음).
// '네'/'예'(동의), '그'/'저'(지시어)는 의미를 가질 수 있어 제외 — 오제거 방지.
const FILLER_CHARS = new Set(['아', '어', '음', '으', '흠', '에', '오', '애', '엇', '윽', '읔'])

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
 * 2) segment 내부 즉시 반복 축약
 * 3) compression-ratio가 높은(반복적 환각) segment 제거
 * 4) 인접 중복 segment 병합(텍스트는 버리고 직전 segment의 end_ms만 확장)
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

    const collapsed = collapseInnerRepeat(text)
    if (!collapsed) continue

    if (compressionRatio(collapsed) > 2.4) continue

    // 직전 segment와 정규화 텍스트가 같으면 병합(반복 환각의 연속 출력 제거)
    const prev = out[out.length - 1]
    if (prev && normalize(prev.text) === normalize(collapsed)) {
      prev.end_ms = Math.max(prev.end_ms, seg.end_ms)
      continue
    }

    out.push({ ...seg, text: collapsed })
  }

  return out
}
