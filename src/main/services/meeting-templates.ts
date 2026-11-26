/**
 * 회의 요약 형식(템플릿). 회의 유형별로 프롬프트의 목적 문구·주제 이름 후보·출력 키 힌트를 정한다.
 * 순수 모듈: 다른 서비스를 import 하지 않는다(meeting-summary.ts가 이 모듈을 쓴다).
 */

// 프롬프트의 "출력 키" 블록. 템플릿은 keyHints로 이 블록의 키 줄 묶음 뒤에 한 줄씩만 덧붙인다.
export const MEETING_OUTPUT_KEYS = `출력 키
- title(string): 이 회의 내용을 나타내는 제목. 30자 이하의 명사구. 날짜와 "회의"·"미팅" 같은 일반어는 빼고 핵심 주제를 쓰세요.
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
  /** 자동 선택 때 모델에게 주는 선택 기준 한 줄. */
  selectHint: string
  /** 명시 형식이 없을 때 사용자가 입력한 제목으로 판별하는 패턴. */
  titlePattern?: RegExp
}

export const MEETING_TEMPLATES: readonly MeetingTemplate[] = [
  {
    id: 'default',
    name: '기본',
    purpose: '',
    topicTitles: [],
    keyHints: {},
    selectHint: '여러 안건을 논의하는 일반 회의. 아래 유형에 뚜렷이 맞지 않으면 이것.'
  },
  {
    id: 'one_on_one',
    name: '1:1',
    purpose: '1:1 미팅입니다. 두 사람의 현재 상태, 진행, 막힌 점, 피드백, 성장을 중심으로 정리하세요.',
    topicTitles: ['체크인', '진행 상황', '막힌 점', '피드백', '성장·커리어'],
    keyHints: { tldr: '상대의 현재 상태와 핵심 약속 중심', action_items: '양쪽이 한 약속 모두' },
    selectHint: '두 사람이 서로의 현재 상태·진행·막힌 점·피드백·성장을 이야기하는 1:1 대화.',
    titlePattern: /1\s*on\s*1|1:1|1-on-1|원온원|일대일/i
  },
  {
    id: 'standup',
    name: '스탠드업',
    purpose: '짧은 진행 공유 회의(스탠드업)입니다. 사람별 지난 진행, 오늘 할 일, 블로커를 중심으로 정리하세요.',
    topicTitles: ['지난 진행', '오늘 할 일', '블로커'],
    keyHints: { open_questions: '블로커 중 해결 담당이 정해지지 않은 것' },
    selectHint: '여러 사람이 돌아가며 지난 진행·오늘 할 일·블로커를 짧게 공유하는 회의.',
    titlePattern: /스탠드업|데일리|daily|stand-?up|스크럼/i
  },
  {
    id: 'review',
    name: '리뷰·회고',
    purpose: '검토·회고 회의입니다. 검토 대상, 잘된 점, 문제점과 원인, 개선안을 중심으로 정리하세요.',
    topicTitles: ['검토 대상', '잘된 점', '문제점·원인', '개선안'],
    keyHints: { decisions: '승인·반려·보류 판정을 명시' },
    selectHint: '문서·디자인·기획·코드 같은 산출물이나 지난 일을 검토해 문제점과 개선안을 정하는 리뷰·회고.',
    titlePattern: /리뷰|review|회고|retro|KPT|포스트모템|post-?mortem/i
  }
]

/** 제목을 비워 두었을 때 붙는 기본 제목(recording:createDraft). 이 제목으로는 형식을 판별하지 않는다. */
export const DEFAULT_MEETING_TITLE = '제목 없는 회의'

export function isTemplateId(v: unknown): v is MeetingTemplateId {
  return typeof v === 'string' && MEETING_TEMPLATES.some((t) => t.id === v)
}

export function getTemplate(id: MeetingTemplateId): MeetingTemplate {
  return MEETING_TEMPLATES.find((t) => t.id === id) ?? MEETING_TEMPLATES[0]
}

export type TemplateSource = 'manual' | 'title' | 'auto'

/**
 * 요약에 쓸 형식 계획. fixed는 형식이 이미 정해진 경우(수동 고정 또는 사용자 제목), auto는
 * 같은 요약 호출에서 모델이 전사 내용을 보고 형식을 고르는 경우다.
 */
export type TemplatePlan =
  | { mode: 'fixed'; template: MeetingTemplate; source: 'manual' | 'title'; reason: string | null }
  | { mode: 'auto' }

/**
 * 형식 결정 순서:
 * 1. 명시 형식(meetings.summary_template)이 유효하면 수동 고정('default' 포함).
 * 2. 사용자가 입력한 제목(titleAuto=false)이 one_on_one → standup → review 순으로 패턴에 맞으면 그 형식.
 *    시스템이 붙인 제목(기본·요약 제목)에는 적용하지 않는다(자기 강화 방지).
 * 3. 그 외는 모델 자동 선택.
 */
export function resolveTemplatePlan(input: {
  explicit: string | null | undefined
  title: string | null | undefined
  titleAuto: boolean
}): TemplatePlan {
  if (isTemplateId(input.explicit)) {
    return { mode: 'fixed', template: getTemplate(input.explicit), source: 'manual', reason: null }
  }
  const t = (input.title ?? '').trim()
  if (!input.titleAuto && t && t !== DEFAULT_MEETING_TITLE) {
    for (const id of ['one_on_one', 'standup', 'review'] as const) {
      const tpl = getTemplate(id)
      const m = tpl.titlePattern?.exec(t)
      if (m) return { mode: 'fixed', template: tpl, source: 'title', reason: `제목의 "${m[0]}"` }
    }
  }
  return { mode: 'auto' }
}

// 자동 선택 모드에서 MEETING_OUTPUT_KEYS 뒤에 덧붙이는 메타 출력 키.
export const AUTO_TEMPLATE_OUTPUT_KEYS = `- template_id(string): [회의 형식 고르기]에서 고른 형식 id. default, one_on_one, standup, review 중 하나.
- template_reason(string): 그 형식을 고른 근거 한 문장. 50자 이하.`

/** 자동 선택 모드 프롬프트의 [회의 형식 고르기] 블록. MEETING_TEMPLATES 데이터로 만든다. */
export function buildTemplateSelectionBlock(): string {
  const lines = [
    '[회의 형식 고르기]',
    '전사록의 실제 대화 내용을 보고 아래 형식 중 하나를 고르세요. 제목보다 대화 내용을 따르세요. 뚜렷하게 맞는 형식이 없으면 default를 고르세요.'
  ]
  for (const t of MEETING_TEMPLATES) lines.push(`- ${t.id}(${t.name}): ${t.selectHint}`)
  lines.push('고른 형식이 default가 아니면 그 형식의 지시도 따르세요.')
  for (const t of MEETING_TEMPLATES) {
    if (t.id === 'default') continue
    const hints = (Object.entries(t.keyHints) as Array<[OutputKey, string]>)
      .map(([k, h]) => `${k} — ${h}`)
      .join('; ')
    lines.push(`- ${t.id}: ${t.purpose} topics의 title 후보: ${t.topicTitles.join(', ')}. 출력 키 힌트: ${hints}`)
  }
  lines.push(
    'topics의 title 후보는 실제로 다뤄진 것만 그대로 쓰고, 목록에 없는 논의는 자유 제목으로 추가하세요. 다뤄지지 않은 후보 이름은 만들지 마세요.'
  )
  lines.push('JSON은 template_id와 template_reason을 맨 앞에 쓰세요.')
  return lines.join('\n')
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
