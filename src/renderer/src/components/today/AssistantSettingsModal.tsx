import { useState } from 'react'
import type { AiModelChoice, AssistantSettings } from '../../types'
import { Card, XIcon, button } from '../ui'

// 모달이 노출하는 설정 키 (docs/ASSISTANT.md §3.2, 부록 E.5)
export type FormSettingKey =
  | 'enabled'
  | 'dayRollover'
  | 'startNudge'
  | 'workEnd'
  | 'planSize'
  | 'llmEnabled'
  | 'llmModel'
  | 'jiraScope'
  | 'openAtLogin'
  | 'startView'
  | 'refreshCalendarMin'
  | 'refreshJiraMin'
  | 'refreshNotify'
  | 'meetingBriefingEnabled'
  | 'meetingLeadMin'
  | 'morningSyncEnabled'
  | 'morningSyncTime'
  | 'completeOriginOnDone'

export type FormSettings = Pick<AssistantSettings, FormSettingKey>

export const FORM_SETTING_KEYS: FormSettingKey[] = [
  'enabled',
  'dayRollover',
  'startNudge',
  'workEnd',
  'planSize',
  'llmEnabled',
  'llmModel',
  'jiraScope',
  'openAtLogin',
  'startView',
  'refreshCalendarMin',
  'refreshJiraMin',
  'refreshNotify',
  'meetingBriefingEnabled',
  'meetingLeadMin',
  'morningSyncEnabled',
  'morningSyncTime',
  'completeOriginOnDone'
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

// 폼 값 검증. 문제가 있으면 사용자용 문구를 돌려준다
const isRefreshMin = (v: number): boolean => Number.isInteger(v) && v >= 1 && v <= 240
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
const NUMBER_FIELDS: Array<[keyof FormSettings, string]> = [
  ['planSize', '하루 계획 항목 수'],
  ['refreshCalendarMin', '캘린더 확인 주기'],
  ['refreshJiraMin', 'Jira 확인 주기'],
  ['meetingLeadMin', '회의 전 알림']
]

export function validateSettings(s: FormSettings): string | null {
  for (const [key, label] of NUMBER_FIELDS) {
    const v = s[key]
    if (typeof v !== 'number' || Number.isNaN(v)) return `${label}을(를) 입력하세요`
  }
  if (!HHMM.test(s.dayRollover)) return '날짜 경계는 HH:mm 형식이어야 합니다'
  if (!HHMM.test(s.workEnd)) return '근무 종료 시각은 HH:mm 형식이어야 합니다'
  if (!HHMM.test(s.morningSyncTime)) return '아침 자동 동기화 시각은 HH:mm 형식이어야 합니다'
  if (!Number.isInteger(s.planSize) || s.planSize < 1 || s.planSize > 20)
    return '계획 항목 수는 1~20 사이여야 합니다'
  if (!isRefreshMin(s.refreshCalendarMin)) return '캘린더 확인 주기는 1~240분 사이여야 합니다'
  if (!isRefreshMin(s.refreshJiraMin)) return 'Jira 확인 주기는 1~240분 사이여야 합니다'
  // 회의 전 브리핑 시각 (부록 I.10.4)
  if (!isIntIn(s.meetingLeadMin, 1, 120)) return '회의 전 알림은 1~120분 사이여야 합니다'
  return null
}

// 바뀐 키만 patch 로 만든다
export function diffSettings(base: AssistantSettings, next: FormSettings): Partial<AssistantSettings> {
  const patch: Partial<AssistantSettings> = {}
  for (const k of FORM_SETTING_KEYS) {
    if (base[k] !== next[k]) (patch as Record<string, unknown>)[k] = next[k]
  }
  return patch
}

const inputClass =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'

function Toggle({
  label,
  hint,
  checked,
  onChange
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.ReactNode {
  return (
    <label className="flex items-start gap-2 py-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="block text-sm text-gray-800">{label}</span>
        {hint ? <span className="block text-[11px] text-gray-500">{hint}</span> : null}
      </span>
    </label>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-700 mb-1">{label}</span>
      {children}
      {hint ? <span className="block mt-1 text-[11px] text-gray-500">{hint}</span> : null}
    </label>
  )
}

interface AssistantSettingsModalProps {
  settings: AssistantSettings
  busy: boolean
  onClose: () => void
  // 저장에 성공하면 true
  onSave: (patch: Partial<AssistantSettings>) => Promise<boolean>
}

export default function AssistantSettingsModal({
  settings,
  busy,
  onClose,
  onSave
}: AssistantSettingsModalProps): React.ReactNode {
  const [form, setForm] = useState<FormSettings>(() => {
    const init = {} as Record<string, unknown>
    for (const k of FORM_SETTING_KEYS) init[k] = settings[k]
    // 이전 값 auto·dashboard 와 빈 값은 '오늘' 로 보인다. DB 행은 저장할 때만 바뀐다 (D5)
    init.startView = formStartView(init.startView)
    // 이전 버전 main 이 회의 브리핑 키를 주지 않으면 기본값을 쓴다 (부록 I.11.4)
    init.meetingBriefingEnabled ??= true
    init.meetingLeadMin ??= 15
    // 이전 버전 main 이 아침 자동 동기화 키를 주지 않으면 기본값 켬·08:00 을 쓴다 (D9)
    init.morningSyncEnabled ??= true
    init.morningSyncTime ??= '08:00'
    // 원본 자동 완료의 기본값은 끔이다 (D10)
    init.completeOriginOnDone ??= false
    return init as FormSettings
  })
  const [error, setError] = useState('')

  const set = <K extends FormSettingKey>(key: K, value: FormSettings[K]): void =>
    setForm((f) => ({ ...f, [key]: value }))

  const handleSave = async (): Promise<void> => {
    const problem = validateSettings(form)
    if (problem) {
      setError(problem)
      return
    }
    const patch = diffSettings(settings, form)
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    setError('')
    const ok = await onSave(patch)
    if (ok) onClose()
    else setError('설정을 저장하지 못했습니다')
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <Card padding="md" className="bg-white max-h-[85vh] overflow-auto">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-base font-semibold text-gray-900">비서 설정</h3>
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-700 transition-colors"
              title="닫기"
            >
              <XIcon size={16} />
            </button>
          </div>
          <p className="text-xs text-gray-500 mb-4">오늘 계획, 알림, 자동 최신화의 동작을 정합니다.</p>

          <div className="space-y-1 mb-4">
            <Toggle label="비서 사용" checked={form.enabled} onChange={(v) => set('enabled', v)} />
            <Toggle
              label="시작 알림"
              hint="그날 첫 활동 때 '하루 시작'을 권하는 알림을 1회 보냅니다."
              checked={form.startNudge}
              onChange={(v) => set('startNudge', v)}
            />
            <Toggle
              label="최신화 알림"
              hint="지금·다음 블록이 바뀌거나 긴급한 일이 들어오면 알립니다"
              checked={form.refreshNotify}
              onChange={(v) => set('refreshNotify', v)}
            />
            <Toggle
              label="회의 전 브리핑"
              hint="회의 시작 전에 관련 프로젝트·지난 회의·액션아이템을 알립니다"
              checked={form.meetingBriefingEnabled}
              onChange={(v) => set('meetingBriefingEnabled', v)}
            />
            <Toggle
              label="아침 자동 동기화"
              hint="매일 아침 1회 릴리스 노트와 Jira 프로젝트를 가져옵니다. 새 프로젝트 추가와 빈 칸 채우기만 자동으로 합니다"
              checked={form.morningSyncEnabled}
              onChange={(v) => set('morningSyncEnabled', v)}
            />
            <Toggle
              label="완료하면 원본도 완료"
              hint="오늘 할 일을 완료로 바꾸면 원본 TODO·작업도 완료로 바꿉니다. Jira 이슈는 바꾸지 않습니다"
              checked={form.completeOriginOnDone}
              onChange={(v) => set('completeOriginOnDone', v)}
            />
            <Toggle
              label="AI 브리핑"
              hint="끄면 규칙 기반 브리핑만 만듭니다."
              checked={form.llmEnabled}
              onChange={(v) => set('llmEnabled', v)}
            />
            <Toggle
              label="로그인 시 LinkWork 실행"
              checked={form.openAtLogin}
              onChange={(v) => set('openAtLogin', v)}
            />
          </div>

          <div className="mb-4">
            <Field label="첫 화면">
              <select
                value={form.startView}
                onChange={(e) => set('startView', formStartView(e.target.value))}
                className={inputClass}
              >
                {START_VIEW_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4">
            <Field label="날짜 경계">
              <input
                type="time"
                value={form.dayRollover}
                onChange={(e) => set('dayRollover', e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="근무 종료 시각">
              <input
                type="time"
                value={form.workEnd}
                onChange={(e) => set('workEnd', e.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="아침 동기화 시각" hint="기본 08:00. 이 시각 뒤 첫 확인 때 1회 실행합니다">
              <input
                type="time"
                value={form.morningSyncTime}
                disabled={!form.morningSyncEnabled}
                onChange={(e) => set('morningSyncTime', e.target.value)}
                className={`${inputClass} disabled:bg-gray-50 disabled:text-gray-400`}
              />
            </Field>
            <Field label="하루 계획 항목 수">
              <input
                type="number"
                min={1}
                max={20}
                value={numberInputValue(form.planSize)}
                onChange={(e) => set('planSize', parseNumberInput(e.target.value))}
                className={inputClass}
              />
            </Field>
            <Field label="AI 모델">
              <select
                value={form.llmModel}
                onChange={(e) => set('llmModel', e.target.value as AiModelChoice)}
                className={inputClass}
              >
                <option value="opus">Opus</option>
                <option value="sonnet">Sonnet</option>
                <option value="haiku">Haiku</option>
              </select>
            </Field>
            <Field label="Jira 범위">
              <select
                value={form.jiraScope}
                onChange={(e) => set('jiraScope', e.target.value as FormSettings['jiraScope'])}
                className={inputClass}
              >
                <option value="all">전체 프로젝트</option>
                <option value="default_project">기본 프로젝트만</option>
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4">
            <Field label="캘린더 확인 주기 (분)" hint="1~240분. 권장 5분">
              <input
                type="number"
                min={1}
                max={240}
                value={numberInputValue(form.refreshCalendarMin)}
                onChange={(e) => set('refreshCalendarMin', parseNumberInput(e.target.value))}
                className={inputClass}
              />
            </Field>
            <Field label="Jira 확인 주기 (분)" hint="1~240분. 기본 15분">
              <input
                type="number"
                min={1}
                max={240}
                value={numberInputValue(form.refreshJiraMin)}
                onChange={(e) => set('refreshJiraMin', parseNumberInput(e.target.value))}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4">
            <Field label="회의 전 알림(분)" hint="권장 15분. 기존 10분 전 일정 알림보다 앞서게 두세요">
              <input
                type="number"
                min={1}
                max={120}
                value={numberInputValue(form.meetingLeadMin)}
                onChange={(e) => set('meetingLeadMin', parseNumberInput(e.target.value))}
                className={inputClass}
              />
            </Field>
          </div>

          {error ? <p className="text-xs text-red-600 mb-3">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className={`px-4 py-2 text-sm ${button.subtle}`}>
              취소
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={busy}
              className={`px-4 py-2 text-sm ${button.primary} disabled:opacity-50`}
            >
              저장
            </button>
          </div>
        </Card>
      </div>
    </div>
  )
}
