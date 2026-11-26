/**
 * 회의 요약 형식(템플릿). 회의 유형별로 프롬프트의 목적 문구·주제 이름 후보·출력 키 힌트를 정한다.
 * 순수 모듈: 다른 서비스를 import 하지 않는다(meeting-summary.ts가 이 모듈을 쓴다).
 */

// 프롬프트의 "출력 키" 블록. 템플릿은 keyHints로 이 블록의 키 줄 묶음 뒤에 한 줄씩만 덧붙인다.
export const MEETING_OUTPUT_KEYS = `출력 키
- tldr(string): 회의 전체의 결론 2~3문장.
- keywords(string[]): 회의에서 반복해 나온 핵심 명사구 5~10개. 전사록의 표기를 그대로 쓰세요. 중복 금지. 5개를 채울 수 없으면 있는 만큼만 쓰세요.
- topics: [{title, start, points}] 회의를 시간순 주제(안건) 3~8개로 나누세요. 10분 미만 회의는 1~3개도 됩니다.
  - title: 주제를 나타내는 명사구. 30자 이하.
  - start: 그 주제의 논의가 시작된 줄의 "mm:ss".
  - points(string[]): 그 주제에서 나온 사실·주장·합의 2~5개.
  - start 오름차순으로 나열하세요.
- decisions: [{text, at}] 회의에서 확정된 결정. at은 결정이 내려진 줄의 "mm:ss".
- action_items: [{text, assignee, due, at}] 회의 뒤에 누군가 할 일. due는 전사록에 나온 기한 표현을 그대로 쓰세요. 날짜가 명확하면 "YYYY-MM-DD". 없으면 null.
- open_questions: [{text, at}] 제기됐지만 회의 안에서 답이나 결정이 나오지 않은 질문·쟁점.`

export type MeetingTemplateId = 'default' | 'one_on_one' | 'standup' | 'review'
export type OutputKey = 'tldr' | 'keywords' | 'topics' | 'decisions' | 'action_items' | 'open_questions'

export interface MeetingTemplate {
  id: MeetingTemplateId
  name: string
  /** 프롬프트 [회의 형식] 블록의 첫 줄. ''이면 목적 문구 없음. */
  purpose: string
  /** topics.title로 우선 쓸 이름 후보. */
  topicTitles: string[]
  /** 출력 키별로 덧붙일 "이 회의 유형" 힌트. */
  keyHints: Partial<Record<OutputKey, string>>
  /** 명시 형식이 없을 때 제목으로 자동 판별하는 패턴. */
  titlePattern?: RegExp
}

export const MEETING_TEMPLATES: readonly MeetingTemplate[] = [
  { id: 'default', name: '기본', purpose: '', topicTitles: [], keyHints: {} },
  {
    id: 'one_on_one',
    name: '1:1',
    purpose: '1:1 미팅입니다. 두 사람의 현재 상태, 진행, 막힌 점, 피드백, 성장을 중심으로 정리하세요.',
    topicTitles: ['체크인', '진행 상황', '막힌 점', '피드백', '성장·커리어'],
    keyHints: { tldr: '상대의 현재 상태와 핵심 약속 중심', action_items: '양쪽이 한 약속 모두' },
    titlePattern: /1\s*on\s*1|1:1|1-on-1|원온원|일대일/i
  },
  {
    id: 'standup',
    name: '스탠드업',
    purpose: '짧은 진행 공유 회의(스탠드업)입니다. 사람별 지난 진행, 오늘 할 일, 블로커를 중심으로 정리하세요.',
    topicTitles: ['지난 진행', '오늘 할 일', '블로커'],
    keyHints: { open_questions: '블로커 중 해결 담당이 정해지지 않은 것' },
    titlePattern: /스탠드업|데일리|daily|stand-?up|스크럼/i
  },
  {
    id: 'review',
    name: '리뷰·회고',
    purpose: '검토·회고 회의입니다. 검토 대상, 잘된 점, 문제점과 원인, 개선안을 중심으로 정리하세요.',
    topicTitles: ['검토 대상', '잘된 점', '문제점·원인', '개선안'],
    keyHints: { decisions: '승인·반려·보류 판정을 명시' },
    titlePattern: /리뷰|review|회고|retro|KPT|포스트모템|post-?mortem/i
  }
]

/** 제목을 비워 두었을 때 붙는 기본 제목. 이 제목으로는 형식을 판별하지 않는다. */
export const UNTITLED_TITLES = ['제목 없는 회의', '제목 없는 면접']

export function isTemplateId(v: unknown): v is MeetingTemplateId {
  return typeof v === 'string' && MEETING_TEMPLATES.some((t) => t.id === v)
}

export function getTemplate(id: MeetingTemplateId): MeetingTemplate {
  return MEETING_TEMPLATES.find((t) => t.id === id) ?? MEETING_TEMPLATES[0]
}

/**
 * 명시 형식이 유효하면 그 형식('default' 포함). 아니면 제목으로 판별한다:
 * 빈 제목·기본 제목은 default, 그 외 one_on_one → standup → review 순으로 먼저 맞는 것, 없으면 default.
 */
export function resolveTemplate(
  explicit: string | null | undefined,
  title: string | null | undefined
): MeetingTemplate {
  if (isTemplateId(explicit)) return getTemplate(explicit)
  const t = (title ?? '').trim()
  if (!t || UNTITLED_TITLES.includes(t)) return getTemplate('default')
  for (const id of ['one_on_one', 'standup', 'review'] as const) {
    const tpl = getTemplate(id)
    if (tpl.titlePattern && tpl.titlePattern.test(t)) return tpl
  }
  return getTemplate('default')
}

/**
 * MEETING_OUTPUT_KEYS에 템플릿의 keyHints를 끼운다. 각 키 줄(`- key(` 또는 `- key:`)과
 * 그 뒤의 `  - ` 하위 줄 묶음이 끝나는 자리에 `  - 이 회의 유형: {hint}` 한 줄을 넣는다.
 */
export function buildOutputKeys(t: MeetingTemplate): string {
  const hints = t.keyHints
  if (Object.keys(hints).length === 0) return MEETING_OUTPUT_KEYS
  const lines = MEETING_OUTPUT_KEYS.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    out.push(line)
    i++
    const key = (Object.keys(hints) as OutputKey[]).find(
      (k) => line.startsWith(`- ${k}(`) || line.startsWith(`- ${k}:`)
    )
    if (!key) continue
    while (i < lines.length && lines[i].startsWith('  - ')) {
      out.push(lines[i])
      i++
    }
    out.push(`  - 이 회의 유형: ${hints[key]}`)
  }
  return out.join('\n')
}

/** 프롬프트에 넣을 [회의 형식] 블록. 목적·주제 후보가 모두 없으면 ''. */
export function buildTemplateBlock(t: MeetingTemplate): string {
  if (!t.purpose && t.topicTitles.length === 0) return ''
  const lines = ['[회의 형식]', t.purpose]
  if (t.topicTitles.length > 0) {
    lines.push(
      `topics의 title은 가능하면 다음 이름 중 실제로 다뤄진 것만 그대로 쓰세요: ${t.topicTitles.join(', ')}. 다뤄지지 않은 이름은 만들지 마세요. 목록에 없는 논의는 자유 제목으로 추가하세요.`
    )
  }
  return lines.join('\n')
}

export function listTemplateOptions(): Array<{ id: MeetingTemplateId; name: string }> {
  return MEETING_TEMPLATES.map((t) => ({ id: t.id, name: t.name }))
}
