// 회의 전 브리핑의 매칭·규칙 본문·알림 문구 (docs/ASSISTANT.md 부록 I.5·I.6).
// 순수 모듈이다 (A3). ./assistant-types 만 import 한다.
import type { MeetingContext, MeetingProjectRef } from './assistant-types'

/** 알림 제목에 넣는 회의 제목의 최대 글자 수 (I.6). */
export const MEETING_TITLE_MAX = 30
/** 규칙 본문 한 줄의 최대 글자 수 (I.6). tldr 도 같은 상한이다. */
export const MEETING_LINE_MAX = 200
/** 프로젝트 매칭 최대 건수 (I.5). */
const MATCH_PROJECT_MAX = 3
/** 프로젝트 이름의 최소 글자 수. 정규화한 이름 기준이다 (I.5, 위험 7). */
const MATCH_NAME_MIN = 2
const EMPTY_TITLE = '(제목 없음)'

/** 소문자화하고 공백·구두점·기호를 지운다 (I.5). */
export function normalizeTitle(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 정규화한 두 제목이 같으면 참이다. 정규화 결과가 빈 문자열이면 거짓이다. */
export function sameTitle(a: string, b: string): boolean {
  const na = normalizeTitle(a)
  return na.length > 0 && na === normalizeTitle(b)
}

function charLength(s: string): number {
  return Array.from(s).length
}

/**
 * 정규화한 회의 제목에 정규화한 프로젝트 이름이 들어 있으면 매칭이다.
 * 이름이 2자 미만이면 제외한다. 이름 길이 내림차순, 같으면 id 오름차순이다. 최대 3건이다.
 */
export function matchProjects(title: string, projects: { id: number; name: string }[]): MeetingProjectRef[] {
  const normTitle = normalizeTitle(title)
  if (normTitle.length === 0) return []
  const seen = new Set<number>()
  const matched: { ref: MeetingProjectRef; len: number }[] = []
  for (const p of projects) {
    if (seen.has(p.id)) continue
    const normName = normalizeTitle(p.name)
    const len = charLength(normName)
    if (len < MATCH_NAME_MIN) continue
    if (!normTitle.includes(normName)) continue
    seen.add(p.id)
    matched.push({ ref: { id: p.id, name: p.name }, len })
  }
  matched.sort((a, b) => b.len - a.len || a.ref.id - b.ref.id)
  return matched.slice(0, MATCH_PROJECT_MAX).map((m) => m.ref)
}

/** 프로젝트·지난 회의·액션아이템·관련 항목 중 하나라도 있으면 참이다 (I.6). */
export function hasMeetingContext(ctx: MeetingContext): boolean {
  return (
    ctx.projects.length > 0 ||
    ctx.pastMeetings.length > 0 ||
    ctx.openActionItems.length > 0 ||
    ctx.relatedItems.length > 0
  )
}

/** 줄바꿈·연속 공백을 공백 1개로 바꾼다. */
function flatten(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** max 자를 넘으면 max − 1 자에 '…' 를 붙여 max 자로 만든다. */
function clip(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s
}

/**
 * Markdown 링크·이미지·자동 링크 문법 문자를 백슬래시로 이스케이프한다.
 * 외부 일정 제목 같은 텍스트가 카드에서 클릭 가능한 링크가 되지 않게 한다.
 * 백슬래시도 이스케이프한다. 이유: 입력의 백슬래시가 뒤 문자의 이스케이프를 지우지 않는다.
 */
export function escapeMarkdownText(s: string): string {
  return s.replace(/[\\[\]()!<>]/g, '\\$&')
}

function line(s: string): string {
  return clip(s, MEETING_LINE_MAX)
}

function meetingTitle(ctx: MeetingContext): string {
  return flatten(ctx.meeting.title) || EMPTY_TITLE
}

/** 'YYYY-MM-DD HH:mm:ss' → 'HH:mm'. 형식이 다르면 빈 문자열이다. */
function hhmm(dateTime: string): string {
  const m = /^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2})/.exec(dateTime)
  return m ? m[1] : ''
}

/** 'YYYY-MM-DD ...' → 'MM-DD'. 형식이 다르면 빈 문자열이다. */
function mmdd(dateTime: string): string {
  const m = /^\d{4}-(\d{2}-\d{2})/.exec(dateTime)
  return m ? m[1] : ''
}

/** 규칙 브리핑 Markdown (I.6). 각 줄은 200자에서 자른다. 입력을 바꾸지 않는다 (A14). */
export function buildMeetingBriefing(ctx: MeetingContext): string {
  const out: string[] = []
  const time = hhmm(ctx.meeting.startAt)
  out.push(line(`# ${escapeMarkdownText(meetingTitle(ctx))}${time ? ` ${time}` : ''}`))

  const projectNames = ctx.projects.map((p) => escapeMarkdownText(flatten(p.name))).filter((n) => n.length > 0)
  out.push(line(projectNames.length > 0 ? `- 관련 프로젝트: ${projectNames.join(', ')}` : '- 관련 프로젝트 없음'))

  out.push('## 지난 회의')
  if (ctx.pastMeetings.length === 0) {
    out.push('- 같은 제목의 지난 회의 없음')
  } else {
    for (const pm of ctx.pastMeetings) {
      const date = mmdd(pm.startedAt)
      const head = [date, escapeMarkdownText(flatten(pm.title) || EMPTY_TITLE)].filter((s) => s.length > 0).join(' ')
      const tldr = pm.tldr ? escapeMarkdownText(clip(flatten(pm.tldr), MEETING_LINE_MAX)) : ''
      out.push(line(tldr ? `- ${head} — ${tldr}` : `- ${head}`))
    }
  }

  const actions = ctx.openActionItems.map((t) => escapeMarkdownText(flatten(t))).filter((t) => t.length > 0)
  if (actions.length > 0) {
    out.push(`## 미완료 액션아이템 (${actions.length})`)
    for (const text of actions) out.push(line(`- ${text}`))
  }

  const related = ctx.relatedItems.map((it) => escapeMarkdownText(flatten(it.title))).filter((t) => t.length > 0)
  if (related.length > 0) {
    out.push('## 오늘 계획 중 관련 항목')
    for (const title of related) out.push(line(`- ${title}`))
  }

  return out.join('\n')
}

/**
 * 알림 제목·본문 (I.6, §12.1).
 * 제목은 '<회의 제목 30자> <lead>분 전' 이다. 30자를 넘으면 30자로 자르고 '…' 를 붙인다.
 * 본문은 '<프로젝트 이름 또는 관련 프로젝트 없음> · 미완료 액션 N건' 이다.
 */
export function meetingNoticeText(ctx: MeetingContext, leadMin: number): { title: string; body: string } {
  const flat = meetingTitle(ctx)
  const chars = Array.from(flat)
  const clipped = chars.length > MEETING_TITLE_MAX ? `${chars.slice(0, MEETING_TITLE_MAX).join('')}…` : flat
  const names = ctx.projects.map((p) => flatten(p.name)).filter((n) => n.length > 0)
  const projectText = names.length > 0 ? names.join(', ') : '관련 프로젝트 없음'
  const actionCount = ctx.openActionItems.filter((t) => flatten(t).length > 0).length
  return {
    title: `${clipped} ${leadMin}분 전`,
    body: `${projectText} · 미완료 액션 ${actionCount}건`
  }
}
