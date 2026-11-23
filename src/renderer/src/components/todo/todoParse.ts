// 할 일 빠른 입력의 자연어 인식. 순수 함수이고 외부 의존이 없다.
// 예: '내일 3시 회의 준비 !높음 #업무' → 제목 '회의 준비', 내일 15:00(알림 켬), 우선순위 높음, 태그 '업무'.
//
// 규칙
// - 토큰은 낱말 단위(공백으로 나뉜 덩어리)로만 인식한다. '내일모레', '3시간' 같은 낱말 일부는 인식하지 않는다.
// - 날짜·시각·우선순위는 처음 나온 것 1개만 쓴다. 뒤에 또 나오면 제목 글자로 남긴다. 태그는 여러 개를 받는다.
// - 시각만 있으면 날짜는 오늘이다. 시각이 있으면 due_reminder 1, 날짜만 있으면 0 이다(알림 규약).
// - 오전/오후·am/pm 이 없으면 1~7시는 오후로, 8~12시는 그대로 읽는다. 'HH:mm' 은 시가 한 자리(예: 3:30)일 때만 이 규칙을 쓰고
//   두 자리(예: 03:30, 15:00)면 24시간제로 그대로 읽는다.
// - 요일 한 글자는 월~토만 받는다. '일' 한 글자는 흔한 낱말이라 일요일로 읽지 않는다('일요일'·'일욜'·'다음 주 일'은 받는다).
// - 토큰을 빼면 제목이 비는 입력은 원문 전체를 제목으로 두고 토큰을 내지 않는다.
import type { TodoInput, TodoPriority } from '../../types'

export interface ParsedToken {
  kind: 'date' | 'time' | 'priority' | 'tag'
  text: string
  start: number
  end: number
  label: string
}

export interface ParsedTodo {
  title: string
  priority?: TodoPriority
  due_date?: string
  due_reminder?: number
  tag_ids?: number[]
  tokens: ParsedToken[]
}

interface Word {
  text: string
  start: number
  end: number
}

type Hit =
  | { kind: 'date'; n: number; date: string }
  | { kind: 'time'; n: number; hour: number; minute: number }
  | { kind: 'priority'; n: number; priority: TodoPriority }
  | { kind: 'tag'; n: number; tagId: number; name: string }

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
const PRIORITY_LABEL: Record<TodoPriority, string> = { high: '높음', medium: '보통', low: '낮음' }

const pad2 = (n: number): string => String(n).padStart(2, '0')
const dayKey = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

function addDays(base: Date, n: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + n)
  return dayKey(d)
}

/** 달력에 있는 날짜면 'YYYY-MM-DD', 아니면 null */
function validDay(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null
  const dt = new Date(y, m - 1, d)
  if (dt.getMonth() !== m - 1 || dt.getDate() !== d) return null
  return dayKey(dt)
}

/** 월·일만 있는 날짜. 올해 날짜가 이미 지났으면 내년 */
function monthDay(now: Date, m: number, d: number): string | null {
  const today = dayKey(now)
  const thisYear = validDay(now.getFullYear(), m, d)
  if (thisYear && thisYear >= today) return thisYear
  // 2/29 처럼 올해 없는 날짜도 내년에 있으면 받는다
  return validDay(now.getFullYear() + 1, m, d) ?? null
}

const RELATIVE_DAYS: Record<string, number> = {
  오늘: 0,
  내일: 1,
  모레: 2,
  글피: 3,
  today: 0,
  tomorrow: 1
}

const EN_WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6
}

/** 한국어 요일 낱말 → 0(일)~6(토). allowBareSun 이면 '일' 한 글자도 받는다 */
function koWeekday(w: string, allowBareSun: boolean): number | null {
  const m = /^(월|화|수|목|금|토|일)(요일|욜)?$/.exec(w)
  if (!m) return null
  if (m[1] === '일' && !m[2] && !allowBareSun) return null
  return WEEKDAYS.indexOf(m[1])
}

