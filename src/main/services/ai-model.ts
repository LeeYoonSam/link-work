import { getDatabase } from '../db/database'

// AI 대화 모델 선택 (앱 전역 설정). app_settings에는 별칭만 저장하고
// 실제 모델 ID는 쿼리 시점에 resolveAiModelId로 변환한다.
export type AiModelChoice = 'opus' | 'sonnet' | 'haiku'

export const AI_MODEL_CHOICES: AiModelChoice[] = ['opus', 'sonnet', 'haiku']

// 데이터 조회 용도이므로 응답이 빠른 sonnet을 기본으로 사용.
export const DEFAULT_AI_MODEL: AiModelChoice = 'sonnet'

const AI_MODEL_SETTING_KEY = 'ai_model'

const AI_MODEL_IDS: Record<AiModelChoice, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5'
}

export function isAiModelChoice(value: unknown): value is AiModelChoice {
  return typeof value === 'string' && (AI_MODEL_CHOICES as string[]).includes(value)
}

// 허용값이 아니면(행 없음·구버전·손상된 값 등) 기본값으로 폴백
export function normalizeAiModel(value: unknown): AiModelChoice {
  return isAiModelChoice(value) ? value : DEFAULT_AI_MODEL
}

export function resolveAiModelId(choice: AiModelChoice): string {
  return AI_MODEL_IDS[choice]
}

export function getAiModel(): AiModelChoice {
  const row = getDatabase()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(AI_MODEL_SETTING_KEY) as { value: string } | undefined
  return normalizeAiModel(row?.value)
}

export function setAiModel(choice: AiModelChoice): void {
  getDatabase()
    .prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    )
    .run(AI_MODEL_SETTING_KEY, choice)
}
