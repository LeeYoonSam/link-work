// 비서 설정 폼의 순수 헬퍼 (docs/ASSISTANT.md §3.2, 부록 E.5).
// 예전 오늘 화면의 비서 설정 모달에서 옮겨 왔다. React·window 를 쓰지 않는다.
import type { AssistantSettings } from '../../types'

// 설정 화면이 노출하는 비서 설정 키.
// 부록 O(오늘 대시보드 개편, 2026-11-19): 하루 계획 기능이 없어져 startNudge·refreshNotify·planSize·workEnd·
// completeOriginOnDone·refreshCalendarMin·refreshJiraMin·jiraScope 는 화면과 AssistantSettings 타입에서 뺐다.
// 저장은 폼 키 한 칸씩만 보낸다. main 은 모르는 키가 섞인 patch 를 거절한다.
export type FormSettingKey =
  | 'enabled'
  | 'dayRollover'
  | 'llmEnabled'
  | 'llmModel'
  | 'openAtLogin'
  | 'startView'
  | 'meetingBriefingEnabled'
  | 'meetingLeadMin'
  | 'morningSyncEnabled'
  | 'morningSyncTime'

export type FormSettings = Pick<AssistantSettings, FormSettingKey>

export const FORM_SETTING_KEYS: FormSettingKey[] = [
  'enabled',
  'dayRollover',
  'llmEnabled',
  'llmModel',
  'openAtLogin',
  'startView',
  'meetingBriefingEnabled',
  'meetingLeadMin',
  'morningSyncEnabled',
  'morningSyncTime'
]

// 첫 화면으로 고를 수 있는 값. 홈은 '오늘' 하나다 (메뉴 통합 D1·D5)
export const START_VIEW_OPTIONS: Array<{ value: AssistantSettings['startView']; label: string }> = [
  { value: 'today', label: '오늘' },
  { value: 'projects', label: '프로젝트' },
  { value: 'calendar', label: '캘린더' }
]

// 저장된 첫 화면 값을 폼 값으로 바꾼다. 이전 값 auto·dashboard 와 모르는 값은 'today' 다
export function formStartView(v: unknown): AssistantSettings['startView'] {
  const hit = START_VIEW_OPTIONS.find((o) => o.value === v)
  return hit ? hit.value : 'today'
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const isIntIn = (v: number, min: number, max: number): boolean =>
  Number.isInteger(v) && v >= min && v <= max

// 숫자 입력 칸의 값을 읽는다. 빈 칸은 0 이 아니라 NaN 이다. 이유: Number('') 는 0 이라 빈 칸이 0 으로 저장된다
export function parseNumberInput(raw: string): number {
  return raw.trim() === '' ? Number.NaN : Number(raw)
}

// 숫자 입력 칸에 넣을 값. NaN 은 빈 칸으로 보인다
export function numberInputValue(v: number): number | '' {
  return Number.isNaN(v) ? '' : v
}

// 숫자 설정 키와 빈 칸 오류 문구에 쓸 이름
const NUMBER_FIELDS: Array<[keyof FormSettings, string]> = [['meetingLeadMin', '회의 전 알림']]

// 폼 값 검증. 문제가 있으면 사용자용 문구를 돌려준다
export function validateSettings(s: FormSettings): string | null {
  for (const [key, label] of NUMBER_FIELDS) {
    const v = s[key]
    if (typeof v !== 'number' || Number.isNaN(v)) return `${label}을(를) 입력하세요`
  }
  if (!HHMM.test(s.dayRollover)) return '날짜 경계는 HH:mm 형식이어야 합니다'
  if (!HHMM.test(s.morningSyncTime)) return '아침 자동 동기화 시각은 HH:mm 형식이어야 합니다'
  // 회의 전 브리핑 시각 (부록 I.10.4)
  if (!isIntIn(s.meetingLeadMin, 1, 120)) return '회의 전 알림은 1~120분 사이여야 합니다'
  return null
}

// 저장된 설정을 폼 값으로 바꾼다. 이전 버전 main 이 주지 않은 키는 기본값을 쓴다
export function toFormSettings(settings: AssistantSettings): FormSettings {
  const init = {} as Record<string, unknown>
  for (const k of FORM_SETTING_KEYS) init[k] = settings[k]
  // 이전 값 auto·dashboard 와 빈 값은 '오늘' 로 보인다. DB 행은 저장할 때만 바뀐다 (D5)
  init.startView = formStartView(init.startView)
  // 회의 브리핑 기본값 (부록 I.11.4)
  init.meetingBriefingEnabled ??= true
  init.meetingLeadMin ??= 15
  // 아침 자동 동기화 기본값 켬·08:00 (D9)
  init.morningSyncEnabled ??= true
  init.morningSyncTime ??= '08:00'
  return init as FormSettings
}

// 설정을 읽기 전에 칸을 비활성으로 그릴 때 쓰는 자리 표시 값. 저장하지 않는다.
// main 의 DEFAULT_ASSISTANT_SETTINGS 와 같은 값이다.
export const PLACEHOLDER_SETTINGS: AssistantSettings = {
  enabled: true,
  dayRollover: '04:00',
  llmEnabled: true,
  llmModel: 'sonnet',
  openAtLogin: false,
  meetingLeadMin: 15,
  startView: 'today',
  meetingBriefingEnabled: true,
  morningSyncEnabled: true,
  morningSyncTime: '08:00'
}

// 즉시 저장할 키(토글·select)와 blur 때 검증 후 저장할 키(숫자·시각)
export const BLUR_SAVE_KEYS: FormSettingKey[] = ['dayRollover', 'morningSyncTime', 'meetingLeadMin']

// 한 칸만 바꾼 값을 저장된 값 위에서 검증한다. 다른 칸의 저장 전 값은 보지 않는다
export function validateField<K extends FormSettingKey>(
  saved: FormSettings,
  key: K,
  value: FormSettings[K]
): string | null {
  return validateSettings({ ...saved, [key]: value })
}
