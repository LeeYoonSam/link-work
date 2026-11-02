import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TrayAssistantSection, trayStatusLine } from './TrayPanel'

// 트레이 '오늘 계획' 섹션은 근무 상태(none·active·closed)마다 문구와 버튼이 달라야 한다 (부록 E.4.2).
// window.api 를 쓰지 않는다. 섹션은 props 만으로 그린다.

type Assistant = Parameters<typeof trayStatusLine>[0]

const base = (over: Partial<Assistant> = {}): Assistant => ({
  logicalDate: '2026-11-02',
  status: 'active',
  startedAt: '09:40',
  items: [],
  activeCount: 0,
  doneCount: 0,
  suggestedCount: 0,
  urgentSuggestedCount: 0,
  freeMinutesLeft: 120,
  ...over
})

const noop = (): void => {}

function render(a: Assistant, opts: { busy?: boolean; error?: string } = {}): string {
  return renderToStaticMarkup(
    <TrayAssistantSection
      assistant={a}
      busy={opts.busy ?? false}
      error={opts.error ?? ''}
      onStartDay={noop}
      onCloseDay={noop}
      onOpenToday={noop}
    />
  )
}

describe('trayStatusLine', () => {
  it('상태별 한 줄 문구를 만든다', () => {
    expect(trayStatusLine(base({ status: 'none', startedAt: null }))).toBe('오늘 계획이 없습니다')
    expect(trayStatusLine(base({ status: 'closed' }))).toBe('오늘 마감')
    expect(trayStatusLine(base({ freeMinutesLeft: 95 }))).toBe('09:40 시작 · 집중 가능 95분')
  })
})

describe('TrayAssistantSection', () => {
  it('none: 계획 없음 문구와 하루 시작 버튼만 보인다', () => {
    const html = render(base({ status: 'none', startedAt: null, freeMinutesLeft: 0 }))
    expect(html).toContain('오늘 계획')
    expect(html).toContain('오늘 계획이 없습니다')
    expect(html).toContain('하루 시작')
    expect(html).not.toContain('퇴근')
    expect(html).not.toContain('오늘 보기')
  })

  it('active: 시작·집중 가능 줄, 상위 항목, 집중 배지, 제안 줄, 오늘 보기·퇴근 버튼이 보인다', () => {
    const html = render(
      base({
        items: [
          { id: 1, title: '결제 API 리뷰', rank: 1, status: 'in_progress', isFocus: true },
          { id: 2, title: '배포 체크리스트', rank: 2, status: 'planned', isFocus: false }
        ],
        activeCount: 2,
        suggestedCount: 3,
        urgentSuggestedCount: 1
      })
    )
    expect(html).toContain('09:40 시작 · 집중 가능 120분')
    expect(html).toContain('결제 API 리뷰')
    expect(html).toContain('배포 체크리스트')
    expect(html.match(/집중<\/span>/g) ?? []).toHaveLength(1)
    expect(html).toContain('새로 들어온 일 3건 · 긴급 1건')
    expect(html).toContain('오늘 보기')
    expect(html).toContain('퇴근')
    expect(html).not.toContain('하루 시작')
  })

  it('active: 제안이 없으면 제안 줄을 그리지 않는다', () => {
    const html = render(base())
    expect(html).not.toContain('새로 들어온 일')
  })

  it('closed: 오늘 마감 문구와 오늘 보기 버튼만 보인다', () => {
    const html = render(base({ status: 'closed' }))
    expect(html).toContain('오늘 마감')
    expect(html).toContain('오늘 보기')
    expect(html).not.toContain('퇴근')
    expect(html).not.toContain('하루 시작')
  })

  it('busy 면 버튼을 막고, 오류 문구를 섹션 안에 보인다', () => {
    const html = render(base(), { busy: true, error: '퇴근 처리에 실패했습니다' })
    expect(html.match(/<button[^>]*disabled=""/g) ?? []).toHaveLength(2)
    expect(html).toContain('퇴근 처리에 실패했습니다')

    const idle = render(base())
    expect(idle).not.toContain('disabled=""')
  })
})
