// 인식 보조 장치 — 용어집(stt_glossary) / 구성원(meeting_members) / 회의 참석자(meeting_attendees)
// SSOT: docs/MEETING_RECORDING.md
//
// 회사 고유명사·사내 약어는 코드에 넣지 않는다. 사용자가 직접 입력한 값만 로컬 SQLite에 남고,
// 여기서 세 갈래로 흘러간다:
//   1. whisper initial_prompt 힌트 (로컬 추론)      — loadPromptContext().glossary / .attendees
//   2. 전사 후 결정론적 치환(post-correction)        — loadPromptContext().rules
//   3. AI 요약 프롬프트의 [참고 정보] 블록            — buildSummaryContextBlock()
//
// 이 모듈은 DB 핸들을 인자로 받는다(getDatabase()를 부르지 않는다). 파이프라인·요약·IPC가
// 공용으로 import하고, 테스트는 인메모리 better-sqlite3에 RECOGNITION_AIDS_SCHEMA만 exec해
// 실제 스키마 그대로 검증할 수 있다.
import type Database from 'better-sqlite3'

type Db = Database.Database

// database.ts와 테스트가 공유하는 스키마 정의(단일 출처).
// meeting_attendees는 meetings/meeting_members를 참조하므로 그 뒤에 exec해야 한다.
export const RECOGNITION_AIDS_SCHEMA = `
  -- 전사 용어집: 정답 표기 + 오인식/변형 표기(aliases) + 메모
  CREATE TABLE IF NOT EXISTS stt_glossary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    note TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    project_id INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
  );

  -- 구성원: 회의 참석자 지정 / 화자 이름 프리셋 / 요약의 담당자 매칭에 쓰인다
  CREATE TABLE IF NOT EXISTS meeting_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    role TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS meeting_attendees (
    meeting_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    PRIMARY KEY (meeting_id, member_id),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (member_id) REFERENCES meeting_members(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_meeting_attendees_meeting
    ON meeting_attendees(meeting_id);
`

export interface GlossaryEntry {
  id: number
  term: string
  aliases: string[]
  note: string | null
  priority: number
  enabled: number
  project_id: number | null
  created_at: string
  updated_at: string
}

export interface Member {
  id: number
  name: string
  aliases: string[]
  role: string | null
  enabled: number
  sort_order: number
  created_at: string
  updated_at: string
}

export interface Attendee {
  member_id: number
  name: string
  role: string | null
}

export interface PromptContext {
  // initial_prompt 힌트 / 요약 참고 용어. enabled + 프로젝트 범위 필터, 우선순위 순.
  glossary: Array<{ term: string; note: string | null }>
  // 전사 후 결정론적 치환용. aliases가 하나도 없는 항목은 치환할 게 없어 제외한다.
  rules: Array<{ term: string; aliases: string[] }>
  attendees: Attendee[]
}

const EMPTY_CONTEXT: PromptContext = { glossary: [], rules: [], attendees: [] }

// ── 공통 정규화 ──

// trim → 빈 문자열 제거 → 대소문자 무시 중복 제거. 첫 등장 표기를 살린다.
function normalizeList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const v = raw.trim()
    if (!v) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

// DB의 aliases 컬럼은 JSON string[]. 손상된 값이 파이프라인을 깨지 않도록 []로 흡수한다.
function parseAliases(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    return normalizeList(JSON.parse(raw))
  } catch {
    return []
  }
}

function trimOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

function toIntOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
}

interface GlossaryRow {
  id: number
  term: string
  aliases: string
  note: string | null
  priority: number
  enabled: number
  project_id: number | null
  created_at: string
  updated_at: string
}

interface MemberRow {
  id: number
  name: string
  aliases: string
  role: string | null
  enabled: number
  sort_order: number
  created_at: string
  updated_at: string
}

function mapGlossary(row: GlossaryRow): GlossaryEntry {
  return { ...row, aliases: parseAliases(row.aliases) }
}

function mapMember(row: MemberRow): Member {
  return { ...row, aliases: parseAliases(row.aliases) }
}

