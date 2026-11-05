import { getDatabase } from '../db/database'

// ── 모델 패밀리 레지스트리 ──
//
// 패밀리 정의는 이 배열 한 곳에만 둔다.
// name·hint 는 SDK 라벨을 아직 받지 못했을 때 쓰는 폴백이다.
export type AiModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku'

export interface AiModelFamilyDef {
  id: AiModelFamily
  name: string
  hint: string
}

export const AI_MODEL_FAMILIES: readonly AiModelFamilyDef[] = [
  { id: 'fable', name: 'Fable', hint: '가장 강력, 느림' },
  { id: 'opus', name: 'Opus', hint: '정확, 균형' },
  { id: 'sonnet', name: 'Sonnet', hint: '빠름, 균형' },
  { id: 'haiku', name: 'Haiku', hint: '가장 빠름' }
]

const AI_MODEL_FAMILY_IDS: readonly string[] = AI_MODEL_FAMILIES.map((f) => f.id)

function isAiModelFamily(value: unknown): value is AiModelFamily {
  return typeof value === 'string' && AI_MODEL_FAMILY_IDS.includes(value)
}

// ── 개인 비서용 고정 모델 ID (동작 유지) ──
//
// 오늘 화면 비서(assistant-briefing.ts, assistant-command-llm.ts)는 결과에 modelId 를 기록한다.
// 그래서 이 매핑은 바꾸지 않는다.
export type AiModelChoice = 'opus' | 'sonnet' | 'haiku'

const AI_MODEL_IDS: Record<AiModelChoice, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5'
}

export function resolveAiModelId(choice: AiModelChoice): string {
  return AI_MODEL_IDS[choice]
}

// ── AI 대화 모델 선택 (앱 전역 설정) ──
//
// app_settings 에는 패밀리 별칭만 저장한다.
// 쿼리는 별칭을 SDK model 옵션에 그대로 넘긴다. CLI 가 별칭을 최신 버전으로 해석한다.
export type AiChatModelChoice = 'fable' | 'opus' | 'haiku'

export const AI_CHAT_MODEL_CHOICES: readonly AiChatModelChoice[] = ['fable', 'opus', 'haiku']

export const DEFAULT_AI_CHAT_MODEL: AiChatModelChoice = 'opus'

const AI_MODEL_SETTING_KEY = 'ai_model'

export function isAiChatModelChoice(value: unknown): value is AiChatModelChoice {
  return typeof value === 'string' && (AI_CHAT_MODEL_CHOICES as readonly string[]).includes(value)
}

// 허용값이 아니면 기본값을 쓴다.
// 대상: 행 없음, 이전 선택지 'sonnet', 고정 ID 같은 구버전 값, 손상된 값.
export function normalizeAiChatModel(value: unknown): AiChatModelChoice {
  return isAiChatModelChoice(value) ? value : DEFAULT_AI_CHAT_MODEL
}

// SDK model 옵션에 넘길 값. 고정 ID 로 바꾸지 않는다.
export function resolveAiChatModel(choice: AiChatModelChoice): string {
  return choice
}

export function getAiChatModel(): AiChatModelChoice {
  const row = getDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(AI_MODEL_SETTING_KEY) as { value: string } | undefined
  return normalizeAiChatModel(row?.value)
}

export function setAiChatModel(choice: AiChatModelChoice): void {
  getDatabase()
    .prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    )
    .run(AI_MODEL_SETTING_KEY, choice)
}

// ── 동적 모델 라벨 ──
//
// SDK Query.supportedModels() 의 패밀리 별칭 항목에서 displayName·description 을 캐시한다.
// 예: { value: 'fable', displayName: 'Fable 5.1', description: '...' }
// 캐시는 메모리와 app_settings 'ai_model_labels' 에 둔다. 재시작 직후에도 라벨을 쓴다.
export interface AiModelLabel {
  displayName: string
  description: string
}

export type AiModelLabelCache = Partial<Record<AiModelFamily, AiModelLabel>>

export interface AiChatModelOption {
  value: AiChatModelChoice
  label: string
  description: string
}

const AI_MODEL_LABELS_SETTING_KEY = 'ai_model_labels'
const MAX_LABEL_LENGTH = 80
const MAX_DESCRIPTION_LENGTH = 200

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

// supportedModels() 결과에서 패밀리 별칭 항목만 골라 라벨 캐시로 만든다. 순수 함수.
// 고정 ID 항목과 형식이 틀린 항목은 버린다.
export function extractAiModelLabels(models: unknown): AiModelLabelCache {
  const cache: AiModelLabelCache = {}
  if (!Array.isArray(models)) return cache
  for (const item of models) {
    if (!item || typeof item !== 'object') continue
    const { value, displayName, description } = item as Record<string, unknown>
    if (!isAiModelFamily(value)) continue
    const name = cleanText(displayName, MAX_LABEL_LENGTH)
    if (!name) continue
    cache[value] = { displayName: name, description: cleanText(description, MAX_DESCRIPTION_LENGTH) }
  }
  return cache
}

// 저장된 캐시(JSON 객체)를 검증해 읽는다. 순수 함수. 손상된 값은 빈 캐시로 본다.
export function parseAiModelLabelCache(raw: unknown): AiModelLabelCache {
  if (typeof raw !== 'string' || !raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const items = Object.entries(parsed as Record<string, unknown>).map(([value, label]) => ({
    ...(label && typeof label === 'object' ? (label as Record<string, unknown>) : {}),
    value
  }))
  return extractAiModelLabels(items)
}

// 캐시 라벨과 선택지로 옵션 배열을 만든다. 순수 함수.
// label 은 캐시의 displayName 을 쓴다. 캐시가 없으면, 패밀리 name 으로 폴백한다.
// description 은 항상 패밀리의 한국어 hint 를 쓴다. SDK 설명은 영어라서 쓰지 않는다.
export function buildAiChatModelOptions(
  cache: AiModelLabelCache,
  choices: readonly AiChatModelChoice[] = AI_CHAT_MODEL_CHOICES
): AiChatModelOption[] {
  return choices.map((choice) => {
    const family = AI_MODEL_FAMILIES.find((f) => f.id === choice)
    const cached = cache[choice]
    return {
      value: choice,
      label: cached?.displayName || family?.name || choice,
      description: family?.hint ?? ''
    }
  })
}

let labelCache: AiModelLabelCache | null = null

export function getAiModelLabelCache(): AiModelLabelCache {
  if (labelCache) return labelCache
  try {
    const row = getDatabase()
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(AI_MODEL_LABELS_SETTING_KEY) as { value: string } | undefined
    labelCache = parseAiModelLabelCache(row?.value)
  } catch {
    labelCache = {}
  }
  return labelCache
}

export function hasAiModelLabels(): boolean {
  return Object.keys(getAiModelLabelCache()).length > 0
}

// supportedModels() 결과로 캐시를 갱신한다.
// 패밀리 항목이 하나도 없으면, 기존 캐시를 지우지 않고 false 를 반환한다.
export function updateAiModelLabels(models: unknown): boolean {
  const next = extractAiModelLabels(models)
  if (Object.keys(next).length === 0) return false
  const serialized = JSON.stringify(next)
  if (labelCache && JSON.stringify(labelCache) === serialized) return true
  labelCache = next
  try {
    getDatabase()
      .prepare(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
      )
      .run(AI_MODEL_LABELS_SETTING_KEY, serialized)
  } catch {
    // 저장 실패는 메모리 캐시만으로 계속 동작한다.
  }
  return true
}

// 테스트 전용: 메모리 캐시를 비운다.
export function resetAiModelLabelCacheForTest(): void {
  labelCache = null
}
