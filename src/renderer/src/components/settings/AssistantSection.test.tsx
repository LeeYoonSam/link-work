import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AssistantSettings } from '../../types'
import { AssistantSettingsFields } from './sections/AssistantSection'
import { PLACEHOLDER_SETTINGS } from './assistantSettingsForm'

// 오늘 화면의 비서 설정 모달이 고정하던 문구·기본값을 설정 > 비서 칸으로 옮겨 고정한다.

const SETTINGS: AssistantSettings = { ...PLACEHOLDER_SETTINGS }
const save = async (): Promise<string | null> => null
const render = (s: AssistantSettings | null, group: 'assistant' | 'ai' = 'assistant'): string =>
  renderToStaticMarkup(<AssistantSettingsFields settings={s} onSave={save} group={group} />)

describe('AssistantSettingsFields', () => {
  it('부록 O: 하루 계획용 칸 8개(시작 알림·최신화 알림·계획 항목 수·근무 종료·원본 완료·확인 주기 2개·Jira 범위)가 없다', () => {
    const html = render(SETTINGS)
    for (const label of [
      '시작 알림',
      '최신화 알림',
      '하루 계획 항목 수',
      '근무 종료 시각',
      '완료하면 원본도 완료',
      '캘린더 확인 주기',
      'Jira 확인 주기',
      'Jira 범위'
    ]) {
      expect(html).not.toContain(label)
    }
    expect(html).not.toContain('하루 시작')
    expect(html).not.toContain('전체 프로젝트')
  })

  it('회의 브리핑 설정 2개와 노출 키를 보여 준다', () => {
    const html = render(SETTINGS)
    expect(html).toContain('회의 전 브리핑')
    expect(html).toContain('회의 시작 전에 지난 회의·액션아이템을 알립니다')
    expect(html).toContain('회의 전 알림(분)')
    expect(html).toContain('권장 15분. 기존 10분 전 일정 알림보다 앞서게 두세요')
    expect(html).toContain('날짜 경계')
    expect(html).toContain('value="15"')
    expect(html).not.toContain('소요 분')
  })

  it('첫 화면 옵션은 오늘·프로젝트·캘린더이고 이전 값 dashboard 는 오늘로 보인다', () => {
    const html = render({ ...SETTINGS, startView: 'dashboard' as AssistantSettings['startView'] })
    expect(html).toContain('<option value="today" selected="">오늘</option>')
    expect(html).toContain('<option value="projects">프로젝트</option>')
    expect(html).toContain('<option value="calendar">캘린더</option>')
    expect(html).not.toContain('대시보드')
  })

  it('아침 자동 동기화 토글·시각을 보여 주고, 새 키가 없으면 켬·08:00 이다', () => {
    const legacy = { ...SETTINGS } as Partial<AssistantSettings>
    delete legacy.morningSyncEnabled
    delete legacy.morningSyncTime
    const html = render(legacy as AssistantSettings)
    expect(html).toContain('아침 자동 동기화')
    expect(html).toContain('아침 동기화 시각')
    expect(html).toContain('value="08:00"')
    expect(html).toMatch(/<input type="checkbox" class="mt-0.5" checked=""\/><span><span class="block text-sm text-gray-800">아침 자동 동기화/)
  })

  it('설정을 읽기 전에는 칸을 비활성으로 그린다', () => {
    expect(render(null)).toContain('disabled=""')
  })

  it('AI 그룹은 AI 브리핑과 비서 요약 모델만 그린다', () => {
    const html = render(SETTINGS, 'ai')
    expect(html).toContain('AI 브리핑')
    expect(html).toContain('비서 요약 모델')
    expect(html).not.toContain('날짜 경계')
  })
})