function anyWeekday(w: string, allowBareSun: boolean): number | null {
  const ko = koWeekday(w, allowBareSun)
  if (ko !== null) return ko
  const en = EN_WEEKDAYS[w.toLowerCase()]
  return en === undefined ? null : en
}

/** 다음 주 월요일 */
function nextMonday(now: Date): Date {
  const toMonday = (8 - now.getDay()) % 7 || 7
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + toMonday)
}

function matchDate(words: Word[], i: number, now: Date): Hit | null {
  const w = words[i].text
  const w1 = words[i + 1]?.text
  const w2 = words[i + 2]?.text
  // '다음 주 금요일' · '다음주 금요일'
  if (w === '다음' && w1 === '주' && w2 !== undefined) {
    const wd = anyWeekday(w2, true)
    if (wd !== null) return { kind: 'date', n: 3, date: addDays(nextMonday(now), (wd + 6) % 7) }
  }
  if (w === '다음주' && w1 !== undefined) {
    const wd = anyWeekday(w1, true)
    if (wd !== null) return { kind: 'date', n: 2, date: addDays(nextMonday(now), (wd + 6) % 7) }
  }
  const rel = RELATIVE_DAYS[w.toLowerCase()]
  if (rel !== undefined) return { kind: 'date', n: 1, date: addDays(now, rel) }
  // 요일: 이번 주에 이미 지났거나 오늘이면 다음 주
  const wd = anyWeekday(w, false)
  if (wd !== null) {
    const diff = (wd - now.getDay() + 7) % 7 || 7
    return { kind: 'date', n: 1, date: addDays(now, diff) }
  }
  // M/D
  const slash = /^(\d{1,2})\/(\d{1,2})$/.exec(w)
  if (slash) {
    const date = monthDay(now, Number(slash[1]), Number(slash[2]))
    return date ? { kind: 'date', n: 1, date } : null
  }
  // M월D일 (한 낱말)
  const joined = /^(\d{1,2})월(\d{1,2})일$/.exec(w)
  if (joined) {
    const date = monthDay(now, Number(joined[1]), Number(joined[2]))
    return date ? { kind: 'date', n: 1, date } : null
  }
  // M월 D일 (두 낱말)
  const mon = /^(\d{1,2})월$/.exec(w)
  const day = w1 !== undefined ? /^(\d{1,2})일$/.exec(w1) : null
  if (mon && day) {
    const date = monthDay(now, Number(mon[1]), Number(day[1]))
    return date ? { kind: 'date', n: 2, date } : null
  }
  return null
}

/** 오전/오후(am/pm) 와 시를 24시간제로. 범위 밖이면 null */
function toHour(h: number, mer: 'am' | 'pm' | null, guess: boolean): number | null {
  if (mer) {
    if (h < 0 || h > 12) return null
    if (mer === 'am') return h === 12 ? 0 : h
    return h === 12 ? 12 : h + 12
  }
  if (h < 0 || h > 23) return null
  if (guess && h >= 1 && h <= 7) return h + 12
  return h
}

const merOf = (w: string | undefined): 'am' | 'pm' | null => {
  if (w === undefined) return null
  const l = w.toLowerCase()
  if (l === 'am' || l === '오전') return 'am'
  if (l === 'pm' || l === '오후') return 'pm'
  return null
}

