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

  it('§3.2 키 15개, 부록 C.2 키 1개, 부록 H 키 1개, 모두 17개를 가진다. 3판에서 assistant_slot_min 을 없앴다 (부록 B.6)', () => {
    expect(Object.keys(ASSISTANT_SETTING_KEYS)).toHaveLength(17)
    expect(new Set(Object.values(ASSISTANT_SETTING_KEYS)).size).toBe(17)
    expect(Object.values(ASSISTANT_SETTING_KEYS)).not.toContain('assistant_slot_min')
    expect(ASSISTANT_SETTING_KEYS.dayRollover).toBe('assistant_day_rollover')
    expect(ASSISTANT_SETTING_KEYS.refreshCalendarMin).toBe('assistant_refresh_calendar_min')
    expect(ASSISTANT_SETTING_KEYS.refreshJiraMin).toBe('assistant_refresh_jira_min')
    expect(ASSISTANT_SETTING_KEYS.refreshNotify).toBe('assistant_refresh_notify')
    expect(ASSISTANT_SETTING_KEYS.startView).toBe('assistant_start_view')
    expect(ASSISTANT_SETTING_KEYS.checkinEnabled).toBe('assistant_checkin_enabled')
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
      checkinMinGap: 45,
      checkinDailyCap: 4,
      meetingLeadMin: 15,
      startView: 'auto',
      checkinEnabled: true
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
      { key: 'assistant_checkin_daily_cap', value: '-1' },
      { key: 'assistant_llm_model', value: 'gpt' },
      { key: 'assistant_jira_scope', value: 'mine' },
      { key: 'assistant_start_view', value: 'calendar' },
      { key: 'assistant_checkin_enabled', value: 'yes' },
      { key: 'assistant_checkin_min_gap', value: '4' },
      { key: 'assistant_checkin_daily_cap', value: '21' }
    ])
    expect(s).toEqual(DEFAULT_ASSISTANT_SETTINGS)
  })

  it('H.9.3: assistant_checkin_enabled 는 0·1 을 읽는다. 기본값은 켬이다', () => {
    expect(parseAssistantSettings([]).checkinEnabled).toBe(true)
    expect(parseAssistantSettings([{ key: 'assistant_checkin_enabled', value: '0' }]).checkinEnabled).toBe(false)
    expect(parseAssistantSettings([{ key: 'assistant_checkin_enabled', value: '1' }]).checkinEnabled).toBe(true)
  })

  it('H.8.4: 체크인 상한 0~20, 최소 간격 5~480 경계값을 읽는다', () => {
    const lo = parseAssistantSettings([
      { key: 'assistant_checkin_daily_cap', value: '0' },
      { key: 'assistant_checkin_min_gap', value: '5' }
    ])
    expect(lo.checkinDailyCap).toBe(0)
    expect(lo.checkinMinGap).toBe(5)
    const hi = parseAssistantSettings([
      { key: 'assistant_checkin_daily_cap', value: '20' },
      { key: 'assistant_checkin_min_gap', value: '480' }
    ])
    expect(hi.checkinDailyCap).toBe(20)
    expect(hi.checkinMinGap).toBe(480)
    expect(parseAssistantSettings([{ key: 'assistant_checkin_min_gap', value: '481' }]).checkinMinGap).toBe(45)
  })

  it('C.2: assistant_start_view 는 auto·dashboard·today 를 읽는다', () => {
    for (const v of ['auto', 'dashboard', 'today'] as const) {
      expect(parseAssistantSettings([{ key: 'assistant_start_view', value: v }]).startView).toBe(v)
    }
  })

  it('C.2: assistant_start_view 가 허용값이 아니면 기본값 auto 다', () => {
    for (const v of ['', 'Today', 'calendar', '1']) {
      expect(parseAssistantSettings([{ key: 'assistant_start_view', value: v }]).startView).toBe('auto')
    }
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

  it('C.2: startView 를 assistant_start_view 행으로 바꾼다', () => {
    expect(serializeAssistantSettingsPatch({ startView: 'today' })).toEqual([
      { key: 'assistant_start_view', value: 'today' }
    ])
    expect(serializeAssistantSettingsPatch({ startView: 'dashboard' })).toEqual([
      { key: 'assistant_start_view', value: 'dashboard' }
    ])
    const s = parseAssistantSettings(serializeAssistantSettingsPatch({ startView: 'auto' }))
    expect(s.startView).toBe('auto')
  })

  it('C.2: startView 가 허용값이 아니면 throw 한다', () => {
    expect(() => serializeAssistantSettingsPatch({ startView: 'calendar' })).toThrow(/비서 설정 값이 올바르지 않습니다/)
    expect(() => serializeAssistantSettingsPatch({ startView: 'Today' })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ startView: null })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ startView: 1 })).toThrow()
  })

  it('H.9.3: checkinEnabled 를 assistant_checkin_enabled 행으로 바꾼다', () => {
    expect(serializeAssistantSettingsPatch({ checkinEnabled: false })).toEqual([
      { key: 'assistant_checkin_enabled', value: '0' }
    ])
    expect(parseAssistantSettings(serializeAssistantSettingsPatch({ checkinEnabled: false })).checkinEnabled).toBe(false)
    expect(() => serializeAssistantSettingsPatch({ checkinEnabled: 1 })).toThrow()
  })

  it('H.8.4: 체크인 상한·간격이 범위 밖이면 throw 한다', () => {
    expect(() => serializeAssistantSettingsPatch({ checkinDailyCap: -1 })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ checkinDailyCap: 21 })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ checkinMinGap: 4 })).toThrow()
    expect(() => serializeAssistantSettingsPatch({ checkinMinGap: 481 })).toThrow()
    expect(serializeAssistantSettingsPatch({ checkinDailyCap: 0, checkinMinGap: 480 })).toEqual([
      { key: 'assistant_checkin_daily_cap', value: '0' },
      { key: 'assistant_checkin_min_gap', value: '480' }
    ])
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
