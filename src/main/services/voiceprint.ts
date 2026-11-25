// 목소리 등록(보이스프린트) — 화자 centroid 저장·구성원 표본·자동 매칭
// SSOT: docs/MEETING_RECORDING.md (목소리 등록)
//
// - 화자분리(adapter 'sherpa')가 내놓은 화자별 centroid(L2 정규화 192차원)를 meeting_speaker_voices에 둔다.
//   meeting_speakers는 recording:get이 SELECT *로 렌더러에 넘기므로 BLOB은 별도 테이블에만 둔다.
// - 사용자가 화자에 구성원 이름을 붙이면(수동 등록) 그 centroid를 member_voice_samples에 표본으로 남긴다.
// - 구성원 프로필은 저장하지 않고 매칭 때 계산한다: 같은 모델의 최근 20개 표본을
//   min(speech_ms, 300초) 가중 평균 후 L2 정규화.
// - 임베딩은 로컬 SQLite에만 있다. 요약 프롬프트·모바일·Markdown 내보내기·렌더러 IPC 응답에 넣지 않는다.
//
// 이 모듈은 DB 핸들을 인자로 받는다(getDatabase()를 부르지 않는다). 순수 함수는 DB 없이 테스트한다.
import type Database from 'better-sqlite3'

type Db = Database.Database

// ── 상수(한 곳에서 관리) ──

/** 자동 지정 최소 유사도 */
export const AUTO_MATCH_MIN = 0.7
/** 자동 지정 시 1순위와 2순위 후보의 최소 점수 차 */
export const AUTO_MATCH_MARGIN = 0.08
/** 제안("혹시 OOO?") 최소 유사도 */
export const SUGGEST_MATCH_MIN = 0.6
/** 자동 매칭 대상 화자의 최소 발화 길이 */
export const MATCH_MIN_SPEECH_MS = 10_000
/** 표본으로 등록할 최소 발화 길이 */
export const ENROLL_MIN_SPEECH_MS = 20_000
/** 프로필 계산에 쓰는 최근 표본 수 */
export const PROFILE_MAX_SAMPLES = 20
/** 표본 하나의 가중치 상한(발화 길이) */
export const PROFILE_WEIGHT_CAP_MS = 300_000

/** 발화가 짧거나 목소리가 없어 표본으로 등록할 수 없을 때 */
export const SHORT_VOICE_ERROR = '발화가 짧아 목소리를 등록할 수 없습니다(20초 이상 필요).'

// ── 스키마 ──

// meeting_speakers·meetings·meeting_members를 참조하므로 그 뒤(RECOGNITION_AIDS_SCHEMA 다음)에 실행한다.
export const VOICEPRINT_SCHEMA = `
  -- 화자별 목소리 centroid (화자분리 adapter 'sherpa'일 때만 생긴다)
  CREATE TABLE IF NOT EXISTS meeting_speaker_voices (
    speaker_id INTEGER PRIMARY KEY,
    meeting_id INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    speech_ms INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (speaker_id) REFERENCES meeting_speakers(id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
  );

  -- 구성원 목소리 표본. 회의를 지워도 표본은 남고(SET NULL), 구성원을 지우면 함께 지워진다.
  CREATE TABLE IF NOT EXISTS member_voice_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    meeting_id INTEGER,
    speaker_key TEXT,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    speech_ms INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (member_id) REFERENCES meeting_members(id) ON DELETE CASCADE,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_member_voice_samples_src
    ON member_voice_samples(member_id, meeting_id, speaker_key);
`

/** meeting_speakers 구성원 연결 컬럼을 더하고(없을 때만) 목소리 테이블을 만든다. */
export function applyVoiceprintSchema(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(meeting_speakers)').all() as { name: string }[]
  if (columns.length > 0) {
    const names = columns.map((c) => c.name)
    if (!names.includes('member_id')) db.exec('ALTER TABLE meeting_speakers ADD COLUMN member_id INTEGER')
    // NULL | 'manual' | 'auto' | 'suggested'
    if (!names.includes('member_source')) db.exec('ALTER TABLE meeting_speakers ADD COLUMN member_source TEXT')
    if (!names.includes('match_score')) db.exec('ALTER TABLE meeting_speakers ADD COLUMN match_score REAL')
    if (!names.includes('rejected_member_ids')) {
      db.exec("ALTER TABLE meeting_speakers ADD COLUMN rejected_member_ids TEXT NOT NULL DEFAULT '[]'")
    }
  }
  db.exec(VOICEPRINT_SCHEMA)
}

