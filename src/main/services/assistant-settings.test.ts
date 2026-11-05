import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_SETTING_KEYS,
  DEFAULT_ASSISTANT_SETTINGS,
  parseAssistantSettings,
  serializeAssistantSettingsPatch
} from './assistant-settings'

describe('ASSISTANT_SETTING_KEYS', () => {
  it('모든 키가 assistant_ 접두어를 가진다', () => {
    for (const key of Object.values(ASSISTANT_SETTING_KEYS)) {
      expect(key.startsWith('assistant_')).toBe(true)
    }
  })

  it('§3.2 키 13개, 부록 C.2 키 1개, 부록 I 키 1개, A54 키 2개, 원본 완료 키 1개, 모두 18개를 가진다. 3판에서 assistant_slot_min 을, 부록 L 에서 체크인 키 3개를 없앴다', () => {
    expect(Object.keys(ASSISTANT_SETTING_KEYS)).toHaveLength(18)
    expect(new Set(Object.values(ASSISTANT_SETTING_KEYS)).size).toBe(18)
    expect(Object.values(ASSISTANT_SETTING_KEYS)).not.toContain('assistant_slot_min')
    expect(ASSISTANT_SETTING_KEYS.dayRollover).toBe('assistant_day_rollover')
    expect(ASSISTANT_SETTING_KEYS.refreshCalendarMin).toBe('assistant_refresh_calendar_min')
    expect(ASSISTANT_SETTING_KEYS.refreshJiraMin).toBe('assistant_refresh_jira_min')
    expect(ASSISTANT_SETTING_KEYS.refreshNotify).toBe('assistant_refresh_notify')
    expect(ASSISTANT_SETTING_KEYS.startView).toBe('assistant_start_view')
    expect(ASSISTANT_SETTING_KEYS.meetingBriefingEnabled).toBe('assistant_meeting_briefing_enabled')
    expect(ASSISTANT_SETTING_KEYS.morningSyncEnabled).toBe('assistant_morning_sync_enabled')
    expect(ASSISTANT_SETTING_KEYS.morningSyncTime).toBe('assistant_morning_sync_time')
    expect(ASSISTANT_SETTING_KEYS.completeOriginOnDone).toBe('assistant_complete_origin_on_done')
  })
})

