// 인식 보조 장치 IPC — 용어집 / 구성원
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
    // project_id는 null(전역)이 정상 값이라 undefined와 구분해서 넘긴다.
    if (raw.project_id === null) payload.project_id = null
    else {
      const projectId = asId(raw.project_id)
      if (projectId !== null) payload.project_id = projectId
    }
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
}