// ── 순수 함수 ──

export type MemberSource = 'manual' | 'auto' | 'suggested'

/** Float32 리틀엔디언 바이트열로 직렬화한다. */
export function encodeEmbedding(embedding: Float32Array | number[]): Buffer {
  const arr = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding)
  const buf = Buffer.alloc(arr.length * 4)
  for (let i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i], i * 4)
  return buf
}

/** BLOB(Buffer·Uint8Array)을 Float32Array로 되돌린다. 길이가 4의 배수가 아니면 null. */
export function decodeEmbedding(blob: Uint8Array | null | undefined): Float32Array | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const out = new Float32Array(blob.byteLength / 4)
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}

function l2normalize(v: Float32Array): Float32Array | null {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm === 0) return null
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}

/** 코사인 유사도. 차원이 다르거나 영벡터면 0. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

export interface VoiceSample {
  embedding: Float32Array
  speech_ms: number
  model: string
}

/**
 * 구성원 프로필. samples는 최신 순(새것이 앞)이어야 한다.
 * 같은 모델·같은 차원(첫 표본 기준)의 표본만 최근 PROFILE_MAX_SAMPLES개를 쓰고,
 * min(speech_ms, PROFILE_WEIGHT_CAP_MS)로 가중 평균한 뒤 L2 정규화한다. 쓸 표본이 없으면 null.
 */
export function buildMemberProfile(samples: VoiceSample[], model: string): Float32Array | null {
  const usable = samples.filter((s) => s.model === model && s.embedding.length > 0)
  if (usable.length === 0) return null
  const dim = usable[0].embedding.length
  const recent = usable.filter((s) => s.embedding.length === dim).slice(0, PROFILE_MAX_SAMPLES)
  const acc = new Float32Array(dim)
  let totalWeight = 0
  for (const s of recent) {
    const w = Math.min(Math.max(0, s.speech_ms), PROFILE_WEIGHT_CAP_MS)
    if (w <= 0) continue
    for (let i = 0; i < dim; i++) acc[i] += s.embedding[i] * w
    totalWeight += w
  }
  if (totalWeight === 0) {
    // 발화 길이가 모두 0이면 단순 평균
    for (const s of recent) for (let i = 0; i < dim; i++) acc[i] += s.embedding[i]
  }
  return l2normalize(acc)
}

export interface Centroid {
  embedding: Float32Array
  speech_ms: number
}

/**
 * 두 centroid를 speech_ms 가중 평균해 합친다(수동 병합용). 둘 다 0이면 같은 가중.
 * 차원이 다르면 합칠 수 없어 발화가 긴 쪽을 그대로 돌려준다.
 */
export function combineCentroids(a: Centroid, b: Centroid): Centroid {
  const speech = Math.max(0, a.speech_ms) + Math.max(0, b.speech_ms)
  if (a.embedding.length !== b.embedding.length) {
    const keep = a.speech_ms >= b.speech_ms ? a : b
    return { embedding: keep.embedding, speech_ms: speech }
  }
  let wa = Math.max(0, a.speech_ms)
  let wb = Math.max(0, b.speech_ms)
  if (wa + wb === 0) {
    wa = 1
    wb = 1
  }
  const acc = new Float32Array(a.embedding.length)
  for (let i = 0; i < acc.length; i++) acc[i] = a.embedding[i] * wa + b.embedding[i] * wb
  return { embedding: l2normalize(acc) ?? a.embedding, speech_ms: speech }
}

export interface MatchSpeaker {
  speaker_key: string
  embedding: Float32Array | null
  speech_ms: number
  /** 이미 이름이 붙은 화자(승계 등)는 매칭 대상이 아니다 */
  display_name: string | null
  rejected_member_ids: number[]
}

