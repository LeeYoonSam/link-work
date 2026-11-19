import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AiModelChoice, AssistantSettings } from '../../../types'
import { useAssistantStore } from '../../../stores/assistantStore'
import {
  BLUR_SAVE_KEYS,
  PLACEHOLDER_SETTINGS,
  START_VIEW_OPTIONS,
  formStartView,
  numberInputValue,
  parseNumberInput,
  toFormSettings,
  validateField,
  type FormSettingKey,
  type FormSettings
} from '../assistantSettingsForm'

// 설정 > 비서 (그리고 AI 섹션의 비서 요약 2칸).
// 즉시 저장한다: 토글·select 는 바꾸는 즉시, 숫자·시각은 칸을 벗어날 때 검증한 뒤 저장한다.
// 저장에 성공한 칸 옆에 "저장됨" 이 잠깐 뜬다.

const inputClass =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400'

const SAVED_FLASH_MS = 1500

/** null 이면 성공, 문자열이면 사용자에게 보일 오류 문구 */
export type SaveAssistantPatch = (patch: Partial<AssistantSettings>) => Promise<string | null>

/** 비서 설정을 읽고 부분 patch 로 저장한다. 저장하면 오늘 화면이 들고 있는 설정도 맞춘다 */
export function useAssistantSettings(): {
  settings: AssistantSettings | null
  loadError: string
  save: SaveAssistantPatch
} {
  const [settings, setSettings] = useState<AssistantSettings | null>(null)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let alive = true
    window.api.assistant
      .getSettings()
      .then((s) => {
        if (alive) setSettings(s)
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : '비서 설정을 읽지 못했습니다')
      })
    return () => {
      alive = false
    }
  }, [])

  const save: SaveAssistantPatch = async (patch) => {
    try {
      const res = await window.api.assistant.saveSettings(patch)
      if (!res.success) return res.error || '설정을 저장하지 못했습니다'
      setSettings(res.settings)
      useAssistantStore.setState((s) =>
        s.today ? { today: { ...s.today, settings: res.settings } } : {}
      )
      return null
    } catch (e) {
      return e instanceof Error ? e.message : '설정을 저장하지 못했습니다'
    }
  }

  return { settings, loadError, save }
}

function SavedMark({ show }: { show: boolean }): React.ReactNode {
  return show ? <span className="ml-2 text-[11px] font-normal text-green-600">저장됨</span> : null
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  saved,
  onChange
}: {
  label: string
  hint?: string
  checked: boolean
  disabled: boolean
  saved: boolean
  onChange: (v: boolean) => void
}): React.ReactNode {
  return (
    <label className="flex items-start gap-2 py-1.5">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="block text-sm text-gray-800">
          {label}
          <SavedMark show={saved} />
        </span>
        {hint ? <span className="block text-[11px] text-gray-500">{hint}</span> : null}
      </span>
    </label>
  )
}

function Field({
  label,
  hint,
  saved,
  children
}: {
  label: string
  hint?: string
  saved: boolean
  children: ReactNode
}): React.ReactNode {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-700 mb-1">
        {label}
        <SavedMark show={saved} />
      </span>
      {children}
      {hint ? <span className="block mt-1 text-[11px] text-gray-500">{hint}</span> : null}
    </label>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }): React.ReactNode {
  return (
    <section className="border border-gray-200 rounded-lg p-4">
      <h4 className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">{title}</h4>
      {children}
    </section>
  )
}

export type AssistantFieldsGroup = 'assistant' | 'ai'

/**
 * 비서 설정 칸. group='assistant' 는 동작·시간·알림 3그룹, group='ai' 는 AI 브리핑과 비서 요약 모델.
 * 부록 O(오늘 대시보드 개편): 하루 계획용 칸(시작 알림·최신화 알림·계획 항목 수·근무 종료·원본 완료·
 * 확인 주기 2개·Jira 범위)은 뺐다. 저장 키는 남아 있다.
 * settings 가 null 이면 자리 표시 값으로 비활성 상태를 그린다.
 */