function matchTime(words: Word[], i: number): Hit | null {
  let j = i
  let mer: 'am' | 'pm' | null = null
  const first = words[j].text
  if (first === '오전' || first === '오후') {
    mer = first === '오전' ? 'am' : 'pm'
    j++
    if (j >= words.length) return null
  }
  const w = words[j].text

  // N시 · N시M분 · N시반 (오전/오후 붙여 쓰기 포함)
  const ko = /^(오전|오후)?(\d{1,2})시(?:(\d{1,2})분|(반))?$/.exec(w)
  if (ko) {
    if (ko[1]) {
      if (mer) return null
      mer = ko[1] === '오전' ? 'am' : 'pm'
    }
    let minute = ko[3] !== undefined ? Number(ko[3]) : ko[4] ? 30 : 0
    let n = j - i + 1
    if (ko[3] === undefined && !ko[4]) {
      const next = words[j + 1]?.text
      const mm = next !== undefined ? /^(\d{1,2})분$/.exec(next) : null
      if (mm) {
        minute = Number(mm[1])
        n++
      } else if (next === '반') {
        minute = 30
        n++
      }
    }
    const hour = toHour(Number(ko[2]), mer, true)
    if (hour === null || minute > 59) return null
    return { kind: 'time', n, hour, minute }
  }

  // HH:mm · H:mm(am|pm) · Ham · H pm
  const colon = /^(\d{1,2}):(\d{2})(am|pm)?$/i.exec(w)
  const ampm = /^(\d{1,2})(am|pm)$/i.exec(w)
  const bare = /^(\d{1,2})$/.exec(w)
  let h: number
  let minute: number
  let guess: boolean
  let n = j - i + 1
  if (colon) {
    h = Number(colon[1])
    minute = Number(colon[2])
    guess = colon[1].length === 1
    if (colon[3]) {
      if (mer) return null
      mer = merOf(colon[3])
    }
  } else if (ampm) {
    if (mer) return null
    h = Number(ampm[1])
    minute = 0
    guess = false
    mer = merOf(ampm[2])
  } else if (bare && !mer) {
    // '9 am' 처럼 띄어 쓴 경우만 받는다. 숫자 하나만으로는 시각이 아니다
    const suffix = words[j + 1]?.text.toLowerCase()
    if (suffix !== 'am' && suffix !== 'pm') return null
    h = Number(bare[1])
    minute = 0
    guess = false
    mer = suffix
    n++
  } else {
    return null
  }
  if (colon && !colon[3] && !mer) {
    const suffix = words[j + 1]?.text.toLowerCase()
    if (suffix === 'am' || suffix === 'pm') {
      mer = suffix
      n++
    }
  }
  const hour = toHour(h, mer, guess)
  if (hour === null || minute > 59) return null
  return { kind: 'time', n, hour, minute }
}

const PRIORITY_WORDS: Record<string, TodoPriority> = {
  '!높음': 'high',
  '!high': 'high',
  p1: 'high',
  '!보통': 'medium',
  '!중간': 'medium',
  '!medium': 'medium',
  p2: 'medium',
  '!낮음': 'low',
  '!low': 'low',
  p3: 'low'
}

function matchPriority(words: Word[], i: number): Hit | null {
  const p = PRIORITY_WORDS[words[i].text.toLowerCase()]
  return p ? { kind: 'priority', n: 1, priority: p } : null
}

function matchTag(words: Word[], i: number, tags: { id: number; name: string }[]): Hit | null {
  const w = words[i].text
  if (!w.startsWith('#') || w.length < 2) return null
  const name = w.slice(1).toLowerCase()
  const tag = tags.find((t) => t.name.toLowerCase() === name)
  return tag ? { kind: 'tag', n: 1, tagId: tag.id, name: tag.name } : null
}

/** 날짜 칩 문구. 오늘·내일·모레는 말로, 그 밖은 'M/D (요일)' */
function dateLabel(date: string, now: Date): string {
  if (date === addDays(now, 0)) return '오늘'
  if (date === addDays(now, 1)) return '내일'
  if (date === addDays(now, 2)) return '모레'
  const [y, m, d] = date.split('-').map(Number)
  return `${m}/${d} (${WEEKDAYS[new Date(y, m - 1, d).getDay()]})`
}