// ── 용어집 ──

export function listGlossary(db: Db): GlossaryEntry[] {
  const rows = db
    .prepare(
      'SELECT * FROM stt_glossary ORDER BY priority DESC, term COLLATE NOCASE ASC, id ASC'
    )
    .all() as GlossaryRow[]
  return rows.map(mapGlossary)
}

export interface GlossaryInput {
  id?: number
  term: string
  aliases?: string[]
  note?: string | null
  priority?: number
  enabled?: boolean
  project_id?: number | null
}

export function upsertGlossary(db: Db, input: GlossaryInput): { id: number } {
  const term = (input?.term ?? '').trim()
  if (!term) throw new Error('용어(정답 표기)를 입력해 주세요.')
  const aliases = JSON.stringify(normalizeList(input?.aliases))
  const note = trimOrNull(input?.note)
  const priority = toIntOr(input?.priority, 0)
  const enabled = input?.enabled === false ? 0 : 1
  const projectId =
    typeof input?.project_id === 'number' && Number.isFinite(input.project_id)
      ? Math.round(input.project_id)
      : null

  if (typeof input.id === 'number' && Number.isFinite(input.id)) {
    db.prepare(
      `UPDATE stt_glossary
          SET term = ?, aliases = ?, note = ?, priority = ?, enabled = ?, project_id = ?,
              updated_at = datetime('now','localtime')
        WHERE id = ?`
    ).run(term, aliases, note, priority, enabled, projectId, input.id)
    return { id: input.id }
  }

  const result = db
    .prepare(
      'INSERT INTO stt_glossary (term, aliases, note, priority, enabled, project_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(term, aliases, note, priority, enabled, projectId)
  return { id: Number(result.lastInsertRowid) }
}

export function removeGlossary(db: Db, id: number): void {
  db.prepare('DELETE FROM stt_glossary WHERE id = ?').run(id)
}

export interface ParsedGlossaryLine {
  term: string
  aliases: string[]
  note: string | null
}

// "정답 | 별칭1, 별칭2 | 메모" 줄 형식 파서.
// '#'으로 시작하는 줄과 빈 줄은 무시하고, 파이프가 없으면 정답 표기만 있는 것으로 본다.
// 메모에 '|'가 들어갈 수 있으므로 3번째 필드부터는 다시 이어 붙인다.
// 같은 term(대소문자 무시)이 여러 줄에 나오면 aliases 합집합으로 병합한다.
function scanGlossaryText(text: string): { entries: ParsedGlossaryLine[]; skipped: number } {
  const entries: ParsedGlossaryLine[] = []
  const indexByTerm = new Map<string, number>()
  let skipped = 0

  for (const line of (text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const parts = trimmed.split('|')
    const term = (parts[0] ?? '').trim()
    if (!term) {
      // "| 별칭" 처럼 정답 표기가 비어 있는 줄 — 무엇으로 고칠지 알 수 없으므로 버린다.
      skipped++
      continue
    }
    const aliases = normalizeList((parts[1] ?? '').split(','))
    const note = parts.length > 2 ? trimOrNull(parts.slice(2).join('|')) : null

    const key = term.toLowerCase()
    const existing = indexByTerm.get(key)
    if (existing === undefined) {
      indexByTerm.set(key, entries.length)
      entries.push({ term, aliases, note })
    } else {
      const prev = entries[existing]
      entries[existing] = {
        term: prev.term,
        aliases: normalizeList([...prev.aliases, ...aliases]),
        note: note ?? prev.note
      }
    }
  }

  return { entries, skipped }
}

export function parseGlossaryText(text: string): ParsedGlossaryLine[] {
  return scanGlossaryText(text).entries
}

// 텍스트 일괄 가져오기. 같은 term이 이미 있으면(전역 범위 기준) aliases 합집합으로 갱신한다.
// 사용자가 여러 번 붙여넣어도 중복 행이 쌓이지 않게 하는 것이 목적이다.
export function importGlossaryText(
  db: Db,
  text: string
): { added: number; updated: number; skipped: number } {
  const { entries, skipped } = scanGlossaryText(text)
  let added = 0
  let updated = 0

  const tx = db.transaction(() => {
    for (const entry of entries) {
      const existing = db
        .prepare(
          'SELECT id, aliases, note FROM stt_glossary WHERE project_id IS NULL AND term = ? COLLATE NOCASE LIMIT 1'
        )
        .get(entry.term) as { id: number; aliases: string; note: string | null } | undefined

      if (existing) {
        const merged = normalizeList([...parseAliases(existing.aliases), ...entry.aliases])
        db.prepare(
          `UPDATE stt_glossary
              SET aliases = ?, note = ?, updated_at = datetime('now','localtime')
            WHERE id = ?`
        ).run(JSON.stringify(merged), entry.note ?? existing.note, existing.id)
        updated++
      } else {
        db.prepare(
          'INSERT INTO stt_glossary (term, aliases, note) VALUES (?, ?, ?)'
        ).run(entry.term, JSON.stringify(entry.aliases), entry.note)
        added++
      }
    }
  })
  tx()

  return { added, updated, skipped }
}

// ── 구성원 ──

export function listMembers(db: Db): Member[] {
  const rows = db
    .prepare('SELECT * FROM meeting_members ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC')
    .all() as MemberRow[]
  return rows.map(mapMember)
}

export interface MemberInput {
  id?: number
  name: string
  aliases?: string[]
  role?: string | null
  enabled?: boolean
  sort_order?: number
}

export function upsertMember(db: Db, input: MemberInput): { id: number } {
  const name = (input?.name ?? '').trim()
  if (!name) throw new Error('구성원 이름을 입력해 주세요.')
  const aliases = JSON.stringify(normalizeList(input?.aliases))
  const role = trimOrNull(input?.role)
  const enabled = input?.enabled === false ? 0 : 1
  const sortOrder = toIntOr(input?.sort_order, 0)

  if (typeof input.id === 'number' && Number.isFinite(input.id)) {
    db.prepare(
      `UPDATE meeting_members
          SET name = ?, aliases = ?, role = ?, enabled = ?, sort_order = ?,
              updated_at = datetime('now','localtime')
        WHERE id = ?`
    ).run(name, aliases, role, enabled, sortOrder, input.id)
    return { id: input.id }
  }

  const result = db
    .prepare(
      'INSERT INTO meeting_members (name, aliases, role, enabled, sort_order) VALUES (?, ?, ?, ?, ?)'
    )
    .run(name, aliases, role, enabled, sortOrder)
  return { id: Number(result.lastInsertRowid) }
}

// FK CASCADE가 켜져 있으면 참석자 행도 함께 지워지지만, PRAGMA 상태에 기대지 않고 명시적으로 지운다.
export function removeMember(db: Db, id: number): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM meeting_attendees WHERE member_id = ?').run(id)
    db.prepare('DELETE FROM meeting_members WHERE id = ?').run(id)
  })
  tx()
}

