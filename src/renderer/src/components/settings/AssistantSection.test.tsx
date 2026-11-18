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
  it('최신화 설정 3개를 보여 준다', () => {
    const html = render(SETTINGS)
    expect(html).toContain('최신화 알림')
    expect(html).toContain('지금·다음 블록이 바뀌거나 긴급한 일이 들어오면 알립니다')
    expect(html).toContain('캘린더 확인 주기 (분)')
    expect(html).toContain('권장 5분')
    expect(html).toContain('Jira 확인 주기 (분)')
    expect(html).toContain('기본 15분')
    expect(html).toContain('value="5"')
    expect(html).toContain('value="15"')
  })

  it('회의 브리핑 설정 2개와 노출 키를 보여 준다', () => {
    const html = render(SETTINGS)
    expect(html).toContain('회의 전 브리핑')
    expect(html).toContain('회의 시작 전에 관련 프로젝트·지난 회의·액션아이템을 알립니다')
    expect(html).toContain('회의 전 알림(분)')
    expect(html).toContain('권장 15분. 기존 10분 전 일정 알림보다 앞서게 두세요')
    expect(html).toContain('날짜 경계')
    expect(html).toContain('시작 알림')
    expect(html).not.toContain('소요 분')
  })

  it('첫 화면 옵션은 오늘·프로젝트·캘린더이고 이전 값 dashboard 는 오늘로 보인다', () => {
    const html = render({ ...SETTINGS, startView: 'dashboard' as AssistantSettings['startView'] })
    expect(html).toContain('<option value="today" selected="">오늘</option>')
    expect(html).toContain('<option value="projects">프로젝트</option>')
    expect(html).toContain('<option value="calendar">캘린더</option>')
    expect(html).not.toContain('대시보드')
  })

  it('아침 자동 동기화 토글·시각과 원본 완료를 보여 주고, 새 키가 없으면 켬·08:00·끔이다', () => {
    const legacy = { ...SETTINGS } as Partial<AssistantSettings>
    delete legacy.morningSyncEnabled
    delete legacy.morningSyncTime
    delete legacy.completeOriginOnDone
    const html = render(legacy as AssistantSettings)
    expect(html).toContain('아침 자동 동기화')
    expect(html).toContain('아침 동기화 시각')
    expect(html).toContain('value="08:00"')
    expect(html).toContain('완료하면 원본도 완료')
    expect(html).toMatch(/<input type="checkbox" class="mt-0.5" checked=""\/><span><span class="block text-sm text-gray-800">아침 자동 동기화/)
    expect(html).toMatch(/<input type="checkbox" class="mt-0.5"\/><span><span class="block text-sm text-gray-800">완료하면 원본도 완료/)
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
