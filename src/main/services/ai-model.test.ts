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
  AI_CHAT_MODEL_CHOICES,
  AI_MODEL_FAMILIES,
  DEFAULT_AI_CHAT_MODEL,
  buildAiChatModelOptions,
  extractAiModelLabels,
  getAiChatModel,
  getAiModelLabelCache,
  hasAiModelLabels,
  isAiChatModelChoice,
  normalizeAiChatModel,
  parseAiModelLabelCache,
  resetAiModelLabelCacheForTest,
  resolveAiChatModel,
  resolveAiModelId,
  setAiChatModel,
  updateAiModelLabels
} from './ai-model'

// 리더가 Claude Code 2.1.318 에서 실측한 supportedModels() 결과 형태
const SUPPORTED_MODELS = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Use the default model' },
  { value: 'fable', displayName: 'Fable 5.1', description: 'For your toughest challenges' },
  { value: 'opus', displayName: 'Opus 5.5', description: 'Most capable for complex work' },
  { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'Best for everyday tasks' },
  { value: 'haiku', displayName: 'Haiku 5.5', description: 'Fastest for quick answers' },
  { value: 'claude-opus-5-5', displayName: 'Opus 5.5 (pinned)', description: 'pinned' }
]

describe('AI 대화 선택지', () => {
  it('선택지는 fable·opus·haiku 이고 기본값은 opus', () => {
    expect(AI_CHAT_MODEL_CHOICES).toEqual(['fable', 'opus', 'haiku'])
    expect(DEFAULT_AI_CHAT_MODEL).toBe('opus')
  })

  it('모든 선택지가 패밀리 레지스트리에 있다', () => {
    const ids = AI_MODEL_FAMILIES.map((f) => f.id)
    for (const choice of AI_CHAT_MODEL_CHOICES) expect(ids).toContain(choice)
  })

  it('허용된 별칭만 true', () => {
    for (const choice of AI_CHAT_MODEL_CHOICES) expect(isAiChatModelChoice(choice)).toBe(true)
    for (const value of [undefined, null, '', 'sonnet', 'gpt', 'Opus', ' fable', 1, {}, ['haiku']]) {
      expect(isAiChatModelChoice(value)).toBe(false)
    }
  })
})

describe('normalizeAiChatModel', () => {
  it('허용값은 그대로 반환', () => {
    expect(normalizeAiChatModel('fable')).toBe('fable')
    expect(normalizeAiChatModel('opus')).toBe('opus')
    expect(normalizeAiChatModel('haiku')).toBe('haiku')
  })

  it("이전 선택지 'sonnet' 은 opus 로 정규화", () => {
    expect(normalizeAiChatModel('sonnet')).toBe('opus')
  })

  it('구버전·손상 값은 opus 로 폴백', () => {
    for (const value of [undefined, null, '', 'gpt', 'claude-opus-5-5', 42, true]) {
      expect(normalizeAiChatModel(value)).toBe('opus')
    }
  })
})

describe('resolveAiChatModel', () => {
  it('별칭을 고정 ID 로 바꾸지 않고 그대로 넘긴다', () => {
    expect(resolveAiChatModel('fable')).toBe('fable')
    expect(resolveAiChatModel('opus')).toBe('opus')
    expect(resolveAiChatModel('haiku')).toBe('haiku')
  })
})

describe('resolveAiModelId (개인 비서용, 기존 매핑 유지)', () => {
  it('별칭을 SDK 고정 모델 ID로 변환 (날짜 접미사 없음)', () => {
    expect(resolveAiModelId('opus')).toBe('claude-opus-5-5')
    expect(resolveAiModelId('sonnet')).toBe('claude-sonnet-5-5')
    expect(resolveAiModelId('haiku')).toBe('claude-haiku-4-5')
  })
})

describe('getAiChatModel / setAiChatModel', () => {
  beforeEach(() => settings.clear())

  it('저장된 값이 없으면 opus', () => {
    expect(getAiChatModel()).toBe('opus')
  })

  it('저장한 값을 다시 읽는다 (키 ai_model 유지)', () => {
    setAiChatModel('fable')
    expect(settings.get('ai_model')).toBe('fable')
    expect(getAiChatModel()).toBe('fable')
  })

  it("저장된 'sonnet' 은 opus 로 읽는다", () => {
    settings.set('ai_model', 'sonnet')
    expect(getAiChatModel()).toBe('opus')
  })

  it('잘못 저장된 값은 opus 로 읽는다', () => {
    settings.set('ai_model', 'gpt')
    expect(getAiChatModel()).toBe('opus')
  })
})

