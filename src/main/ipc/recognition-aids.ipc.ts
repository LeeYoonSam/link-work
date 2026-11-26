// 인식 보조 장치 IPC — 용어집 / 구성원 / 구성원 목소리 표본(요약만, 임베딩은 내보내지 않는다)
// 실제 로직은 services/recognition-aids.ts에 있고 여기서는 인자 검증과 DB 핸들 주입만 한다.
//
// 활동 로그(logActivity)는 남기지 않는다 — 용어집·구성원은 프로젝트 산출물이 아니라
// 전사 품질을 위한 설정이라, 대시보드의 최근 활동에 섞이면 잡음이 된다.
import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'
import {
  listGlossary,
  upsertGlossary,
  removeGlossary,
  importGlossaryText,
  listMembers,
  upsertMember,
  removeMember,
  type GlossaryInput,
  type MemberInput
} from '../services/recognition-aids'
import {
  listVoiceprints,
  clearVoiceprint,
  planRematch,
  applyRematch,
  type RematchOptions
} from '../services/voiceprint'

// 렌더러에서 온 값은 신뢰하지 않는다 — 타입이 어긋나면 조용히 기본값으로 떨어뜨린다.
function asId(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : null
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter((x): x is string => typeof x === 'string')
}

function asNullableString(v: unknown): string | null | undefined {
  if (v === null) return null
  return typeof v === 'string' ? v : undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/** 다시 매칭 대상 id 목록 상한 */
const REMATCH_MAX_IDS = 500

/** 양의 안전 정수만 남기고 중복을 없앤다(최대 REMATCH_MAX_IDS개). 배열이 아니면 undefined. */
function asIdList(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined
  const ids = new Set<number>()
  for (const x of v) {
    if (typeof x === 'number' && Number.isSafeInteger(x) && x > 0) ids.add(x)
    if (ids.size >= REMATCH_MAX_IDS) break
  }
  return [...ids]
}

export function sanitizeRematchOptions(raw: unknown): RematchOptions {
  const r = (raw ?? {}) as Record<string, unknown>
  const opts: RematchOptions = {}
  if (typeof raw !== 'object' || raw === null) return opts
  const meetingIds = asIdList(r.meetingIds)
  if (meetingIds) opts.meetingIds = meetingIds
  const memberIds = asIdList(r.memberIds)
  if (memberIds) opts.memberIds = memberIds
  return opts
}

export function registerRecognitionAidsIpc(): void {
  const db = getDatabase()

  // ── 용어집 ──
  ipcMain.handle('recognitionAids:listGlossary', () => listGlossary(db))

  ipcMain.handle('recognitionAids:upsertGlossary', (_e, input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>
    const term = typeof raw.term === 'string' ? raw.term : ''
    const payload: GlossaryInput = { term }
    const id = asId(raw.id)
    if (id !== null) payload.id = id
    const aliases = asStringArray(raw.aliases)
    if (aliases) payload.aliases = aliases
    const note = asNullableString(raw.note)
    if (note !== undefined) payload.note = note
    const priority = asNumber(raw.priority)
    if (priority !== undefined) payload.priority = priority
    const enabled = asBoolean(raw.enabled)
    if (enabled !== undefined) payload.enabled = enabled
    return upsertGlossary(db, payload)
  })

  ipcMain.handle('recognitionAids:removeGlossary', (_e, id: number) => {
    const target = asId(id)
    if (target === null) return { success: false }
    removeGlossary(db, target)
    return { success: true }
  })

  ipcMain.handle('recognitionAids:importGlossaryText', (_e, text: unknown) => {
    if (typeof text !== 'string') return { added: 0, updated: 0, skipped: 0 }
    return importGlossaryText(db, text)
  })

  // ── 구성원 ──
  ipcMain.handle('recognitionAids:listMembers', () => listMembers(db))

  ipcMain.handle('recognitionAids:upsertMember', (_e, input: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>
    const name = typeof raw.name === 'string' ? raw.name : ''
    const payload: MemberInput = { name }
    const id = asId(raw.id)
    if (id !== null) payload.id = id
    const aliases = asStringArray(raw.aliases)
    if (aliases) payload.aliases = aliases
    const role = asNullableString(raw.role)
    if (role !== undefined) payload.role = role
    const enabled = asBoolean(raw.enabled)
    if (enabled !== undefined) payload.enabled = enabled
    const sortOrder = asNumber(raw.sort_order)
    if (sortOrder !== undefined) payload.sort_order = sortOrder
    return upsertMember(db, payload)
  })

  ipcMain.handle('recognitionAids:removeMember', (_e, id: number) => {
    const target = asId(id)
    if (target === null) return { success: false }
    removeMember(db, target)
    return { success: true }
  })

  // ── 구성원 목소리 ──
  ipcMain.handle('recognitionAids:listVoiceprints', () => listVoiceprints(db))

  ipcMain.handle('recognitionAids:clearVoiceprint', (_e, memberId: number) => {
    const target = asId(memberId)
    if (target === null) return { success: false, removed: 0 }
    return { success: true, ...clearVoiceprint(db, target) }
  })

  // ── 다시 매칭: 옛 회의의 이름 없는 화자에 등록된 목소리를 다시 적용(표본은 만들지 않는다) ──
  ipcMain.handle('recognitionAids:previewRematch', (_e, opts: unknown) =>
    planRematch(db, sanitizeRematchOptions(opts))
  )

  ipcMain.handle('recognitionAids:applyRematch', (_e, opts: unknown) =>
    db.transaction(() => applyRematch(db, planRematch(db, sanitizeRematchOptions(opts))))()
  )
}