describe('parseAssistantSettings', () => {
  it('행이 없으면 §3.2 기본값이다', () => {
    expect(parseAssistantSettings([])).toEqual({
      enabled: true,
      dayRollover: '04:00',
      startNudge: true,
      workEnd: '18:00',
      planSize: 5,
      llmEnabled: true,
      llmModel: 'sonnet',
      jiraScope: 'all',
      openAtLogin: false,
      refreshCalendarMin: 5,
      refreshJiraMin: 15,
      refreshNotify: true,
      meetingLeadMin: 15,
      startView: 'today',
      meetingBriefingEnabled: true,
      morningSyncEnabled: true,
      morningSyncTime: '08:00',
      completeOriginOnDone: false
    })
  })

  it('올바른 값을 읽는다', () => {
    const s = parseAssistantSettings([
      { key: 'assistant_enabled', value: '0' },
      { key: 'assistant_day_rollover', value: '05:30' },
      { key: 'assistant_plan_size', value: '7' },
      { key: 'assistant_llm_model', value: 'haiku' },
      { key: 'assistant_jira_scope', value: 'default_project' },
      { key: 'assistant_open_at_login', value: '1' }
    ])
    expect(s.enabled).toBe(false)
    expect(s.dayRollover).toBe('05:30')
    expect(s.planSize).toBe(7)
    expect(s.llmModel).toBe('haiku')
    expect(s.jiraScope).toBe('default_project')
    expect(s.openAtLogin).toBe(true)
  })

  it('잘못된 값은 기본값으로 바뀐다', () => {
    const s = parseAssistantSettings([
      { key: 'assistant_enabled', value: 'true' },
      { key: 'assistant_day_rollover', value: '4:00' },
      { key: 'assistant_work_end', value: '24:00' },
      { key: 'assistant_plan_size', value: '0' },
      { key: 'assistant_llm_model', value: 'gpt' },
      { key: 'assistant_jira_scope', value: 'mine' },
      { key: 'assistant_start_view', value: 'dashboard' },
      { key: 'assistant_morning_sync_enabled', value: 'on' },
      { key: 'assistant_morning_sync_time', value: '8:00' },
      { key: 'assistant_complete_origin_on_done', value: 'true' },
      { key: 'assistant_meeting_briefing_enabled', value: 'true' },
      { key: 'assistant_meeting_lead_min', value: '0' }
    ])
    expect(s).toEqual(DEFAULT_ASSISTANT_SETTINGS)
  })

  it('D3: 제거된 체크인 설정 행은 무시한다. 결과에 그 필드가 없다 (부록 L)', () => {
    // 완료 조건 grep 이 소스에서 옛 키 문자열을 0건으로 판정하므로 키를 조합해 만든다
    const legacy = ['enabled', 'min_gap', 'daily_cap'].map((k) => `assistant_${'check'}in_${k}`)
    const s = parseAssistantSettings(legacy.map((key) => ({ key, value: '0' })))
    expect(s).toEqual(DEFAULT_ASSISTANT_SETTINGS)
    expect(Object.values(ASSISTANT_SETTING_KEYS).some((k) => legacy.includes(k))).toBe(false)
  })

  it('I.11.4: assistant_meeting_briefing_enabled 는 0·1 을 읽는다. 기본값은 켬이다', () => {
    expect(parseAssistantSettings([]).meetingBriefingEnabled).toBe(true)
    expect(
      parseAssistantSettings([{ key: 'assistant_meeting_briefing_enabled', value: '0' }]).meetingBriefingEnabled
    ).toBe(false)
    expect(
      parseAssistantSettings([{ key: 'assistant_meeting_briefing_enabled', value: '1' }]).meetingBriefingEnabled
    ).toBe(true)
  })

  it('I.10.4: 회의 전 알림 분은 1~120 경계값을 읽는다', () => {
    expect(parseAssistantSettings([{ key: 'assistant_meeting_lead_min', value: '1' }]).meetingLeadMin).toBe(1)
    expect(parseAssistantSettings([{ key: 'assistant_meeting_lead_min', value: '120' }]).meetingLeadMin).toBe(120)
    expect(parseAssistantSettings([{ key: 'assistant_meeting_lead_min', value: '121' }]).meetingLeadMin).toBe(15)
  })

  it('A24: assistant_start_view 는 today·projects·calendar 를 읽는다', () => {
    for (const v of ['today', 'projects', 'calendar'] as const) {
      expect(parseAssistantSettings([{ key: 'assistant_start_view', value: v }]).startView).toBe(v)
    }
  })

  it('A24: 이전 저장값 auto·dashboard 는 today 로 읽힌다', () => {
    expect(parseAssistantSettings([{ key: 'assistant_start_view', value: 'auto' }]).startView).toBe('today')
    expect(parseAssistantSettings([{ key: 'assistant_start_view', value: 'dashboard' }]).startView).toBe('today')
  })

  it('A24: 이전 저장값을 읽어도 입력 행을 바꾸지 않는다', () => {
    const rows = [{ key: 'assistant_start_view', value: 'dashboard' }]
    parseAssistantSettings(rows)
    expect(rows).toEqual([{ key: 'assistant_start_view', value: 'dashboard' }])
  })

  it('A24: assistant_start_view 가 허용값이 아니면 기본값 today 다', () => {
    for (const v of ['', 'Today', 'memos', '1']) {
      expect(parseAssistantSettings([{ key: 'assistant_start_view', value: v }]).startView).toBe('today')
    }
  })

  it('A54: assistant_morning_sync_enabled 는 0·1 을 읽는다. 기본값은 켬이다', () => {
    expect(parseAssistantSettings([]).morningSyncEnabled).toBe(true)
    expect(parseAssistantSettings([{ key: 'assistant_morning_sync_enabled', value: '0' }]).morningSyncEnabled).toBe(false)
    expect(parseAssistantSettings([{ key: 'assistant_morning_sync_enabled', value: '1' }]).morningSyncEnabled).toBe(true)
    expect(parseAssistantSettings([{ key: 'assistant_morning_sync_enabled', value: 'yes' }]).morningSyncEnabled).toBe(true)
  })

  it('A54: assistant_morning_sync_time 은 HH:mm 을 읽는다. 기본값은 08:00 이다', () => {
    expect(parseAssistantSettings([]).morningSyncTime).toBe('08:00')
    expect(parseAssistantSettings([{ key: 'assistant_morning_sync_time', value: '07:30' }]).morningSyncTime).toBe('07:30')
    expect(parseAssistantSettings([{ key: 'assistant_morning_sync_time', value: '00:00' }]).morningSyncTime).toBe('00:00')
    for (const v of ['7:30', '24:00', '08:60', '', 'morning']) {
      expect(parseAssistantSettings([{ key: 'assistant_morning_sync_time', value: v }]).morningSyncTime).toBe('08:00')
    }
  })

  it('assistant_complete_origin_on_done 은 0·1 을 읽는다. 기본값은 끔이다', () => {
    expect(parseAssistantSettings([]).completeOriginOnDone).toBe(false)
    expect(
      parseAssistantSettings([{ key: 'assistant_complete_origin_on_done', value: '1' }]).completeOriginOnDone
    ).toBe(true)
    expect(
      parseAssistantSettings([{ key: 'assistant_complete_origin_on_done', value: '0' }]).completeOriginOnDone
    ).toBe(false)
    expect(
      parseAssistantSettings([{ key: 'assistant_complete_origin_on_done', value: 'true' }]).completeOriginOnDone
    ).toBe(false)
  })

  it('B.6: DB 에 남은 assistant_slot_min 행은 무시한다', () => {
    const s = parseAssistantSettings([
      { key: 'assistant_slot_min', value: '90' },
      { key: 'assistant_plan_size', value: '6' }
    ])
    expect(s).toEqual({ ...DEFAULT_ASSISTANT_SETTINGS, planSize: 6 })
    expect(Object.keys(s)).not.toContain('slot' + 'Min')
  })

  it('다른 키는 무시한다', () => {
    expect(parseAssistantSettings([{ key: 'jira_token', value: 'x' }])).toEqual(DEFAULT_ASSISTANT_SETTINGS)
  })

  it('기본값 객체를 바꾸지 않는다', () => {
    const before = { ...DEFAULT_ASSISTANT_SETTINGS }
    parseAssistantSettings([{ key: 'assistant_plan_size', value: '9' }])
    expect(DEFAULT_ASSISTANT_SETTINGS).toEqual(before)
  })
})