describe('extractAiModelLabels', () => {
  it('패밀리 별칭 항목만 골라 라벨을 만든다', () => {
    const cache = extractAiModelLabels(SUPPORTED_MODELS)
    expect(Object.keys(cache).sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet'])
    expect(cache.fable).toEqual({
      displayName: 'Fable 5.1',
      description: 'For your toughest challenges'
    })
  })

  it('형식이 틀린 입력과 항목은 버린다', () => {
    expect(extractAiModelLabels(null)).toEqual({})
    expect(extractAiModelLabels('fable')).toEqual({})
    expect(
      extractAiModelLabels([
        null,
        'fable',
        { value: 'fable' },
        { value: 'opus', displayName: '   ' },
        { value: 'haiku', displayName: 'Haiku 5.5', description: 7 }
      ])
    ).toEqual({ haiku: { displayName: 'Haiku 5.5', description: '' } })
  })
})

describe('parseAiModelLabelCache', () => {
  it('저장된 JSON 을 검증해 읽는다', () => {
    const raw = JSON.stringify({
      fable: { displayName: 'Fable 5.1', description: 'd' },
      gpt: { displayName: 'GPT', description: 'x' }
    })
    expect(parseAiModelLabelCache(raw)).toEqual({ fable: { displayName: 'Fable 5.1', description: 'd' } })
  })

  it('손상된 값은 빈 캐시', () => {
    for (const raw of [undefined, '', '{', '[]', 'null', '"x"', 42]) {
      expect(parseAiModelLabelCache(raw)).toEqual({})
    }
  })
})

describe('buildAiChatModelOptions', () => {
  it('캐시 라벨이 있으면 SDK 표시 이름을 쓰고, 설명은 한국어 hint 로 고정한다', () => {
    const options = buildAiChatModelOptions(extractAiModelLabels(SUPPORTED_MODELS))
    expect(options).toEqual([
      { value: 'fable', label: 'Fable 5.1', description: '가장 강력, 느림' },
      { value: 'opus', label: 'Opus 5.5', description: '정확, 균형' },
      { value: 'haiku', label: 'Haiku 5.5', description: '가장 빠름' }
    ])
  })

  it('캐시가 비면 패밀리 name 과 hint 로 폴백한다', () => {
    const options = buildAiChatModelOptions({})
    expect(options.map((o) => o.value)).toEqual(['fable', 'opus', 'haiku'])
    expect(options[0]).toEqual({ value: 'fable', label: 'Fable', description: '가장 강력, 느림' })
    expect(options[1]).toEqual({ value: 'opus', label: 'Opus', description: '정확, 균형' })
    expect(options[2]).toEqual({ value: 'haiku', label: 'Haiku', description: '가장 빠름' })
  })

  it('일부만 캐시되면 항목별로 폴백한다', () => {
    const options = buildAiChatModelOptions({ opus: { displayName: 'Opus 6', description: 'English' } })
    expect(options[0].label).toBe('Fable')
    expect(options[1]).toEqual({ value: 'opus', label: 'Opus 6', description: '정확, 균형' })
  })
})

describe('라벨 캐시 저장', () => {
  beforeEach(() => {
    settings.clear()
    resetAiModelLabelCacheForTest()
  })

  it('갱신하면 app_settings ai_model_labels 에 저장하고 재시작 뒤에도 읽는다', () => {
    expect(hasAiModelLabels()).toBe(false)
    expect(updateAiModelLabels(SUPPORTED_MODELS)).toBe(true)
    expect(JSON.parse(settings.get('ai_model_labels') ?? '{}').fable.displayName).toBe('Fable 5.1')

    resetAiModelLabelCacheForTest()
    expect(hasAiModelLabels()).toBe(true)
    expect(getAiModelLabelCache().opus?.displayName).toBe('Opus 5.5')
  })

  it('패밀리 항목이 없는 결과는 기존 캐시를 지우지 않는다', () => {
    updateAiModelLabels(SUPPORTED_MODELS)
    expect(updateAiModelLabels([])).toBe(false)
    expect(updateAiModelLabels([{ value: 'claude-x', displayName: 'X', description: '' }])).toBe(false)
    expect(getAiModelLabelCache().fable?.displayName).toBe('Fable 5.1')
  })
})