export interface MatchMember {
  member_id: number
  name: string
  enabled: boolean
  /** buildMemberProfile 결과. null이면 표본이 없어 후보가 아니다 */
  profile: Float32Array | null
}

export interface VoiceMatch {
  member_id: number
  source: 'auto' | 'suggested'
  score: number
}

/**
 * 자동 매칭 계획(순수 함수).
 * - 대상: centroid가 있고 speech_ms ≥ MATCH_MIN_SPEECH_MS, display_name이 없는 화자.
 * - 후보: 프로필이 있는 켜진 구성원. attendeeIds가 비어 있지 않으면 참석자로 좁힌다.
 *   화자별 rejected_member_ids와 takenMemberIds(이미 이 회의의 다른 화자에 연결된 구성원)는 뺀다.
 * - 점수 내림차순 탐욕 1:1 배정(SUGGEST_MATCH_MIN 이상 쌍만).
 *   점수 ≥ AUTO_MATCH_MIN 이고 그 화자의 2순위 후보와 차가 ≥ AUTO_MATCH_MARGIN 이면 'auto',
 *   아니면 'suggested'.
 * @returns speaker_key → 매칭
 */
export function planVoiceMatches(input: {
  speakers: MatchSpeaker[]
  members: MatchMember[]
  attendeeIds?: number[]
  takenMemberIds?: number[]
}): Map<string, VoiceMatch> {
  const result = new Map<string, VoiceMatch>()
  const attendees = new Set(input.attendeeIds ?? [])
  const taken = new Set(input.takenMemberIds ?? [])
  const candidates = input.members.filter(
    (m) =>
      m.enabled &&
      m.profile !== null &&
      !taken.has(m.member_id) &&
      (attendees.size === 0 || attendees.has(m.member_id))
  )
  if (candidates.length === 0) return result

  const targets = input.speakers.filter(
    (s) =>
      s.embedding !== null &&
      s.speech_ms >= MATCH_MIN_SPEECH_MS &&
      !(s.display_name && s.display_name.trim())
  )

  interface Pair {
    speaker_key: string
    member_id: number
    score: number
    order: number
  }
  const pairs: Pair[] = []
  // 화자별 후보 점수(내림차순) — 2순위 차 판정용
  const scoresBySpeaker = new Map<string, number[]>()
  let order = 0
  for (const sp of targets) {
    const rejected = new Set(sp.rejected_member_ids)
    const scores: number[] = []
    for (const m of candidates) {
      if (rejected.has(m.member_id)) continue
      const score = cosineSimilarity(sp.embedding as Float32Array, m.profile as Float32Array)
      scores.push(score)
      pairs.push({ speaker_key: sp.speaker_key, member_id: m.member_id, score, order: order++ })
    }
    scores.sort((a, b) => b - a)
    scoresBySpeaker.set(sp.speaker_key, scores)
  }

  pairs.sort((a, b) => b.score - a.score || a.order - b.order)
  const usedMembers = new Set<number>()
  for (const p of pairs) {
    if (p.score < SUGGEST_MATCH_MIN) break
    if (result.has(p.speaker_key) || usedMembers.has(p.member_id)) continue
    const scores = scoresBySpeaker.get(p.speaker_key) ?? []
    // 이 쌍보다 높은 점수는 이미 다른 화자에 배정돼 빠졌을 수 있다. 2순위는 이 쌍을 뺀 최고 점수.
    const idx = scores.indexOf(p.score)
    const others = scores.filter((_, i) => i !== idx)
    const second = others.length > 0 ? Math.max(...others) : -Infinity
    const isAuto = p.score >= AUTO_MATCH_MIN && p.score - second >= AUTO_MATCH_MARGIN
    result.set(p.speaker_key, { member_id: p.member_id, source: isAuto ? 'auto' : 'suggested', score: p.score })
    usedMembers.add(p.member_id)
  }
  return result
}

/** rejected_member_ids 컬럼(JSON number[])을 읽는다. 손상되면 []. */
export function parseRejectedIds(raw: unknown): number[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return Array.from(
      new Set(v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).map((n) => Math.round(n)))
    )
  } catch {
    return []
  }
}

// ── DB 함수 ──

