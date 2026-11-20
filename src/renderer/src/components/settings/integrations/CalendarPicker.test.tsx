import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CalendarListEntry } from '../../../types'
import CalendarPicker, {
  CALENDAR_LIST_FAILED,
  CALENDAR_PICKER_HINT,
  CALENDAR_PICKER_OWN_ONLY,
  CalendarPickerView,
  toggleCalendarSelection,
  type CalendarPickerViewProps
} from './CalendarPicker'

const TECH = 'c_tech@group.calendar.google.com'
const CALENDARS: CalendarListEntry[] = [
  { id: 'primary', summary: 'me@example.com', primary: true, color: '#00ff00' },
  { id: TECH, summary: 'Tech', primary: false, color: '#ff0000' }
]

const render = (over: Partial<CalendarPickerViewProps> = {}): string =>
  renderToStaticMarkup(
    <CalendarPickerView
      calendars={CALENDARS}
      selectedIds={['primary']}
      loading={false}
      saving={false}
      listFailed={false}
      error=""
      onToggle={() => {}}
      {...over}
    />
  )

function inputOf(html: string, label: string): string {
  const tag = (html.match(/<input[^>]*>/g) ?? []).find((t) => t.includes(`aria-label="${label}"`))
  if (!tag) throw new Error(`input ${label} 없음`)
  return tag
}

describe('toggleCalendarSelection', () => {
  const available = CALENDARS.map((c) => c.id)

  it('켜면 목록 순서로 더한다', () => {
    expect(toggleCalendarSelection([TECH], available, 'primary', true)).toEqual(['primary', TECH])
  })

  it('끄면 뺀다', () => {
    expect(toggleCalendarSelection(['primary', TECH], available, TECH, false)).toEqual(['primary'])
  })

  it('마지막 1개를 끄면 null(거절)이다', () => {
    expect(toggleCalendarSelection(['primary'], available, 'primary', false)).toBeNull()
  })

  it('목록에 없는 옛 id 는 버리고, 그것만 남으면 거절한다', () => {
    expect(toggleCalendarSelection(['gone', 'primary'], available, TECH, true)).toEqual(['primary', TECH])
    expect(toggleCalendarSelection(['gone', 'primary'], available, 'primary', false)).toBeNull()
  })
})

describe('CalendarPickerView', () => {
  it('캘린더마다 체크박스를 그리고 기본 캘린더에 "기본" 을 붙인다', () => {
    const html = render()
    expect(html).toContain('가져올 캘린더')
    expect(html).toContain(CALENDAR_PICKER_HINT)
    expect(html).toContain(CALENDAR_PICKER_OWN_ONLY)
    expect(html.match(/type="checkbox"/g)?.length).toBe(2)
    expect(html).toContain('me@example.com')
    expect(html).toContain('Tech')
    expect(html).toContain('>기본<')
  })

  it('선택이 1개뿐이면 그 체크박스는 끌 수 없다', () => {
    const html = render({ selectedIds: ['primary'] })
    expect(inputOf(html, 'me@example.com')).toContain('disabled=""')
    expect(inputOf(html, 'me@example.com')).toContain('checked=""')
    expect(inputOf(html, 'Tech')).not.toContain('disabled=""')
  })

  it('2개 선택이면 둘 다 끌 수 있다', () => {
    const html = render({ selectedIds: ['primary', TECH] })
    expect(html).not.toContain('disabled=""')
    expect(html.match(/checked=""/g)?.length).toBe(2)
  })

  it('목록 조회 실패면 다시 로그인 안내를 보이고 목록은 그리지 않는다', () => {
    const html = render({ listFailed: true, calendars: [] })
    expect(html).toContain(CALENDAR_LIST_FAILED)
    expect(html).toContain('다시 로그인')
    expect(html).not.toContain('type="checkbox"')
  })

  it('저장 실패 문구를 보인다', () => {
    expect(render({ error: '선택을 저장하지 못했습니다' })).toContain('선택을 저장하지 못했습니다')
  })

  it('불러오는 중 표시', () => {
    expect(render({ loading: true })).toContain('불러오는 중')
  })
})

describe('CalendarPicker', () => {
  it('미연결이면 아무것도 그리지 않는다', () => {
    expect(renderToStaticMarkup(<CalendarPicker connected={false} />)).toBe('')
  })
})
