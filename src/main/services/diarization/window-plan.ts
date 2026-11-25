// 화자분리 임베딩 창 계획 — 순수 함수.
// STT 세그먼트 위에 짧은 창을 깔아 창마다 화자 임베딩을 뽑는다. 네이티브(sherpa) 입력은 호출당
// WINDOW_MAX_SEC 이하로 제한한다(긴 입력에서 onnxruntime 이 배포 Electron 을 죽이는 문제 회피).

/** 세그먼트가 이 길이 미만이면 창을 만들지 않는다(임베딩 신뢰 불가). */
export const MIN_SEGMENT_SEC = 0.5
/** 긴 세그먼트에 까는 창 길이. */
export const WINDOW_SEC = 1.5
/** 창 간격(hop). 창은 WINDOW_SEC - HOP_SEC 만큼 겹친다. */
export const HOP_SEC = 0.75
/** 세그먼트가 이 길이 이하면 통째로 창 1개. 네이티브 입력 길이 상한이기도 하다. */
export const WINDOW_MAX_SEC = WINDOW_SEC * 1.5

/**
 * 목소리 임베딩 식별자(모델 + 창 설정). 저장된 목소리 표본은 이 값이 같을 때만 서로 비교한다.
 * 창 설정이나 모델을 바꾸면 이 값도 바꾼다.
 */
export const VOICE_EMBEDDING_MODEL = '3dspeaker_campplus_sv_zh_en_16k_common_advanced/w1.5h0.75'

export interface PlannedWindow {
  /** 시작(초) */
  s: number
  /** 끝(초) */
  e: number
  /** 원래 세그먼트 인덱스(입력 배열 기준) */
  si: number
}

/**
 * 세그먼트(ms) 위에 임베딩 창(초)을 계획한다.
 * - 끝은 오디오 길이(audioSec)로 자른다. 잘린 길이가 MIN_SEGMENT_SEC 미만이면 제외.
 * - WINDOW_MAX_SEC 이하면 세그먼트 전체가 창 1개.
 * - 그보다 길면 WINDOW_SEC 창을 HOP_SEC 간격으로 깔고, 마지막 창은 세그먼트 끝에 맞춘다.
 * 세그먼트는 시작 시각 순(같으면 입력 순)으로 처리하므로 같은 세그먼트의 창은 결과에서 연속한다.
 */
export function planWindows(
  segments: ReadonlyArray<{ start_ms: number; end_ms: number }>,
  audioSec: number
): PlannedWindow[] {
  const wins: PlannedWindow[] = []
  const order = segments.map((_, i) => i).sort((a, b) => segments[a].start_ms - segments[b].start_ms || a - b)
  for (const si of order) {
    const s = Math.max(0, segments[si].start_ms / 1000)
    const e = Math.min(segments[si].end_ms / 1000, audioSec)
    const d = e - s
    if (!(d >= MIN_SEGMENT_SEC)) continue
    if (d <= WINDOW_MAX_SEC) {
      wins.push({ s, e, si })
      continue
    }
    let a = s
    for (;;) {
      if (a + WINDOW_SEC >= e) {
        wins.push({ s: e - WINDOW_SEC, e, si })
        break
      }
      wins.push({ s: a, e: a + WINDOW_SEC, si })
      a += HOP_SEC
    }
  }
  return wins
}