interface SpeakerRow {
  id: number
  meeting_id: number
  speaker_key: string
  display_name: string | null
  member_id: number | null
  member_source: string | null
  match_score: number | null
  rejected_member_ids: string
}

interface VoiceRow {
  embedding: Uint8Array
  model: string
  dim: number
  speech_ms: number
}

function getSpeaker(db: Db, speakerId: number): SpeakerRow | undefined {
  return db
    .prepare(
      `SELECT id, meeting_id, speaker_key, display_name, member_id, member_source, match_score, rejected_member_ids
         FROM meeting_speakers WHERE id = ?`
    )
    .get(speakerId) as SpeakerRow | undefined
}

function getVoice(db: Db, speakerId: number): VoiceRow | undefined {
  return db
    .prepare('SELECT embedding, model, dim, speech_ms FROM meeting_speaker_voices WHERE speaker_id = ?')
    .get(speakerId) as VoiceRow | undefined
}

/** 화자 centroid를 저장한다(있으면 교체). */
export function saveSpeakerVoice(
  db: Db,
  speakerId: number,
  meetingId: number,
  voice: { embedding: Float32Array; speech_ms: number; model: string }
): void {
  db.prepare(
    `INSERT INTO meeting_speaker_voices (speaker_id, meeting_id, embedding, model, dim, speech_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(speaker_id) DO UPDATE SET
       meeting_id = excluded.meeting_id, embedding = excluded.embedding, model = excluded.model,
       dim = excluded.dim, speech_ms = excluded.speech_ms`
  ).run(
    speakerId,
    meetingId,
    encodeEmbedding(voice.embedding),
    voice.model,
    voice.embedding.length,
    Math.max(0, Math.round(voice.speech_ms))
  )
}

/** 켜진 구성원 중 이름 또는 별칭이 정확히(앞뒤 공백·대소문자 무시) 같은 구성원. */
export function findMemberByName(db: Db, name: string | null | undefined): { id: number; name: string } | null {
  const target = (name ?? '').trim().toLowerCase()
  if (!target) return null
  const rows = db
    .prepare('SELECT id, name, aliases FROM meeting_members WHERE enabled = 1 ORDER BY sort_order ASC, id ASC')
    .all() as { id: number; name: string; aliases: string }[]
  for (const row of rows) {
    if ((row.name ?? '').trim().toLowerCase() === target) return { id: row.id, name: row.name }
  }
  for (const row of rows) {
    let aliases: unknown = []
    try {
      aliases = JSON.parse(row.aliases || '[]')
    } catch {
      aliases = []
    }
    if (
      Array.isArray(aliases) &&
      aliases.some((a) => typeof a === 'string' && a.trim().toLowerCase() === target)
    ) {
      return { id: row.id, name: row.name }
    }
  }
  return null
}

/** 이 화자의 centroid를 구성원 표본으로 등록한다. 목소리가 없거나 짧으면 false. */
function enrollSample(db: Db, memberId: number, speaker: SpeakerRow): boolean {
  const voice = getVoice(db, speaker.id)
  if (!voice || voice.speech_ms < ENROLL_MIN_SPEECH_MS) return false
  db.prepare(
    `INSERT INTO member_voice_samples (member_id, meeting_id, speaker_key, embedding, model, dim, speech_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(member_id, meeting_id, speaker_key) DO UPDATE SET
       embedding = excluded.embedding, model = excluded.model, dim = excluded.dim,
       speech_ms = excluded.speech_ms, created_at = datetime('now','localtime')`
  ).run(memberId, speaker.meeting_id, speaker.speaker_key, voice.embedding, voice.model, voice.dim, voice.speech_ms)
  return true
}

function deleteSpeakerSample(db: Db, memberId: number, speaker: SpeakerRow): void {
  db.prepare(
    'DELETE FROM member_voice_samples WHERE member_id = ? AND meeting_id = ? AND speaker_key = ?'
  ).run(memberId, speaker.meeting_id, speaker.speaker_key)
}

export interface EnrollResult {
  member_id: number | null
  enrolled: boolean
}

/**
 * 화자의 display_name이 바뀐 뒤 구성원 연결·표본을 맞춘다(수동).
 * - 켜진 구성원의 이름·별칭과 정확히 같으면 연결(member_source='manual') + 표본 upsert(발화 ≥ 20초).
 * - 이름을 지웠거나 구성원이 아닌 이름이면 연결과 그 화자에서 온 표본을 지운다.
 */
