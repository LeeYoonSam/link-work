// 회의록 — 요약 완료된 회의를 문서처럼 다루기 위한 순수 함수 모음.
// DB 접근 없이 입력만으로 결과가 정해지므로 단위 테스트로 검증한다.
import type {
  SummaryActionItem,
  InterviewQaPair,
  InterviewCompetency
} from './meeting-types'

export function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

export interface NoteActionItem extends SummaryActionItem {
  todo_id?: number | null
}

// ── 요약 읽기 정규화 ──
// 저장된 JSON은 요약 시점의 형식을 그대로 담는다. decisions·open_questions는 구버전(문자열 배열)과
// 새 형식({text, at_ms} 배열)이 섞일 수 있으므로, 읽는 쪽은 항상 이 함수들로 한 형태로 맞춘다.
export interface NoteTextItem {
  text: string
  at_ms: number | null
}
export interface NoteTopic {
  title: string
  start_ms: number | null
  points: string[]
}

function toMs(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseTextItems(raw: string | null | undefined): NoteTextItem[] {
  const out: NoteTextItem[] = []
  for (const it of parseJsonArray<unknown>(raw)) {
    if (typeof it === 'string') {
      if (it.trim()) out.push({ text: it.trim(), at_ms: null })
    } else if (isRecord(it) && typeof it.text === 'string' && it.text.trim()) {
      out.push({ text: it.text.trim(), at_ms: toMs(it.at_ms) })
    }
  }
  return out
}

export function parseTopics(raw: string | null | undefined): NoteTopic[] {
  const out: NoteTopic[] = []
  for (const it of parseJsonArray<unknown>(raw)) {
    if (!isRecord(it) || typeof it.title !== 'string' || !it.title.trim()) continue
    const points = Array.isArray(it.points)
      ? it.points.filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim())
      : []
    out.push({ title: it.title.trim(), start_ms: toMs(it.start_ms), points })
  }
  return out
}

export function parseKeywords(raw: string | null | undefined): string[] {
  return parseJsonArray<unknown>(raw)
    .filter((k): k is string => typeof k === 'string' && k.trim() !== '')
    .map((k) => k.trim())
}

// 요약 시각 필드(topics[].start_ms, decisions·action_items·open_questions[].at_ms)를 새 타임라인으로
// 옮긴다(컷편집 재매핑용). 시각 외의 필드(todo_id 등)와 문자열 항목은 그대로 두고, 읽을 수 없는
// JSON은 손대지 않는다. null 컬럼은 '[]'로 돌려준다.
export function remapSummaryTimes(
  cols: {
    topics: string | null
    decisions: string | null
    action_items: string | null
    open_questions: string | null
  },
  map: (ms: number) => number
): { topics: string; decisions: string; action_items: string; open_questions: string } {
  const remap = (raw: string | null, key: 'at_ms' | 'start_ms'): string => {
    if (!raw) return '[]'
    let v: unknown
    try {
      v = JSON.parse(raw)
    } catch {
      return raw
    }
    if (!Array.isArray(v)) return raw
    return JSON.stringify(
      v.map((it) => (isRecord(it) && toMs(it[key]) != null ? { ...it, [key]: map(it[key] as number) } : it))
    )
  }
  return {
    topics: remap(cols.topics, 'start_ms'),
    decisions: remap(cols.decisions, 'at_ms'),
    action_items: remap(cols.action_items, 'at_ms'),
    open_questions: remap(cols.open_questions, 'at_ms')
  }
}

// action_items JSON의 전체 개수와 아직 할 일로 옮기지 않은(todo_id 없는) 개수
export function countActionItems(raw: string | null | undefined): { total: number; open: number } {
  const items = parseJsonArray<NoteActionItem>(raw)
  return { total: items.length, open: items.filter((a) => a?.todo_id == null).length }
}

// LIKE 패턴용 이스케이프 — ESCAPE '\' 와 함께 쓴다
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => '\\' + c)
}

export interface NoteMeeting {
  title: string
  kind: 'meeting' | 'interview'
  started_at: string
  duration_ms: number
}
export interface NoteSpeaker {
  id: number
  label: string
  display_name: string | null
}
export interface NoteSegment {
  start_ms: number
  speaker_id: number | null
  text: string
}
export interface NoteSummary {
  tldr: string | null
  keywords: string[]
  topics: NoteTopic[]
  decisions: NoteTextItem[]
  action_items: NoteActionItem[]
  open_questions: NoteTextItem[]
  // 구버전 요약에만 값이 있다 (새 요약은 [])
  key_points: string[]
  next_steps: string[]
  qa_pairs: InterviewQaPair[]
  competencies: InterviewCompetency[]
  follow_ups: string[]
  fact_checks: string[]
}
export interface NoteDetail {
  meeting: NoteMeeting
  speakers: NoteSpeaker[]
  segments: NoteSegment[]
  summary: NoteSummary | null
  attendees: { name: string }[]
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function formatDuration(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min}분`
  return `${Math.floor(min / 60)}시간 ${min % 60}분`
}

function section(title: string, lines: string[]): string[] {
  return lines.length > 0 ? [`## ${title}`, '', ...lines, ''] : []
}

