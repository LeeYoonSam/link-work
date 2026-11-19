// 설정 화면의 섹션 목록 — 왼쪽 목록의 순서·제목·한 줄 설명의 단일 출처다.
// 순수 모듈이다. React·스토어·window 를 쓰지 않는다.

export const SETTINGS_SECTION_IDS = ['integrations', 'ai', 'assistant', 'recording', 'mobile', 'data'] as const

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

export interface SettingsSectionMeta {
  id: SettingsSectionId
  title: string
  description: string
}

export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  { id: 'integrations', title: '연동', description: '캘린더, Jira, Bitbucket, Notion을 연결합니다' },
  { id: 'ai', title: 'AI', description: 'Claude Code 상태와 AI 모델' },
  { id: 'assistant', title: '비서', description: '하루 경계, 알림, 자동 동기화' },
  { id: 'recording', title: '회의 녹음', description: '전사 정확도를 높이는 용어집과 구성원' },
  { id: 'mobile', title: '모바일', description: '같은 Wi-Fi 의 휴대폰에서 오늘·할 일·메모를 봅니다' },
  { id: 'data', title: '데이터', description: '백업과 복원(새 PC 이전)' }
]

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'integrations'

/** 모르는 값(AI 링크, 오래된 저장값 등)은 연동 섹션으로 바꾼다 */
export function normalizeSettingsSection(value: unknown): SettingsSectionId {
  return typeof value === 'string' && (SETTINGS_SECTION_IDS as readonly string[]).includes(value)
    ? (value as SettingsSectionId)
    : DEFAULT_SETTINGS_SECTION
}

export function getSettingsSection(id: SettingsSectionId): SettingsSectionMeta {
  return SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0]
}