export function syncSpeakerEnrollment(db: Db, speakerId: number): EnrollResult {
  const speaker = getSpeaker(db, speakerId)
  if (!speaker) return { member_id: null, enrolled: false }
  const member = findMemberByName(db, speaker.display_name)
  if (speaker.member_id !== null && speaker.member_id !== member?.id) {
    deleteSpeakerSample(db, speaker.member_id, speaker)
  }
  if (!member) {
    db.prepare(
      'UPDATE meeting_speakers SET member_id = NULL, member_source = NULL, match_score = NULL WHERE id = ?'
    ).run(speakerId)
    return { member_id: null, enrolled: false }
  }
  return linkManual(db, speaker, member.id)
}

function linkManual(db: Db, speaker: SpeakerRow, memberId: number): EnrollResult {
  db.prepare(
    "UPDATE meeting_speakers SET member_id = ?, member_source = 'manual', match_score = NULL WHERE id = ?"
  ).run(memberId, speaker.id)
  const enrolled = enrollSample(db, memberId, { ...speaker, member_id: memberId })
  return { member_id: memberId, enrolled }
}

/**
 * [목소리 등록] 버튼. 화자 이름이 구성원이면 연결·등록하고, 구성원이 아니면 그 이름으로
 * 구성원을 만든 뒤 등록한다.
 */
export function enrollSpeakerVoice(db: Db, speakerId: number): EnrollResult & { created: boolean } {
  const speaker = getSpeaker(db, speakerId)
  if (!speaker) throw new Error('존재하지 않는 화자입니다.')
  const name = (speaker.display_name ?? '').trim()
  if (!name) throw new Error('화자 이름을 먼저 입력해 주세요.')
  // 등록할 수 없으면 구성원을 만들거나 연결하기 전에 멈춘다(부작용 없음).
  const voice = getVoice(db, speakerId)
  if (!voice || voice.speech_ms < ENROLL_MIN_SPEECH_MS) throw new Error(SHORT_VOICE_ERROR)
  let created = false
  let member = findMemberByName(db, name)
  if (!member) {
    const res = db.prepare('INSERT INTO meeting_members (name) VALUES (?)').run(name)
    member = { id: Number(res.lastInsertRowid), name }
    created = true
  }
  if (speaker.member_id !== null && speaker.member_id !== member.id) {
    deleteSpeakerSample(db, speaker.member_id, speaker)
  }
  return { ...linkManual(db, speaker, member.id), created }
}

/** [맞음]/[지정]: auto·suggested 연결을 manual로 확정하고 이름을 붙인 뒤 표본으로 등록한다. */
export function confirmSpeakerMatch(db: Db, speakerId: number): EnrollResult {
  const speaker = getSpeaker(db, speakerId)
  if (!speaker || speaker.member_id === null) throw new Error('확정할 목소리 매칭이 없습니다.')
  const member = db.prepare('SELECT id, name FROM meeting_members WHERE id = ?').get(speaker.member_id) as
    | { id: number; name: string }
    | undefined
  if (!member) throw new Error('구성원을 찾을 수 없습니다.')
  db.prepare('UPDATE meeting_speakers SET display_name = ? WHERE id = ?').run(member.name, speakerId)
  return linkManual(db, { ...speaker, display_name: member.name }, member.id)
}

/**
 * [이 사람 아님]/[아님]: 그 구성원을 거부 목록에 넣고 연결을 끊는다.
 * auto였으면 자동으로 붙인 이름도 비운다. 이 화자에서 온 그 구성원의 표본도 지운다.
 */
export function rejectSpeakerMatch(db: Db, speakerId: number): { success: boolean } {
  const speaker = getSpeaker(db, speakerId)
  if (!speaker || speaker.member_id === null) return { success: false }
  const rejected = parseRejectedIds(speaker.rejected_member_ids)
  if (!rejected.includes(speaker.member_id)) rejected.push(speaker.member_id)
  const clearName = speaker.member_source === 'auto'
  db.prepare(
    `UPDATE meeting_speakers
        SET member_id = NULL, member_source = NULL, match_score = NULL, rejected_member_ids = ?
            ${clearName ? ', display_name = NULL' : ''}
      WHERE id = ?`
  ).run(JSON.stringify(rejected), speakerId)
  deleteSpeakerSample(db, speaker.member_id, speaker)
  return { success: true }
}