// ── 회의 참석자 ──

// 전량 교체(set). 존재하지 않는 member_id는 INSERT ... SELECT로 조용히 걸러진다.
export function setAttendees(db: Db, meetingId: number, memberIds: number[]): void {
  const ids = Array.isArray(memberIds)
    ? Array.from(
        new Set(
          memberIds
            .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
            .map((n) => Math.round(n))
        )
      )
    : []

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(meetingId)
    const insert = db.prepare(
      'INSERT OR IGNORE INTO meeting_attendees (meeting_id, member_id) SELECT ?, id FROM meeting_members WHERE id = ?'
    )
    for (const id of ids) insert.run(meetingId, id)
  })
  tx()
}

// enabled 여부와 무관하게 반환한다 — 이미 지정된 참석자는 나중에 구성원을 비활성화해도 유지한다.
export function listAttendees(db: Db, meetingId: number): Attendee[] {
  return db
    .prepare(
      `SELECT a.member_id AS member_id, m.name AS name, m.role AS role
         FROM meeting_attendees a
         JOIN meeting_members m ON m.id = a.member_id
        WHERE a.meeting_id = ?
        ORDER BY m.sort_order ASC, m.name COLLATE NOCASE ASC`
    )
    .all(meetingId) as Attendee[]
}

// ── 프롬프트 컨텍스트 ──

