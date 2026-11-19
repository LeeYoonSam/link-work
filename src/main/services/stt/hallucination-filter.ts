// 전사 환각 문구 필터 — 반복 패턴(transcript-cleaner)으로는 못 잡는 두 유형을 걷어낸다.
//  1) 널리 알려진 환각 문구: whisper가 무음·잡음 구간에서 학습 데이터(유튜브 자막)의 상투 문구를
//     지어내는 현상("시청해주셔서 감사합니다" 등).
//  2) 프롬프트 에코: initial_prompt 문구("다음은 한국어 회의 녹음입니다." 등)가 전사에 그대로 나오는 현상.
// 근거: arXiv 2501.11378 — VAD 뒤에 반복 제거 + 환각 문구 목록 제거를 더했을 때 WER이 가장 낮았다.
//
// 원칙: 실제 발화 오삭제 방지가 최우선이다. 세그먼트 전체가 환각 문구(들)로만 이루어졌을 때만 지우고,
// 부분 포함은 절대 지우지 않는다("시청률이 올랐습니다", "감사합니다"는 보존).

import type { SttSegment } from '../meeting-types'

// 비교용 정규화: NFC + 공백·구두점·기호 제거 + 소문자.
function normalize(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase()
}

// 알려진 환각 문구(정규화된 텍스트에 대한 정규식 조각).
// ⚠️ 자체 수집 목록이라 근거가 약하다 — 유튜브 자막 유래로 회의에서 단독 발화로 나올 리 없는 문구만
//    보수적으로 담는다. "감사합니다", "네", "안녕하세요" 같은 일상 발화는 절대 넣지 말 것.
//    "다음 시간에 뵙겠습니다"처럼 회의 마무리 말로 실제 쓰일 수 있는 문구도 넣지 않는다.
const BLOCKLIST_PATTERNS: readonly string[] = [
  // 시청해 주셔서 감사합니다 / 영상 시청해주셔서 감사합니다 / 끝까지 시청해주셔서 감사드립니다
  '(?:오늘도|끝까지|영상)*시청해주셔서(?:정말|대단히)?감사(?:합니다|드립니다)',
  // 구독과 좋아요 부탁드립니다 / 구독 좋아요 알림설정 (부탁드립니다)
  '구독(?:과|하고)?좋아요(?:와|그리고)?(?:알림설정)?(?:까지)?(?:부탁드립니다|부탁드려요|눌러주세요)?',
  // 다음 영상에서 만나요
  '다음영상에서(?:또)?(?:만나요|뵙겠습니다|만나겠습니다)',
  // 한글자막 by 홍길동 / 자막 by …  — "by" 표식이 있을 때만(일반 발화 오삭제 방지)
  '(?:한글)?자막(?:제공)?by[\\p{L}\\p{N}]{1,20}',
  // 자막 제공 (및 광고)
  '자막제공(?:및광고)?',
  // MBC 뉴스 홍길동입니다 / KBS 뉴스 홍길동 기자입니다
  '(?:mbc|kbs|sbs|ytn|jtbc)뉴스[가-힣]{2,6}입니다'
]

// 세그먼트가 위 문구들"로만" 이루어졌는지(1개 이상 연접, 전체 일치) 판정.
const BLOCKLIST_RE = new RegExp(`^(?:${BLOCKLIST_PATTERNS.join('|')})+$`, 'u')

// 프롬프트 전체의 연속 부분 문자열로 판정할 최소 길이(정규화 글자 수).
// 짧은 일치(용어 하나만 말한 실제 발화 "LinkWork" 등)는 지우지 않는다.
const PROMPT_SUBSTRING_MIN_LEN = 10
// 프롬프트 조각 전체 일치로 판정할 최소 길이. 라벨("주제", "용어" 등 2자)+값을 담은 조각만 대상이 된다.
const PROMPT_FRAGMENT_MIN_LEN = 4

/**
 * 프롬프트를 문장 조각으로 나눠 정규화한다. 마침표는 뒤에 공백·끝이 올 때만 구분자로 본다
 * ("v1.2" 같은 제목이 쪼개지지 않도록). 예: "다음은 한국어 회의 녹음입니다. 주제: X. 용어: A, B."
 * → ["다음은한국어회의녹음입니다", "주제x", "용어ab"]
 */
function promptFragments(prompt: string): string[] {
  return prompt
    .split(/[.。!?](?=\s|$)|\n/)
    .map(normalize)
    .filter((f) => f.length >= PROMPT_FRAGMENT_MIN_LEN)
}

function isPromptEcho(norm: string, fragments: string[], wholePrompt: string): boolean {
  if (fragments.includes(norm)) return true
  return norm.length >= PROMPT_SUBSTRING_MIN_LEN && wholePrompt.includes(norm)
}

/**
 * 알려진 환각 문구·프롬프트 에코 세그먼트를 제거한다. 입력 배열은 변형하지 않는다.
 *  - 블록리스트: 정규화 텍스트가 알려진 환각 문구(들)로만 이루어졌을 때만 제거(부분 포함은 보존)
 *  - 프롬프트 에코(opts.prompt가 있을 때): 프롬프트 조각과 전체 일치하거나,
 *    프롬프트 전체의 연속 부분 문자열이면서 10자 이상일 때 제거
 * removed는 제거된 세그먼트 수.
 */
export function filterHallucinations(
  segments: SttSegment[],
  opts?: { prompt?: string }
): { segments: SttSegment[]; removed: number } {
  const prompt = opts?.prompt?.trim()
  const fragments = prompt ? promptFragments(prompt) : []
  const wholePrompt = prompt ? normalize(prompt) : ''

  const kept: SttSegment[] = []
  for (const seg of segments) {
    const norm = normalize(seg.text ?? '')
    // 정규화 후 비는 세그먼트(기호뿐 등)는 이 필터의 판정 대상이 아니다 — 그대로 둔다.
    if (norm.length > 0) {
      if (BLOCKLIST_RE.test(norm)) continue
      if (prompt && isPromptEcho(norm, fragments, wholePrompt)) continue
    }
    kept.push(seg)
  }
  return { segments: kept, removed: segments.length - kept.length }
}
