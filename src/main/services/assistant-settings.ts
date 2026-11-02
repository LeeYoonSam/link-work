// 비서 설정의 키·기본값·검증 (docs/ASSISTANT.md §3.2, 부록 C.2).
// 순수 모듈이다 (A3). DB 읽기·쓰기는 assistant-store.ts 가 한다.
import type { AiModelName, AssistantSettings } from './assistant-types'

export const ASSISTANT_SETTING_KEYS: Record<keyof AssistantSettings, string> = {
  enabled: 'assistant_enabled',
  dayRollover: 'assistant_day_rollover',
  startNudge: 'assistant_start_nudge',
  workEnd: 'assistant_work_end',
  planSize: 'assistant_plan_size',
  llmEnabled: 'assistant_llm_enabled',
  llmModel: 'assistant_llm_model',
  jiraScope: 'assistant_jira_scope',
  openAtLogin: 'assistant_open_at_login',
  refreshCalendarMin: 'assistant_refresh_calendar_min',
  refreshJiraMin: 'assistant_refresh_jira_min',
  refreshNotify: 'assistant_refresh_notify',
  checkinMinGap: 'assistant_checkin_min_gap',
  checkinDailyCap: 'assistant_checkin_daily_cap',
  meetingLeadMin: 'assistant_meeting_lead_min',
  startView: 'assistant_start_view'
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  enabled: true,
  dayRollover: '04:00',
  startNudge: true,
  workEnd: '18:00',
  planSize: 5,
  llmEnabled: true,
  llmModel: 'sonnet',
  jiraScope: 'all',
  openAtLogin: false,
  refreshCalendarMin: 5,
  refreshJiraMin: 15,
  refreshNotify: true,
  checkinMinGap: 45,
  checkinDailyCap: 4,
  meetingLeadMin: 15,
  startView: 'auto'
}

type FieldSpec =
  | { kind: 'bool' }
  | { kind: 'time' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] }

const AI_MODELS: readonly AiModelName[] = ['opus', 'sonnet', 'haiku']

// 정수 범위는 설계 문서에 없다. 화면 입력의 상식적 범위로 정한다.
const FIELD_SPECS: Record<keyof AssistantSettings, FieldSpec> = {
  enabled: { kind: 'bool' },
  dayRollover: { kind: 'time' },
  startNudge: { kind: 'bool' },
  workEnd: { kind: 'time' },
  planSize: { kind: 'int', min: 1, max: 20 },
  llmEnabled: { kind: 'bool' },
  llmModel: { kind: 'enum', values: AI_MODELS },
  jiraScope: { kind: 'enum', values: ['all', 'default_project'] },
  openAtLogin: { kind: 'bool' },
  refreshCalendarMin: { kind: 'int', min: 1, max: 240 },
  refreshJiraMin: { kind: 'int', min: 1, max: 240 },
  refreshNotify: { kind: 'bool' },
  checkinMinGap: { kind: 'int', min: 5, max: 480 },
  checkinDailyCap: { kind: 'int', min: 0, max: 20 },
  meetingLeadMin: { kind: 'int', min: 1, max: 120 },
  startView: { kind: 'enum', values: ['auto', 'dashboard', 'today'] }
}

const FIELD_NAMES = Object.keys(ASSISTANT_SETTING_KEYS) as (keyof AssistantSettings)[]
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const INT_RE = /^-?\d+$/

// DB 문자열 → 값. 형식이 틀리면 undefined 다.
function parseValue(spec: FieldSpec, raw: string): boolean | number | string | undefined {
  const v = raw.trim()
  switch (spec.kind) {
    case 'bool':
      if (v === '1') return true
      if (v === '0') return false
      return undefined
    case 'time':
      return TIME_RE.test(v) ? v : undefined
    case 'int': {
      if (!INT_RE.test(v)) return undefined
      const n = Number(v)
      return n >= spec.min && n <= spec.max ? n : undefined
    }
    case 'enum':
      return spec.values.includes(v) ? v : undefined
  }
}

// 값 → DB 문자열. 형식이 틀리면 undefined 다.
function serializeValue(spec: FieldSpec, value: unknown): string | undefined {
  switch (spec.kind) {
    case 'bool':
      return typeof value === 'boolean' ? (value ? '1' : '0') : undefined
    case 'time':
      return typeof value === 'string' && TIME_RE.test(value) ? value : undefined
    case 'int':
      return typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= spec.min &&
        value <= spec.max
        ? String(value)
        : undefined
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? value : undefined
  }
}

// app_settings 행 → 설정. 없는 키와 잘못된 값은 기본값이다.
// 3판에서 없앤 키 (assistant_slot_min) 는 FIELD_NAMES 에 없으므로 무시한다 (부록 B.6).
export function parseAssistantSettings(rows: { key: string; value: string }[]): AssistantSettings {
  const byKey = new Map<string, string>()
  for (const row of rows) {
    if (row && typeof row.key === 'string' && typeof row.value === 'string') {
      byKey.set(row.key, row.value)
    }
  }
  const out: Record<string, unknown> = { ...DEFAULT_ASSISTANT_SETTINGS }
  for (const field of FIELD_NAMES) {
    const raw = byKey.get(ASSISTANT_SETTING_KEYS[field])
    if (raw === undefined) continue
    const parsed = parseValue(FIELD_SPECS[field], raw)
    if (parsed !== undefined) out[field] = parsed
  }
  return out as unknown as AssistantSettings
}

// 부분 설정 → app_settings 행. 모르는 키나 잘못된 값이 있으면 throw 한다.
export function serializeAssistantSettingsPatch(patch: unknown): { key: string; value: string }[] {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('비서 설정 형식이 올바르지 않습니다.')
  }
  const out: { key: string; value: string }[] = []
  for (const [field, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(FIELD_SPECS, field)) {
      throw new Error(`알 수 없는 비서 설정입니다: ${field}`)
    }
    const name = field as keyof AssistantSettings
    const serialized = serializeValue(FIELD_SPECS[name], value)
    if (serialized === undefined) {
      throw new Error(`비서 설정 값이 올바르지 않습니다: ${field}`)
    }
    out.push({ key: ASSISTANT_SETTING_KEYS[name], value: serialized })
  }
  return out
}
