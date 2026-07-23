// whisper initial_prompt(native 옵션명 `prompt`) 조립 — 한국어 회의/면접 전사에서
// 고유명사(참석자·프로젝트·주제) 오인식을 줄이기 위한 도메인 컨텍스트 힌트를 만든다.
//
// 제약(중요): whisper는 프롬프트의 마지막 224토큰만 반영하고, 장황하거나 단정적인
// 프롬프트는 과교정 환각(프롬프트 문구를 전사에 그대로 지어냄)을 유발한다. 그래서 여기서는
// 자연스러운 한국어 한두 문장 + 핵심 명사 나열로 짧고 보수적으로만 유지한다(총 300자 이내).
// 이 상한과 어조를 임의로 늘리면 환각이 늘어날 수 있으니 확장 시 주의할 것.

export interface InitialPromptInput {
  kind: string // 'meeting' | 'interview'
  language: string // meetings.language, 기본 'ko'
  title?: string | null
  projectName?: string | null
  calendarEventTitle?: string | null
  speakerNames?: string[] // meeting_speakers.display_name (사용자 지정 실명만)
}

// 프롬프트 총 길이 상한. 초과 시 항목 단위로 잘라 224토큰 반영 창을 넘지 않게 한다.
const MAX_PROMPT_CHARS = 300

// 참석자 힌트 상한(명). 너무 많은 이름을 나열하면 과교정 환각 위험이 커진다.
const MAX_SPEAKERS = 5

// 자동 부여되는 기본 제목은 힌트 가치가 없으므로 주제로 넣지 않는다(recording.ipc와 동일 규약).
const DEFAULT_TITLES = new Set(['제목 없는 회의', '제목 없는 면접'])

/**
 * 화자 실명 목록을 공백 제거 · 빈 문자열 제거 · 중복 제거하고 최대 MAX_SPEAKERS명까지 자른다.
 */
function normalizeSpeakerNames(names: string[] | undefined): string[] {
  if (!names || names.length === 0) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of names) {
    const name = raw?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push(name)
    if (result.length >= MAX_SPEAKERS) break
  }
  return result
}

/**
 * 회의 메타데이터로 whisper initial_prompt를 조립한다.
 * 한국어 계열이 아니면 undefined(한국어 전제 프롬프트라 오히려 방해).
 * 기본 문장만 남더라도 그대로 반환(무해한 언어 힌트 역할).
 */
export function buildInitialPrompt(input: InitialPromptInput): string | undefined {
  // 한국어 전제 프롬프트이므로 비한국어(en/ja 등) 전사에는 붙이지 않는다.
  if (!input.language || !input.language.toLowerCase().startsWith('ko')) {
    return undefined
  }

  const base =
    input.kind === 'interview'
      ? '다음은 한국어 채용 면접 녹음입니다.'
      : '다음은 한국어 회의 녹음입니다.'

  // base는 무조건 포함(수십 자 수준). 이후 항목은 우선순위(주제 > 프로젝트 > 일정 > 참석자)
  // 순으로 누적하되, 추가 시 상한을 넘기면 그 항목은 통째로 제외한다. 결과는 항상 300자 이내.
  const parts: string[] = [base]
  let length = base.length

  const tryAppend = (fragment: string): void => {
    if (length + fragment.length > MAX_PROMPT_CHARS) return
    parts.push(fragment)
    length += fragment.length
  }

  const title = input.title?.trim()
  if (title && !DEFAULT_TITLES.has(title)) {
    tryAppend(` 주제: ${title}.`)
  }

  const projectName = input.projectName?.trim()
  if (projectName) {
    tryAppend(` 프로젝트: ${projectName}.`)
  }

  // 일정 제목이 회의 제목과 같으면 중복이므로 생략한다.
  const calendarEventTitle = input.calendarEventTitle?.trim()
  if (calendarEventTitle && calendarEventTitle !== title) {
    tryAppend(` 일정: ${calendarEventTitle}.`)
  }

  const speakerNames = normalizeSpeakerNames(input.speakerNames)
  if (speakerNames.length > 0) {
    tryAppend(` 참석자: ${speakerNames.join(', ')}.`)
  }

  return parts.join('')
}