/**
 * 수동 병합(from → into) 직전에 부른다. 두 centroid를 speech_ms 가중 평균해 into에 두고,
 * from에서 온 표본은 지운다. into가 manual로 연결돼 있으면 합친 centroid로 표본을 갱신한다.
 * 모델이 다르면 into(없으면 from)의 것을 유지한다.
 */
export function mergeSpeakerVoices(db: Db, meetingId: number, fromSpeakerId: number, intoSpeakerId: number): boolean {
  if (!speakersBelongToMeeting(db, meetingId, [fromSpeakerId, intoSpeakerId])) return false
  const from = getSpeaker(db, fromSpeakerId)
  const into = getSpeaker(db, intoSpeakerId)
  if (!from || !into) return false
  const fv = getVoice(db, fromSpeakerId)
  const iv = getVoice(db, intoSpeakerId)
  const fe = fv ? decodeEmbedding(fv.embedding) : null
  const ie = iv ? decodeEmbedding(iv.embedding) : null
  if (fv && fe && iv && ie && fv.model === iv.model) {
    const merged = combineCentroids(
      { embedding: ie, speech_ms: iv.speech_ms },
      { embedding: fe, speech_ms: fv.speech_ms }
    )
    saveSpeakerVoice(db, intoSpeakerId, into.meeting_id, { ...merged, model: iv.model })
  } else if (fv && fe && !iv) {
    saveSpeakerVoice(db, intoSpeakerId, into.meeting_id, { embedding: fe, speech_ms: fv.speech_ms, model: fv.model })
  }
  if (from.member_id !== null) deleteSpeakerSample(db, from.member_id, from)
  db.prepare('DELETE FROM meeting_speaker_voices WHERE speaker_id = ?').run(fromSpeakerId)
  if (into.member_id !== null && into.member_source === 'manual') enrollSample(db, into.member_id, into)
  return true
}