describe('assistantSettingsForm (부록 O)', () => {
  it('폼 키에 하루 계획용 키가 없다. 옛 키를 담은 설정도 검증을 통과한다', async () => {
    const { FORM_SETTING_KEYS, validateSettings, toFormSettings } = await import('./assistantSettingsForm')
    for (const k of ['startNudge', 'refreshNotify', 'planSize', 'workEnd', 'completeOriginOnDone', 'refreshCalendarMin', 'refreshJiraMin', 'jiraScope']) {
      expect(FORM_SETTING_KEYS as string[]).not.toContain(k)
    }
    const form = toFormSettings({ ...SETTINGS, planSize: 0, workEnd: 'x' } as AssistantSettings)
    expect('planSize' in form).toBe(false)
    expect(validateSettings(form)).toBeNull()
  })
})

// 옛 TodayView.test.tsx 에 있던 설정 폼 순수 헬퍼 검증을 옮겨 왔다 (남은 키만)
describe('assistantSettingsForm 순수 헬퍼', () => {
  it('formStartView: 오늘·프로젝트·캘린더만 받고, 이전 값 auto·dashboard 와 모르는 값은 today 다', async () => {
    const { formStartView, START_VIEW_OPTIONS } = await import('./assistantSettingsForm')
    expect(START_VIEW_OPTIONS.map((o) => o.value)).toEqual(['today', 'projects', 'calendar'])
    expect(formStartView('projects')).toBe('projects')
    expect(formStartView('calendar')).toBe('calendar')
    expect(formStartView('dashboard')).toBe('today')
    expect(formStartView('auto')).toBe('today')
    expect(formStartView(undefined)).toBe('today')
  })

  it('validateSettings: 날짜 경계·아침 동기화 시각은 HH:mm, 회의 전 알림은 1~120 정수다', async () => {
    const { validateSettings, toFormSettings } = await import('./assistantSettingsForm')
    const form = toFormSettings(SETTINGS)
    expect(validateSettings(form)).toBeNull()
    expect(validateSettings({ ...form, dayRollover: '24:00' })).not.toBeNull()
    expect(validateSettings({ ...form, morningSyncTime: '25:00' })).not.toBeNull()
    expect(validateSettings({ ...form, morningSyncTime: '7:30' })).not.toBeNull()
    expect(validateSettings({ ...form, morningSyncTime: '07:30' })).toBeNull()
    expect(validateSettings({ ...form, meetingLeadMin: 0 })).not.toBeNull()
    expect(validateSettings({ ...form, meetingLeadMin: 121 })).not.toBeNull()
    expect(validateSettings({ ...form, meetingLeadMin: 10.5 })).not.toBeNull()
    expect(validateSettings({ ...form, meetingLeadMin: 1 })).toBeNull()
    expect(validateSettings({ ...form, meetingLeadMin: 120 })).toBeNull()
  })

  it('빈 숫자 칸은 0 이 아니라 NaN 이고 "입력하세요" 오류다', async () => {
    const { validateSettings, toFormSettings, parseNumberInput, numberInputValue } = await import('./assistantSettingsForm')
    expect(Number.isNaN(parseNumberInput(''))).toBe(true)
    expect(parseNumberInput(' 20 ')).toBe(20)
    expect(numberInputValue(Number.NaN)).toBe('')
    expect(numberInputValue(15)).toBe(15)
    expect(validateSettings({ ...toFormSettings(SETTINGS), meetingLeadMin: parseNumberInput('') })).toMatch(/입력하세요/)
  })

  it('diffSettings: 바뀐 폼 키만 patch 로 만든다', async () => {
    const { diffSettings, toFormSettings } = await import('./assistantSettingsForm')
    const form = toFormSettings(SETTINGS)
    expect(diffSettings(SETTINGS, form)).toEqual({})
    expect(
      diffSettings(SETTINGS, { ...form, meetingBriefingEnabled: false, meetingLeadMin: 20, morningSyncTime: '07:30' })
    ).toEqual({ meetingBriefingEnabled: false, meetingLeadMin: 20, morningSyncTime: '07:30' })
  })
})