export function AssistantSettingsFields({
  settings,
  onSave,
  group = 'assistant'
}: {
  settings: AssistantSettings | null
  onSave: SaveAssistantPatch
  group?: AssistantFieldsGroup
}): React.ReactNode {
  const disabled = settings === null
  // 저장된 값(확인을 받은 값). 검증과 비교에만 쓰므로 렌더와 무관하게 ref 로 든다
  const saved = useRef<FormSettings>(toFormSettings(settings ?? PLACEHOLDER_SETTINGS))
  // 칸별로 아직 응답을 기다리는 저장 요청 번호. 같은 칸을 연달아 바꾸면 마지막 요청만 화면을 정한다
  const pending = useRef<Partial<Record<FormSettingKey, number>>>({})
  const requestSeq = useRef(0)
  const [form, setForm] = useState<FormSettings>(saved.current)
  const [error, setError] = useState('')
  const [flash, setFlash] = useState<FormSettingKey | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loaded = useRef(false)

  // 설정을 늦게 받으면(첫 렌더가 자리 표시 값) 받은 값으로 한 번 맞춘다.
  // 이후 저장 응답으로는 다시 맞추지 않는다. 입력 중인 숫자 칸의 값이 지워지고, 늦게 온 응답이 다른 칸을 되돌리기 때문이다
  useEffect(() => {
    if (!settings || loaded.current) return
    loaded.current = true
    const next = toFormSettings(settings)
    saved.current = next
    setForm(next)
  }, [settings])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const commit = async <K extends FormSettingKey>(key: K, value: FormSettings[K]): Promise<void> => {
    if (disabled) return
    if (pending.current[key] === undefined && saved.current[key] === value) return
    const problem = validateField(saved.current, key, value)
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    const id = ++requestSeq.current
    pending.current[key] = id
    const failure = await onSave({ [key]: value } as Partial<AssistantSettings>)
    // 성공한 값은 항상 확인된 값으로 기록한다. 뒤에 온 요청이 실패해도 서버에는 이 값이 남아 있다
    if (failure === null) {
      saved.current = { ...saved.current, [key]: value }
      setFlash(key)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setFlash(null), SAVED_FLASH_MS)
    }
    // 더 새 변경이 이 칸을 맡고 있으면 화면은 그 요청이 정한다
    if (pending.current[key] !== id) return
    delete pending.current[key]
    if (failure !== null) {
      // 저장하지 못한 값은 화면에서 되돌려 실제 값과 맞춘다
      const confirmed = saved.current[key]
      setForm((f) => ({ ...f, [key]: confirmed }))
      setError(failure)
    }
  }

  // 토글·select: 바꾸는 즉시 저장
  const setNow = <K extends FormSettingKey>(key: K, value: FormSettings[K]): void => {
    setForm((f) => ({ ...f, [key]: value }))
    void commit(key, value)
  }
  // 숫자·시각: 입력만 바꾸고 blur 때 저장
  const setDraft = <K extends FormSettingKey>(key: K, value: FormSettings[K]): void =>
    setForm((f) => ({ ...f, [key]: value }))
  const blur = (key: FormSettingKey): void => {
    if (BLUR_SAVE_KEYS.includes(key)) void commit(key, form[key])
  }

  const toggle = (key: FormSettingKey, label: string, hint?: string): ReactNode => (
    <ToggleRow
      label={label}
      hint={hint}
      checked={form[key] as boolean}
      disabled={disabled}
      saved={flash === key}
      onChange={(v) => setNow(key, v as FormSettings[typeof key])}
    />
  )

  const timeInput = (key: 'dayRollover' | 'morningSyncTime', extraDisabled = false): ReactNode => (
    <input
      type="time"
      value={form[key]}
      disabled={disabled || extraDisabled}
      onChange={(e) => setDraft(key, e.target.value)}
      onBlur={() => blur(key)}
      className={inputClass}
    />
  )

  const numberInput = (key: 'meetingLeadMin', min: number, max: number): ReactNode => (
    <input
      type="number"
      min={min}
      max={max}
      value={numberInputValue(form[key])}
      disabled={disabled}
      onChange={(e) => setDraft(key, parseNumberInput(e.target.value))}
      onBlur={() => blur(key)}
      className={inputClass}
    />
  )

  const errorLine = error ? (
    <p className="text-xs text-red-600" role="alert">
      {error}
    </p>
  ) : null

  if (group === 'ai') {
    return (
      <div className="space-y-2">
        {toggle('llmEnabled', 'AI 브리핑', '끄면 규칙 기반 브리핑만 만듭니다.')}
        <Field label="비서 요약 모델" hint="오늘 화면의 브리핑과 회의 전 브리핑을 만드는 모델입니다" saved={flash === 'llmModel'}>
          <select
            value={form.llmModel}
            disabled={disabled || !form.llmEnabled}
            onChange={(e) => setNow('llmModel', e.target.value as AiModelChoice)}
            className={inputClass}
          >
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
          </select>
        </Field>
        {errorLine}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {errorLine}
      <Group title="동작">
        <div className="space-y-1 mb-3">
          {toggle('enabled', '비서 사용')}
          {toggle('openAtLogin', '로그인 시 LinkWork 실행')}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="첫 화면" saved={flash === 'startView'}>
            <select
              value={form.startView}
              disabled={disabled}
              onChange={(e) => setNow('startView', formStartView(e.target.value))}
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
      </Group>

      <Group title="시간">
        <div className="grid grid-cols-2 gap-3 mb-2">
          <Field label="날짜 경계" hint="이 시각 전까지는 전날로 봅니다" saved={flash === 'dayRollover'}>
            {timeInput('dayRollover')}
          </Field>
        </div>
        {toggle(
          'morningSyncEnabled',
          '아침 자동 동기화',
          '매일 아침 1회 Jira 릴리스 노트를 가져옵니다'
        )}
        <div className="grid grid-cols-2 gap-3 mt-1">
          <Field
            label="아침 동기화 시각"
            hint="기본 08:00. 이 시각 뒤 첫 확인 때 1회 실행합니다"
            saved={flash === 'morningSyncTime'}
          >
            {timeInput('morningSyncTime', !form.morningSyncEnabled)}
          </Field>
        </div>
      </Group>

      <Group title="알림">
        <div className="space-y-1 mb-3">
          {toggle(
            'meetingBriefingEnabled',
            '회의 전 브리핑',
            '회의 시작 전에 지난 회의·액션아이템을 알립니다'
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="회의 전 알림(분)"
            hint="권장 15분. 기존 10분 전 일정 알림보다 앞서게 두세요"
            saved={flash === 'meetingLeadMin'}
          >
            {numberInput('meetingLeadMin', 1, 120)}
          </Field>
        </div>
      </Group>
    </div>
  )
}

export default function AssistantSection(): React.ReactNode {
  const { settings, loadError, save } = useAssistantSettings()
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">바꾸는 즉시 저장됩니다. 숫자와 시각은 칸을 벗어날 때 확인한 뒤 저장합니다.</p>
      {loadError ? <p className="text-xs text-red-600">{loadError}</p> : null}
      <AssistantSettingsFields settings={settings} onSave={save} group="assistant" />
    </div>
  )
}
