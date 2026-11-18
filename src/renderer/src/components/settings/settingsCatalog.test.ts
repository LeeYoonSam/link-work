import { describe, it, expect } from 'vitest'
import {
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_IDS,
  normalizeSettingsSection
} from './settingsCatalog'

describe('settingsCatalog', () => {
  it('섹션은 integrations·ai·assistant·recording·data 순서다', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
      'integrations',
      'ai',
      'assistant',
      'recording',
      'data'
    ])
    expect([...SETTINGS_SECTION_IDS]).toEqual(SETTINGS_SECTIONS.map((s) => s.id))
  })

  it('모든 섹션에 제목과 한 줄 설명이 있다', () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(s.title.trim()).not.toBe('')
      expect(s.description.trim()).not.toBe('')
      expect(s.description).not.toContain('\n')
    }
  })

  it('normalizeSettingsSection 은 모르는 값을 integrations 로 바꾼다', () => {
    expect(normalizeSettingsSection('ai')).toBe('ai')
    expect(normalizeSettingsSection('data')).toBe('data')
    expect(normalizeSettingsSection('unknown')).toBe('integrations')
    expect(normalizeSettingsSection(undefined)).toBe('integrations')
    expect(normalizeSettingsSection(3)).toBe('integrations')
  })
})