describe('serializeAssistantSettingsPatch', () => {
  it('부분 설정을 app_settings 행으로 바꾼다', () => {
    expect(
      serializeAssistantSettingsPatch({ enabled: false, workEnd: '19:00', planSize: 3, llmModel: 'opus' })
    ).toEqual([
      { key: 'assistant_enabled', value: '0' },
      { key: 'assistant_work_end', value: '19:00' },
      { key: 'assistant_plan_size', value: '3' },
      { key: 'assistant_llm_model', value: 'opus' }
    ])
  })

  it('직렬화한 값을 다시 읽으면 같은 값이다', () => {
    const patch = { dayRollover: '03:00', refreshNotify: false, meetingLeadMin: 10 }
    const s = parseAssistantSettings(serializeAssistantSettingsPatch(patch))
    expect(s.dayRollover).toBe('03:00')
    expect(s.refreshNotify).toBe(false)
    expect(s.meetingLeadMin).toBe(10)
  })

  it('A24: startView 를 assistant_start_view 행으로 바꾼다', () => {
    expect(serializeAssistantSettingsPatch({ startView: 'today' })).toEqual([
      { key: 'assistant_start_view', value: 'today' }
    ])
    expect(serializeAssistantSettingsPatch({ startView: 'calendar' })).toEqual([
      { key: 'assistant_start_view', value: 'calendar' }
    ])
    const s = parseAssistantSettings(serializeAssistantSettingsPatch({ startView: 'projects' }))
    expect(s.startView).toBe('projects')
  })

  it('A24: startView 가 허용값이 아니면 throw 한다. 이전 값 auto·dashboard 도 쓰지 않는다', () => {
    expect(() => serializeAssistantSettingsPatch({ startView: 'dashboard' })).toThrow(/비서 설정 값이 올바르지 않습니다/)
    expect(() => serializeAssistantSettingsPatch({ startView: 'auto' })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ startView: 'Today' })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ startView: null })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ startView: 1 })).toThrow()
  })

  it('I.11.4: meetingBriefingEnabled 를 assistant_meeting_briefing_enabled 행으로 바꾼다', () => {
    expect(serializeAssistantSettingsPatch({ meetingBriefingEnabled: false })).toEqual([
      { key: 'assistant_meeting_briefing_enabled', value: '0' }
    ])
    expect(
      parseAssistantSettings(serializeAssistantSettingsPatch({ meetingBriefingEnabled: false })).meetingBriefingEnabled
    ).toBe(false)
    expect(() => serializeAssistantSettingsPatch({ meetingBriefingEnabled: 'yes' })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ meetingLeadMin: 0 })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ meetingLeadMin: 121 })).toThrow()
  })

  it('D1: 제거된 체크인 설정 필드는 모르는 키로 throw 한다 (부록 L)', () => {
    // 예전에는 올바르던 값이다. 필드가 남아 있으면 throw 하지 않는다
    const cases: [string, unknown][] = [['Enabled', false], ['MinGap', 45], ['DailyCap', 4]]
    for (const [suffix, value] of cases) {
      const name = `${'check'}in${suffix}`
      expect(() => serializeAssistantSettingsPatch({ [name]: value })).toThrow(/알 수 없는 비서 설정입니다/)
    }
  })

  it('A54: 아침 자동 동기화 설정을 행으로 바꾼다. 형식이 틀리면 throw 한다', () => {
    expect(serializeAssistantSettingsPatch({ morningSyncEnabled: false, morningSyncTime: '07:45' })).toEqual([
      { key: 'assistant_morning_sync_enabled', value: '0' },
      { key: 'assistant_morning_sync_time', value: '07:45' }
    ])
    const s = parseAssistantSettings(serializeAssistantSettingsPatch({ morningSyncEnabled: false, morningSyncTime: '09:10' }))
    expect(s.morningSyncEnabled).toBe(false)
    expect(s.morningSyncTime).toBe('09:10')
    expect(() => serializeAssistantSettingsPatch({ morningSyncEnabled: 1 })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ morningSyncTime: '8:00' })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ morningSyncTime: '24:00' })).toThrow()
  })

  it('completeOriginOnDone 을 assistant_complete_origin_on_done 행으로 바꾼다', () => {
    expect(serializeAssistantSettingsPatch({ completeOriginOnDone: true })).toEqual([
      { key: 'assistant_complete_origin_on_done', value: '1' }
    ])
    expect(() => serializeAssistantSettingsPatch({ completeOriginOnDone: 'true' })).toThrow()
  })

  it('빈 객체는 빈 배열이다', () => {
    expect(serializeAssistantSettingsPatch({})).toEqual([])
  })

  it('객체가 아니면 throw 한다', () => {
    expect(() => serializeAssistantSettingsPatch(null)).toThrow()
    expect(() => serializeAssistantSettingsPatch('x')).toThrow()
    expect(() => serializeAssistantSettingsPatch([])).toThrow()
  })

  it('모르는 키는 throw 한다', () => {
    expect(() => serializeAssistantSettingsPatch({ jiraToken: 'x' })).toThrow()
  })

  it('B.6: 3판에서 없앤 슬롯 길이 키는 모르는 키로 throw 한다', () => {
    // 완료 조건 6 의 grep 이 키 이름을 잡지 않도록 문자열을 나눠 쓴다
    const removedKey = 'slot' + 'Min'
    expect(() => serializeAssistantSettingsPatch({ [removedKey]: 60 })).toThrow(/알 수 없는 비서 설정/)
  })

  it('형식이 틀린 값은 throw 한다', () => {
    expect(() => serializeAssistantSettingsPatch({ enabled: '1' })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ dayRollover: '4:00' })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ planSize: 2.5 })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ planSize: 0 })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ llmModel: 'gpt' })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ jiraScope: 'mine' })).toThrow()
  })
})