function bullets(items: (string | null | undefined)[]): string[] {
  return items.filter((s): s is string => !!s && s.trim() !== '').map((s) => `- ${s.trim()}`)
}

// 시각 꼬리표. 전사 섹션과 같은 formatClock 표기, 시각이 없으면 붙이지 않는다.
function atSuffix(ms: number | null | undefined): string {
  return ms != null ? ` [${formatClock(ms)}]` : ''
}

function textItemBullets(items: NoteTextItem[]): string[] {
  return items.filter((it) => it?.text?.trim()).map((it) => `- ${it.text.trim()}${atSuffix(it.at_ms)}`)
}

export function buildMeetingNoteMarkdown(detail: NoteDetail): string {
  const { meeting, speakers, segments, summary, attendees } = detail
  const out: string[] = [`# ${meeting.title}`, '']

  const meta = [
    `일시: ${meeting.started_at}`,
    `길이: ${formatDuration(meeting.duration_ms)}`,
    `종류: ${meeting.kind === 'interview' ? '면접' : '회의'}`
  ]
  if (attendees.length > 0) meta.push(`참석자: ${attendees.map((a) => a.name).join(', ')}`)
  out.push(meta.join(' · '), '')

  if (summary) {
    const tldr = summary.tldr?.trim() ? [summary.tldr.trim()] : []
    if (meeting.kind === 'interview') {
      out.push(...section('면접 개요', tldr))
      const qa: string[] = []
      summary.qa_pairs.forEach((p, i) => {
        const at = p.start_ms != null ? ` [${formatClock(p.start_ms)}]` : ''
        qa.push(`### Q${i + 1}. ${p.question}${at}`, '', p.answer_summary)
        if (p.quote?.trim()) qa.push('', `> ${p.quote.trim()}`)
        qa.push('')
      })
      if (qa.length > 0) qa.pop()
      out.push(...section('질문과 답변', qa))
      const comp: string[] = []
      for (const c of summary.competencies) {
        comp.push(`- **${c.topic}**`)
        for (const e of c.evidence ?? []) if (e?.trim()) comp.push(`  - ${e.trim()}`)
        if (c.note?.trim()) comp.push(`  - 메모: ${c.note.trim()}`)
      }
      out.push(...section('역량별 근거', comp))
      out.push(...section('후속 질문', bullets(summary.follow_ups)))
      out.push(...section('확인 필요', bullets(summary.fact_checks)))
    } else {
      const keywords = (summary.keywords ?? []).filter((k) => k?.trim()).map((k) => k.trim())
      out.push(...section('키워드', keywords.length > 0 ? [keywords.join(' · ')] : []))
      out.push(...section('TL;DR', tldr))
      out.push(...section('핵심 포인트', bullets(summary.key_points)))
      out.push(...section('결정사항', textItemBullets(summary.decisions)))
      const actions = summary.action_items
        .filter((a) => a?.text?.trim())
        .map((a) => {
          const extra = [a.assignee ? `담당: ${a.assignee}` : '', a.due ? `기한: ${a.due}` : '']
            .filter(Boolean)
            .join(', ')
          return `- [${a.todo_id != null ? 'x' : ' '}] ${a.text.trim()}${extra ? ` (${extra})` : ''}${atSuffix(a.at_ms)}`
        })
      out.push(...section('액션아이템', actions))
      out.push(...section('미결 질문', textItemBullets(summary.open_questions ?? [])))
      out.push(...section('다음 단계', bullets(summary.next_steps)))
      const topics: string[] = []
      const titled = (summary.topics ?? []).filter((t) => t?.title?.trim())
      titled.forEach((t, i) => {
        topics.push(`### ${i + 1}. ${t.title.trim()}${atSuffix(t.start_ms)}`)
        const points = bullets(t.points ?? [])
        if (points.length > 0) topics.push('', ...points)
        topics.push('')
      })
      if (topics.length > 0) topics.pop()
      out.push(...section('주제별 요약', topics))
    }
  }

  const names = new Map(speakers.map((s) => [s.id, s.display_name || s.label]))
  const transcript = segments
    .filter((g) => g.text?.trim())
    .map((g) => {
      const who = g.speaker_id != null ? names.get(g.speaker_id) : undefined
      return `[${formatClock(g.start_ms)}] ${who ? `**${who}**: ` : ''}${g.text.trim()}`
    })
  // 전사 줄 사이를 빈 줄로 띄워 Markdown에서 각 발언이 단락이 되게 한다
  out.push(...section('전사', transcript.flatMap((l, i) => (i === 0 ? [l] : ['', l]))))

  return out.join('\n').trimEnd() + '\n'
}