// 전사/요약 파이프라인 한가운데서 호출된다. 보조 정보를 못 읽는 것이 처리 실패로
// 번지면 안 되므로 어떤 예외도 밖으로 던지지 않고 빈 컨텍스트로 흡수한다.
export function loadPromptContext(db: Db, meetingId: number): PromptContext {
  try {
    const meeting = db.prepare('SELECT project_id FROM meetings WHERE id = ?').get(meetingId) as
      | { project_id: number | null }
      | undefined
    const projectId = meeting?.project_id ?? null

    // project_id = NULL 비교는 항상 거짓이라, 프로젝트가 없는 회의는 전역 용어만 남는다.
    const rows = db
      .prepare(
        `SELECT term, aliases, note
           FROM stt_glossary
          WHERE enabled = 1 AND (project_id IS NULL OR project_id = ?)
          ORDER BY priority DESC, updated_at DESC, id DESC`
      )
      .all(projectId) as Array<{ term: string; aliases: string; note: string | null }>

    const glossary: PromptContext['glossary'] = []
    const rules: PromptContext['rules'] = []
    for (const row of rows) {
      const term = (row.term ?? '').trim()
      if (!term) continue
      glossary.push({ term, note: trimOrNull(row.note) })
      const aliases = parseAliases(row.aliases)
      if (aliases.length > 0) rules.push({ term, aliases })
    }

    return { glossary, rules, attendees: listAttendees(db, meetingId) }
  } catch {
    return EMPTY_CONTEXT
  }
}

// 요약 프롬프트가 비대해지지 않도록 잘라 넣는 예산.
const MAX_SUMMARY_TERMS = 40
const MAX_NOTE_CHARS = 60

function shortenNote(note: string): string {
  const flat = note.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_NOTE_CHARS ? `${flat.slice(0, MAX_NOTE_CHARS).trimEnd()}…` : flat
}

// AI 요약 프롬프트의 전사록 앞에 붙일 [참고 정보] 블록. 넣을 게 없으면 ''.
export function buildSummaryContextBlock(ctx: PromptContext): string {
  const attendees = (ctx?.attendees ?? [])
    .map((a) => {
      const name = (a?.name ?? '').trim()
      if (!name) return ''
      const role = trimOrNull(a?.role)
      return role ? `${name}(${role})` : name
    })
    .filter(Boolean)

  const terms = (ctx?.glossary ?? [])
    .slice(0, MAX_SUMMARY_TERMS)
    .map((g) => {
      const term = (g?.term ?? '').trim()
      if (!term) return ''
      const note = trimOrNull(g?.note)
      return note ? `${term} — ${shortenNote(note)}` : term
    })
    .filter(Boolean)

  if (attendees.length === 0 && terms.length === 0) return ''

  const lines = ['[참고 정보]']
  if (attendees.length > 0) lines.push(`- 참석자: ${attendees.join(', ')}`)
  if (terms.length > 0) lines.push(`- 용어: ${terms.join('; ')}`)

  // 참고 정보가 없는 항목까지 지시하면 모델이 없는 것을 지어내려 하므로 있는 것만 지시한다.
  // 담당자는 "가능하면"이 아니라 참석자 명단으로 **제약**한다 — 열어 두면 전사록에 스쳐
  // 지나간 이름이나 지어낸 이름이 액션아이템 담당자로 올라온다(상용 회의 도구들의 규칙).
  const directives: string[] = []
  if (terms.length > 0) directives.push('표기는 위 용어집을 따르세요.')
  if (attendees.length > 0) {
    directives.push('담당자(assignee)는 위 참석자 이름 중에서만 고르고, 특정할 수 없으면 비워두세요.')
  }
  directives.push('참고 정보에만 있고 전사록에 없는 내용은 만들어내지 마세요.')
  lines.push(directives.join(' '))

  return lines.join('\n')
}