/** 서로 다른 화자들이 모두 그 회의에 속하는지 */
export function speakersBelongToMeeting(db: Db, meetingId: number, speakerIds: number[]): boolean {
  const ids = Array.from(new Set(speakerIds))
  if (ids.length !== speakerIds.length || ids.length === 0) return false
  if (!ids.every((n) => typeof n === 'number' && Number.isFinite(n))) return false
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM meeting_speakers WHERE meeting_id = ? AND id IN (${ids.map(() => '?').join(', ')})`
    )
    .get(meetingId, ...ids) as { n: number }
  return row.n === ids.length
}

/** 같은 모델 표본으로 켜진 구성원의 프로필을 계산한다. */
export function loadMemberProfiles(db: Db, model: string): MatchMember[] {
  const members = db
    .prepare('SELECT id, name, enabled FROM meeting_members ORDER BY sort_order ASC, id ASC')
    .all() as { id: number; name: string; enabled: number }[]
  const sampleStmt = db.prepare(
    `SELECT embedding, speech_ms, model FROM member_voice_samples
      WHERE member_id = ? AND model = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`
  )
  return members.map((m) => {
    const rows = sampleStmt.all(m.id, model, PROFILE_MAX_SAMPLES) as {
      embedding: Uint8Array
      speech_ms: number
      model: string
    }[]
    const samples: VoiceSample[] = []
    for (const r of rows) {
      const e = decodeEmbedding(r.embedding)
      if (e) samples.push({ embedding: e, speech_ms: r.speech_ms, model: r.model })
    }
    return { member_id: m.id, name: m.name, enabled: m.enabled === 1, profile: buildMemberProfile(samples, model) }
  })
}

/** 구성원별 표본 요약(임베딩 제외). */
export function listVoiceprints(
  db: Db
): Array<{ member_id: number; sample_count: number; total_speech_ms: number; updated_at: string | null }> {
  return db
    .prepare(
      `SELECT member_id, COUNT(*) AS sample_count, COALESCE(SUM(speech_ms), 0) AS total_speech_ms,
              MAX(created_at) AS updated_at
         FROM member_voice_samples
        GROUP BY member_id
        ORDER BY member_id`
    )
    .all() as Array<{ member_id: number; sample_count: number; total_speech_ms: number; updated_at: string | null }>
}

/** 구성원의 표본을 모두 지운다. 회의 화자의 연결은 그대로 둔다. */
export function clearVoiceprint(db: Db, memberId: number): { removed: number } {
  const res = db.prepare('DELETE FROM member_voice_samples WHERE member_id = ?').run(memberId)
  return { removed: Number(res.changes) }
}

// ── merge 트랜잭션 보조 ──

/** 재처리 직전 옛 화자의 구성원 연결 속성 */
export interface OldSpeakerLink {
  speaker_key?: string
  member_id: number | null
  member_source: string | null
  match_score: number | null
  rejected_member_ids: string
}

export function loadOldSpeakerLinks(db: Db, meetingId: number): Map<number, OldSpeakerLink> {
  const rows = db
    .prepare(
      'SELECT id, speaker_key, member_id, member_source, match_score, rejected_member_ids FROM meeting_speakers WHERE meeting_id = ?'
    )
    .all(meetingId) as Array<OldSpeakerLink & { id: number }>
  return new Map(rows.map((r) => [r.id, r]))
}

export interface InsertedSpeaker {
  id: number
  speaker_key: string
  display_name: string | null
  /** 승계 원본(옛 화자 id). 없으면 새 화자 */
  oldSpeakerId: number | null
  /** 이번 화자분리 centroid를 쓸지(수동 지정 보존으로 다시 만든 옛 화자 행은 false) */
  useVoice?: boolean
}

/**
 * merge 트랜잭션 안에서, 화자 행을 넣은 직후 부른다.
 * 1) adapter 'sherpa'의 voices를 meeting_speaker_voices에 저장
 * 2) 옛 화자에서 구성원 연결 승계(승계 이름이 구성원 이름이면 manual 연결 + 표본 교체)
 * 3) 이름 없는 화자를 planVoiceMatches로 자동 지정·제안
 */
export function applyMeetingVoices(
  db: Db,
  input: {
    meetingId: number
    speakers: InsertedSpeaker[]
    voices: Array<{ speaker_key: string; embedding: Float32Array; speech_ms: number }>
    model: string | null
    oldLinks: Map<number, OldSpeakerLink>
    attendeeIds: number[]
  }
): { auto: number; suggested: number } {
  const voiceByKey = new Map(input.voices.map((v) => [v.speaker_key, v]))
  if (input.model) {
    for (const sp of input.speakers) {
      if (sp.useVoice === false) continue
      const v = voiceByKey.get(sp.speaker_key)
      if (v && v.embedding.length > 0) saveSpeakerVoice(db, sp.id, input.meetingId, { ...v, model: input.model })
    }
  }

  const setLink = db.prepare(
    `UPDATE meeting_speakers
        SET member_id = ?, member_source = ?, match_score = ?, rejected_member_ids = ?
      WHERE id = ?`
  )
  const taken = new Set<number>()
  const rejectedBySpeaker = new Map<number, number[]>()
  const replacedMembers = new Set<number>()
  for (const sp of input.speakers) {
    const old = sp.oldSpeakerId !== null ? input.oldLinks.get(sp.oldSpeakerId) : undefined
    const rejected = parseRejectedIds(old?.rejected_member_ids)
    rejectedBySpeaker.set(sp.id, rejected)
    const rejectedJson = JSON.stringify(rejected)
    const member = sp.display_name ? findMemberByName(db, sp.display_name) : null
    if (member) {
      // 자동 지정 이름이 그대로 승계됐으면 auto 유지(사용자가 확정하지 않았다)
      const keepAuto = old?.member_source === 'auto' && old.member_id === member.id
      setLink.run(
        member.id,
        keepAuto ? 'auto' : 'manual',
        keepAuto ? old.match_score : null,
        rejectedJson,
        sp.id
      )
      taken.add(member.id)
      if (!keepAuto) {
        // 표본 교체: 이 회의에서 그 구성원으로 등록된 옛 표본을 새 centroid로 바꾼다.
        const row = getSpeaker(db, sp.id)
        const voice = getVoice(db, sp.id)
        if (row && voice && voice.speech_ms >= ENROLL_MIN_SPEECH_MS) {
          if (!replacedMembers.has(member.id)) {
            db.prepare('DELETE FROM member_voice_samples WHERE member_id = ? AND meeting_id = ?').run(
              member.id,
              input.meetingId
            )
            replacedMembers.add(member.id)
          }
          enrollSample(db, member.id, row)
        } else if (
          !replacedMembers.has(member.id) &&
          old?.speaker_key !== undefined &&
          old.speaker_key !== sp.speaker_key
        ) {
          // 새 centroid로 바꿀 수 없어 옛 표본을 유지한다. 출처 키만 새 화자 키로 옮겨
          // 이후 표본 삭제·voice_enrolled 조회가 현재 화자와 맞게 한다(같은 키의 옛 행이 있으면 먼저 지운다).
          const moved = db
            .prepare(
              'SELECT id FROM member_voice_samples WHERE member_id = ? AND meeting_id = ? AND speaker_key = ?'
            )
            .get(member.id, input.meetingId, old.speaker_key) as { id: number } | undefined
          if (moved) {
            db.prepare(
              'DELETE FROM member_voice_samples WHERE member_id = ? AND meeting_id = ? AND speaker_key = ?'
            ).run(member.id, input.meetingId, sp.speaker_key)
            db.prepare('UPDATE member_voice_samples SET speaker_key = ? WHERE id = ?').run(sp.speaker_key, moved.id)
          }
        }
      }
    } else {
      setLink.run(null, null, null, rejectedJson, sp.id)
    }
  }

  let auto = 0
  let suggested = 0
  if (!input.model) return { auto, suggested }
  const members = loadMemberProfiles(db, input.model)
  if (!members.some((m) => m.profile !== null)) return { auto, suggested }
  const matchSpeakers: MatchSpeaker[] = input.speakers.map((sp) => {
    const v = sp.useVoice === false ? undefined : voiceByKey.get(sp.speaker_key)
    return {
      speaker_key: String(sp.id),
      embedding: v && v.embedding.length > 0 ? v.embedding : null,
      speech_ms: v?.speech_ms ?? 0,
      display_name: sp.display_name,
      rejected_member_ids: rejectedBySpeaker.get(sp.id) ?? []
    }
  })
  const matches = planVoiceMatches({
    speakers: matchSpeakers,
    members,
    attendeeIds: input.attendeeIds,
    takenMemberIds: [...taken]
  })
  const nameById = new Map(members.map((m) => [m.member_id, m.name]))
  for (const [key, match] of matches) {
    const speakerId = Number(key)
    const rejectedJson = JSON.stringify(rejectedBySpeaker.get(speakerId) ?? [])
    setLink.run(match.member_id, match.source, match.score, rejectedJson, speakerId)
    if (match.source === 'auto') {
      db.prepare('UPDATE meeting_speakers SET display_name = ? WHERE id = ?').run(
        nameById.get(match.member_id) ?? null,
        speakerId
      )
      auto++
    } else {
      suggested++
    }
  }
  return { auto, suggested }
}

/**
 * applyMeetingVoices를 best-effort로 실행한다(merge 트랜잭션 안에서 부른다).
 * SAVEPOINT로 감싸 실패하면 목소리 저장·연결·매칭만 되돌리고 error를 돌려준다. 처리는 계속된다.
 */
export function applyMeetingVoicesSafe(
  db: Db,
  input: Parameters<typeof applyMeetingVoices>[1]
): { auto: number; suggested: number; error?: string } {
  db.exec('SAVEPOINT meeting_voices')
  try {
    const result = applyMeetingVoices(db, input)
    db.exec('RELEASE SAVEPOINT meeting_voices')
    return result
  } catch (err) {
    db.exec('ROLLBACK TO SAVEPOINT meeting_voices')
    db.exec('RELEASE SAVEPOINT meeting_voices')
    return { auto: 0, suggested: 0, error: err instanceof Error ? err.message : String(err) }
  }
}
