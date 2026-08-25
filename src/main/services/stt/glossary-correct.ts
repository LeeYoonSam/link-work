// 용어집 기반 전사 후보정 — 순수 함수(DB·파일 I/O 없음, 단위 테스트 대상).
//
// whisper initial_prompt는 힌트일 뿐 강제력이 없어 사내 고유명사는 여전히 음차로 잘못 적힌다
// ("LinkWork" → "링크워크", "링크 워크"). 사용자가 등록한 정답 표기(term)와 오인식 표기(aliases)로
// 전사 후 결정론적으로 치환한다. LLM을 쓰지 않으므로 재현 가능하고 비용이 없다.
//
// 오치환이 가장 큰 위험이므로 규칙을 보수적으로 잡았다:
//  - 2자 미만 alias는 무시(한 글자 치환은 오탐이 폭발한다).
//  - 라틴/숫자 alias는 단어 경계 안에서만 치환("link"가 "linkage"를 건드리지 않게).
//  - 한글 alias는 조사 결합을 허용하되(경계 없음), 문자 사이 공백 0~1개까지만 허용해
//    띄어쓰기 변형("링크 워크")을 잡는다. 3자 미만이면 공백 허용 없이 정확 일치만.
//  - 이미 정답 표기(term)가 들어 있는 자리는 플레이스홀더로 보호해 재치환하지 않는다.
import type { SttSegment } from '../meeting-types'

export interface GlossaryRule {
  term: string
  aliases: string[]
}

// alias는 이 길이 미만이면 무시한다(오탐 방지).
const MIN_ALIAS_CHARS = 2
// 한글 alias에 공백 변형(`\s?`)을 허용하는 최소 길이.
const MIN_FLEXIBLE_SPACE_CHARS = 3

// 플레이스홀더 인코딩: 보호 구간을 사설 영역(PUA) 문자 1개로 표현한다.
// 숫자 인덱스를 쓰면 뒤이어 도는 alias 정규식이 플레이스홀더 내부를 건드릴 수 있어 PUA를 쓴다.
const PH_OPEN = '\uE000'
const PH_CLOSE = '\uE001'
const PH_BASE = 0xe100
const PH_MAX = 0xefff
const PH_PATTERN = /\uE000([\uE100-\uEFFF])\uE001/g

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 치환 결과를 플레이스홀더로 감춰 뒤이어 도는 규칙이 다시 건드리지 못하게 한다.
 * 슬롯이 고갈되면(현실적으로 도달 불가) 보호를 포기하고 값을 그대로 둔다.
 */
function stash(saved: string[], value: string): string {
  const code = PH_BASE + saved.length
  if (code > PH_MAX) return value
  saved.push(value)
  return `${PH_OPEN}${String.fromCharCode(code)}${PH_CLOSE}`
}

function unstash(text: string, saved: string[]): string {
  if (saved.length === 0) return text
  return text.replace(PH_PATTERN, (_m, c: string) => saved[c.charCodeAt(0) - PH_BASE] ?? '')
}

/**
 * alias 하나를 치환용 정규식으로 만든다. 규칙은 파일 상단 주석 참고.
 */