/** 입력 한 줄을 제목과 구조화 필드로 나눈다 */
export function parseTodoInput(
  raw: string,
  opts: { now: Date; tags?: { id: number; name: string }[]; ignore?: number[] }
): ParsedTodo {
  const { now } = opts
  const tags = opts.tags ?? []
  const ignore = new Set(opts.ignore ?? [])
  const words: Word[] = []
  for (const m of raw.matchAll(/\S+/g)) {
    const start = m.index ?? 0
    words.push({ text: m[0], start, end: start + m[0].length })
  }

  const tokens: ParsedToken[] = []
  let date: string | undefined
  let time: { hour: number; minute: number } | undefined
  let priority: TodoPriority | undefined
  const tagIds: number[] = []

  let i = 0
  while (i < words.length) {
    const hit = matchDate(words, i, now) ?? matchTime(words, i) ?? matchPriority(words, i) ?? matchTag(words, i, tags)
    if (!hit) {
      i++
      continue
    }
    const start = words[i].start
    const end = words[i + hit.n - 1].end
    const taken =
      (hit.kind === 'date' && date !== undefined) ||
      (hit.kind === 'time' && time !== undefined) ||
      (hit.kind === 'priority' && priority !== undefined) ||
      (hit.kind === 'tag' && tagIds.includes(hit.tagId))
    if (ignore.has(start) || taken) {
      i += hit.n
      continue
    }
    let label: string
    if (hit.kind === 'date') {
      date = hit.date
      label = dateLabel(hit.date, now)
    } else if (hit.kind === 'time') {
      time = { hour: hit.hour, minute: hit.minute }
      label = `${pad2(hit.hour)}:${pad2(hit.minute)}`
    } else if (hit.kind === 'priority') {
      priority = hit.priority
      label = PRIORITY_LABEL[hit.priority]
    } else {
      tagIds.push(hit.tagId)
      label = `#${hit.name}`
    }
    tokens.push({ kind: hit.kind, text: raw.slice(start, end), start, end, label })
    i += hit.n
  }

  // 토큰 자리를 뺀 나머지가 제목이다
  let rest = ''
  let pos = 0
  for (const t of tokens) {
    rest += raw.slice(pos, t.start) + ' '
    pos = t.end
  }
  rest += raw.slice(pos)
  const title = rest.replace(/\s+/g, ' ').trim()
  if (!title) return { title: raw.replace(/\s+/g, ' ').trim(), tokens: [] }

  const parsed: ParsedTodo = { title, tokens }
  if (priority) parsed.priority = priority
  if (time) {
    parsed.due_date = `${date ?? addDays(now, 0)} ${pad2(time.hour)}:${pad2(time.minute)}`
    parsed.due_reminder = 1
  } else if (date) {
    parsed.due_date = date
    parsed.due_reminder = 0
  }
  if (tagIds.length > 0) parsed.tag_ids = tagIds
  return parsed
}

/** 인식 결과를 todo:create 입력으로 바꾼다. 값이 없는 필드는 넣지 않는다 */
export function toTodoInput(p: ParsedTodo): TodoInput {
  const input: TodoInput = { title: p.title }
  if (p.priority) input.priority = p.priority
  if (p.due_date) {
    input.due_date = p.due_date
    input.due_reminder = p.due_reminder ?? (p.due_date.length > 10 ? 1 : 0)
  }
  if (p.tag_ids && p.tag_ids.length > 0) input.tag_ids = [...p.tag_ids]
  return input
}

// 줄 앞 글머리: '-', '*', '•', '1.', '1)', '[ ]', '[x]'. 기호 뒤에는 공백이 있어야 한다('•'·체크박스는 붙여 써도 된다)
const BULLET_RE = /^(?:[-*]\s+|•\s*|\d{1,3}[.)]\s+|\[[ xX]?\]\s*)/

/** 여러 줄 붙여넣기를 할 일 제목 줄로 나눈다. 빈 줄을 빼고 글머리를 지우며 최대 50줄 */
export function splitPastedLines(text: string): string[] {
  const out: string[] = []
  for (const line of text.split(/\r\n|\r|\n/)) {
    let s = line.trim()
    // '- [ ] 할 일' 처럼 겹친 글머리도 지운다
    for (let k = 0; k < 2; k++) {
      const next = s.replace(BULLET_RE, '').trim()
      if (next === s) break
      s = next
    }
    if (s) out.push(s)
    if (out.length >= 50) break
  }
  return out
}
