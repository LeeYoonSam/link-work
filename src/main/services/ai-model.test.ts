import { beforeEach, describe, expect, it, vi } from 'vitest'

// Electron 런타임 없이 돌아야 하므로 DB를 모듈 경계에서 app_settings 흉내 Map으로 대체한다.
const settings = new Map<string, string>()

vi.mock('../db/database', () => ({
  getDatabase: () => ({
    prepare: () => ({
      get: (key: string) => {
        const value = settings.get(key)
        return value === undefined ? undefined : { value }
      },
      run: (...args: string[]) => {
        settings.set(args[0], args[1])
        return { changes: 1 }
      }
    })
  })
}))

import {
  AI_MODEL_CHOICES,
  DEFAULT_AI_MODEL,
  getAiModel,
  isAiModelChoice,
  normalizeAiModel,
  resolveAiModelId,
  setAiModel
} from './ai-model'

describe('isAiModelChoice', () => {
  it('허용된 별칭만 true', () => {
    for (const choice of AI_MODEL_CHOICES) expect(isAiModelChoice(choice)).toBe(true)
    for (const value of [undefined, null, '', 'gpt', 'Opus', ' sonnet', 1, {}, ['haiku']]) {
      expect(isAiModelChoice(value)).toBe(false)
    }
  })
})

describe('normalizeAiModel', () => {
  it('허용값은 그대로 반환', () => {
    expect(normalizeAiModel('opus')).toBe('opus')
    expect(normalizeAiModel('sonnet')).toBe('sonnet')
    expect(normalizeAiModel('haiku')).toBe('haiku')
  })

  it('허용값이 아니면 기본값(sonnet)으로 폴백', () => {
    expect(DEFAULT_AI_MODEL).toBe('sonnet')
    for (const value of [undefined, null, '', 'gpt', 'claude-opus-5-5', 42, true]) {
      expect(normalizeAiModel(value)).toBe(DEFAULT_AI_MODEL)
    }
  })
})

describe('resolveAiModelId', () => {
  it('별칭을 SDK 모델 ID로 변환 (날짜 접미사 없음)', () => {
    expect(resolveAiModelId('opus')).toBe('claude-opus-5-5')
    expect(resolveAiModelId('sonnet')).toBe('claude-sonnet-5-5')
    expect(resolveAiModelId('haiku')).toBe('claude-haiku-4-5')
  })
})

describe('getAiModel / setAiModel', () => {
  beforeEach(() => settings.clear())

  it('저장된 값이 없으면 기본값', () => {
    expect(getAiModel()).toBe(DEFAULT_AI_MODEL)
  })

  it('저장한 값을 다시 읽는다', () => {
    setAiModel('haiku')
    expect(settings.get('ai_model')).toBe('haiku')
    expect(getAiModel()).toBe('haiku')
  })

  it('잘못 저장된 값은 기본값으로 읽는다', () => {
    settings.set('ai_model', 'gpt')
    expect(getAiModel()).toBe(DEFAULT_AI_MODEL)
  })
})