function buildAliasRegex(alias: string): RegExp | null {
  const trimmed = alias.trim()
  if (trimmed.length < MIN_ALIAS_CHARS) return null

  if (!HANGUL.test(trimmed)) {
    // 라틴/숫자/기호만 — 앞뒤가 영숫자면 다른 단어의 일부이므로 치환하지 않는다.
    return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(trimmed)}(?![A-Za-z0-9])`, 'gi')
  }

  // 한글 포함 — 조사가 뒤에 붙는 게 정상이므로 경계를 걸지 않는다.
  const compact = trimmed.replace(/\s+/g, '')
  if (compact.length < MIN_ALIAS_CHARS) return null
  if (compact.length < MIN_FLEXIBLE_SPACE_CHARS) {
    // 짧은 한글 alias까지 공백 변형을 허용하면 오탐이 커진다 → 정확 일치만.
    return new RegExp(escapeRegExp(compact), 'gi')
  }
  // 문자 사이 공백 0~1개 허용 → "링크워크"와 "링크 워크"를 함께 잡는다.
  const pattern = Array.from(compact).map(escapeRegExp).join('\\s?')
  return new RegExp(pattern, 'gi')
}

/**
 * 규칙 목록을 치환 순서가 확정된 매처 배열로 정규화한다(테스트용으로도 노출).
 *  - alias trim 후 2자 미만 제외, term과 대소문자 무시 동일하면 제외.
 *  - 같은 alias가 여러 term에 있으면 먼저 등록된 규칙이 이긴다.
 *  - 긴 alias부터 적용해 짧은 alias가 긴 표기의 일부만 갉아먹는 것을 막는다.
 */
export function buildAliasMatchers(rules: GlossaryRule[]): Array<{ term: string; regex: RegExp }> {
  const seen = new Set<string>()
  const candidates: Array<{ term: string; alias: string }> = []

  for (const rule of rules ?? []) {
    const term = rule?.term?.trim()
    if (!term) continue
    for (const rawAlias of rule.aliases ?? []) {
      const alias = rawAlias?.trim()
      if (!alias || alias.length < MIN_ALIAS_CHARS) continue
      if (alias.toLowerCase() === term.toLowerCase()) continue
      const key = alias.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ term, alias })
    }
  }

  candidates.sort((a, b) => b.alias.length - a.alias.length)

  const matchers: Array<{ term: string; regex: RegExp }> = []
  for (const c of candidates) {
    const regex = buildAliasRegex(c.alias)
    if (regex) matchers.push({ term: c.term, regex })
  }
  return matchers
}

/**
 * 텍스트에 이미 들어 있는 정답 표기(term)를 플레이스홀더로 치환해 보호한다.
 * alias가 term을 부분 포함하는 경우(예: term "WBS", alias "WBS 표")에도 term 쪽이 우선한다.
 */
function protectTerms(text: string, terms: string[], saved: string[]): string {
  let out = text
  // 긴 term부터 보호해야 짧은 term이 긴 term의 일부만 가리는 일이 없다.
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    if (!term) continue
    out = out.replace(new RegExp(escapeRegExp(term), 'gi'), (m) => stash(saved, m))
  }
  return out
}

/**
 * 세그먼트 텍스트에 용어집 후보정을 적용한다.
 * 변경된 세그먼트만 새 객체로 교체하고, `text_corrected`(사용자 수정 플래그)는 건드리지 않는다.
 */
export function applyGlossary(
  segments: SttSegment[],
  rules: GlossaryRule[]
): { segments: SttSegment[]; replacements: number } {
  const matchers = buildAliasMatchers(rules)
  if (matchers.length === 0 || segments.length === 0) {
    return { segments, replacements: 0 }
  }

  const terms = Array.from(
    new Set(
      (rules ?? []).map((r) => r?.term?.trim()).filter((t): t is string => Boolean(t))
    )
  )

  let replacements = 0
  const out = segments.map((seg) => {
    const original = seg.text
    if (!original) return seg

    const saved: string[] = []
    let text = protectTerms(original, terms, saved)
    let changed = 0

    for (const { term, regex } of matchers) {
      // 정규식 객체를 재사용하므로 lastIndex를 초기화한다(g 플래그 상태 누수 방지).
      regex.lastIndex = 0
      text = text.replace(regex, () => {
        changed++
        // 치환 결과도 감춰 뒤이어 도는 짧은 alias가 다시 갉아먹지 못하게 한다.
        return stash(saved, term)
      })
    }

    if (changed === 0) return seg
    replacements += changed
    return { ...seg, text: unstash(text, saved) }
  })

  return { segments: out, replacements }
}
