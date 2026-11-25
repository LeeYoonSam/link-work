// 화자분리 결과에 붙일 사용자 안내 문장(note) — 순수 함수.
// diarizeWithFallback이 품질이 강등됐을 때만 note를 채운다.

/** 에러 객체에서 사람이 읽을 원인 메시지를 뽑는다. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** 원인 메시지가 있으면 ` (원인)`을 붙인다. */
function withCause(sentence: string, cause?: string): string {
  const c = cause?.trim()
  return c ? `${sentence} (${c})` : sentence
}

type SherpaUnavailableKind = 'ensure-failed' | 'not-installed' | 'models-missing'

/** sherpa를 쓸 수 없어 화자 구분 없이(단일 화자) 끝난 경우. */
export function sherpaUnavailableNote(kind: SherpaUnavailableKind, cause?: string): string {
  switch (kind) {
    case 'ensure-failed':
      return withCause('화자분리 모델을 준비하지 못해 화자를 구분하지 않았습니다.', cause)
    case 'not-installed':
      return '화자분리 엔진(sherpa-onnx)이 설치되어 있지 않아 화자를 구분하지 않았습니다.'
    case 'models-missing':
      return '화자분리 모델이 없어 화자를 구분하지 않았습니다.'
  }
}

/** sherpa 실행이 실패해 화자 구분 없이 끝난 경우. */
export function sherpaFailedNote(cause?: string): string {
  return withCause('화자분리에 실패해 화자를 구분하지 않았습니다.', cause)
}

/** sherpa가 화자 구간을 하나도 내지 못한 경우. */
export function sherpaEmptyNote(): string {
  return '화자분리 결과가 비어 있어 화자를 구분하지 않았습니다.'
}

/** 2-스테이지(참석 3명 이상)에서 sherpa를 못 써 채널 2화자(나/상대)로 강등된 경우. */
export function twoStageDegradedNote(
  reason: SherpaUnavailableKind | 'failed' | 'not-split',
  cause?: string
): string {
  const tail = '나/상대 2명으로만 구분했습니다.'
  switch (reason) {
    case 'ensure-failed':
      return withCause(`화자분리 모델을 준비하지 못해 ${tail}`, cause)
    case 'not-installed':
      return `화자분리 엔진(sherpa-onnx)이 설치되어 있지 않아 ${tail}`
    case 'models-missing':
      return `화자분리 모델이 없어 ${tail}`
    case 'failed':
      return withCause(`화자분리에 실패해 ${tail}`, cause)
    case 'not-split':
      return `상대편 화자를 나누지 못해 ${tail}`
  }
}
