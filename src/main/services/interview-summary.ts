// 면접 기록 요약 스펙 (kind='interview') — 프롬프트 / 검증 / 저장
// 실행 인프라(Claude SDK 호출, 전사 직렬화, JSON 추출)는 meeting-summary.ts가 담당한다.
//
// 설계 원칙: 이 요약은 **채용 판정 도구가 아니라 기록 보조**다.
// 점수·등급·합격 의견을 생성하지 않고, 지원자의 실제 발언을 질문 단위로 정리한 뒤
// 근거(인용)와 사람이 직접 확인해야 할 지점만 남긴다.
import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { InterviewSummaryResult } from './meeting-types'
import type { SummarySpec } from './summary-spec'

// AI에게 ms 정수를 직접 만들게 하면 신뢰도가 낮다. 전사록에 이미 [mm:ss]가 붙어 있으므로
// 그 표기를 그대로 돌려받아 여기서 ms로 환산한다.
function parseTimestamp(at: string | null | undefined): number | null {
  if (!at) return null
  const m = at.trim().match(/^(\d{1,3}):([0-5]\d)$/)
  if (!m) return null
  return (Number(m[1]) * 60 + Number(m[2])) * 1000
}

const QaPairSchema = z.object({
  question: z.string(),
  answer_summary: z.string().default(''),
  at: z.string().nullish(),
  quote: z.string().nullish()
})

const CompetencySchema = z.object({
  topic: z.string(),
  evidence: z.array(z.string()).default([]),
  note: z.string().nullish()
})

const InterviewSchema = z.object({
  overview: z.string().default(''),
  qa_pairs: z.array(QaPairSchema).default([]),
  competencies: z.array(CompetencySchema).default([]),
  follow_ups: z.array(z.string()).default([]),
  fact_checks: z.array(z.string()).default([])
})

const SYSTEM_PROMPT = `면접 전사록을 분석해 한국어로 JSON만 출력하세요.

역할: 당신은 면접 내용을 **기록**하는 도구입니다. 지원자를 평가하지 않습니다.
- 점수, 등급, 순위, 합격/불합격 의견, "우수함"·"부족함" 같은 판단 표현을 절대 쓰지 마세요.
- 지원자의 성별·나이·출신·외모·가족 등 직무와 무관한 정보는 기록하지 마세요.
- 전사록에 없는 내용을 추론해서 만들지 마세요. 불확실하면 해당 배열을 비워두세요.

화자 구분: 면접관은 한 명 이상일 수 있습니다. 질문을 주로 하는 화자들이 면접관, 답변하는 화자가 지원자입니다.
화자명이 이미 지정되어 있으면 그 이름을 따르세요.

출력 키:
- overview(string): 면접에서 다룬 주제의 개요 2~3문장. 인물평 금지, 다룬 내용만 서술.
- qa_pairs: [{question, answer_summary, at, quote}]
  - question: 면접관이 던진 질문 (전사록 표현을 최대한 유지)
  - answer_summary: 지원자 답변의 사실 요약. 평가어 없이 말한 내용만.
  - at: 그 질문이 시작된 시각을 전사록의 "mm:ss" 형식 그대로. 모르면 null.
  - quote: 답변 중 핵심이 되는 지원자 발언 원문 1문장. 없으면 null.
- competencies: [{topic, evidence, note}]
  - topic: 실제로 언급된 주제 (예: "React 상태관리 경험", "장애 대응 사례")
  - evidence: 그 주제에 대한 지원자 발언 인용 문자열 배열
  - note: 사실 서술만 (예: "구체적 수치는 언급되지 않음"). 평가 금지. 없으면 null.
- follow_ups: [string] 답변이 모호하거나 구체성이 부족해 추가 질문이 필요한 지점
- fact_checks: [string] 경력 기간·규모·성과 수치 등 레퍼런스 체크로 확인할 주장

코드펜스 없이 순수 JSON만 출력하세요.`

function validate(raw: unknown): InterviewSummaryResult {
  const v = InterviewSchema.parse(raw)
  return {
    overview: v.overview,
    qa_pairs: v.qa_pairs.map((q) => ({
      question: q.question,
      answer_summary: q.answer_summary,
      start_ms: parseTimestamp(q.at),
      quote: q.quote ?? null
    })),
    competencies: v.competencies.map((c) => ({
      topic: c.topic,
      evidence: c.evidence,
      note: c.note ?? null
    })),
    follow_ups: v.follow_ups,
    fact_checks: v.fact_checks
  }
}

// overview는 회의 요약의 tldr 컬럼을 재사용한다(둘 다 "한 문단 개요"라 의미가 겹침).
// 회의 전용 3분류(decisions/action_items/next_steps)는 빈 배열로 덮어써, 종류를
// 바꿔 재요약했을 때 이전 종류의 잔여 데이터가 남지 않게 한다.
function persist(
  db: Database.Database,
  meetingId: number,
  parsed: InterviewSummaryResult,
  model: string
): void {
  db.prepare(
    `INSERT INTO meeting_summaries
       (meeting_id, tldr, key_points, decisions, action_items, next_steps,
        qa_pairs, competencies, follow_ups, fact_checks, model, generated_at)
     VALUES (?, ?, '[]', '[]', '[]', '[]', ?, ?, ?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(meeting_id) DO UPDATE SET
       tldr = excluded.tldr,
       key_points = excluded.key_points,
       decisions = excluded.decisions,
       action_items = excluded.action_items,
       next_steps = excluded.next_steps,
       qa_pairs = excluded.qa_pairs,
       competencies = excluded.competencies,
       follow_ups = excluded.follow_ups,
       fact_checks = excluded.fact_checks,
       model = excluded.model,
       generated_at = excluded.generated_at`
  ).run(
    meetingId,
    parsed.overview,
    JSON.stringify(parsed.qa_pairs),
    JSON.stringify(parsed.competencies),
    JSON.stringify(parsed.follow_ups),
    JSON.stringify(parsed.fact_checks),
    model
  )
}

export const INTERVIEW_SPEC: SummarySpec<InterviewSummaryResult> = {
  systemPrompt: SYSTEM_PROMPT,
  buildPrompt: (transcript, contextBlock) =>
    `${contextBlock ? `${contextBlock}\n\n` : ''}다음 면접 전사록을 분석해 JSON으로 정리하세요:\n\n${transcript}`,
  progressMessage: 'AI 면접 기록 정리 중…',
  validate,
  persist
}
