import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { format } from 'date-fns'
import type { Memo } from '../../types'

// 홈('오늘' 화면)의 중요 메모 구역을 마크업으로 잠근다 (메뉴 통합 D1).
// zustand v5 는 서버 렌더에서 초기 상태만 돌려준다. 그래서 스토어 훅을 모킹한다.
// 자동 클릭이 불가해 renderToStaticMarkup 으로 판정한다.

const state: { importantMemos: Memo[] } = { importantMemos: [] }

vi.mock('../../stores/memoStore', () => ({
  useMemoStore: () => ({
    importantMemos: state.importantMemos,
    fetchImportantMemos: async () => {}
  })
}))

const { HomeMemos } = await import('./HomeOverview')

const memo = (over: Partial<Memo> & Pick<Memo, 'id' | 'content'>): Memo => ({
  is_archived: 0,
  is_important: 1,
  color: 'yellow',
  category_id: null,
  created_at: '2026-11-02 09:15:00',
  updated_at: '2026-11-02 09:15:00',
  ...over
})

const render = (): string => renderToStaticMarkup(<HomeMemos />)

beforeEach(() => {
  state.importantMemos = []
})

describe('HomeMemos 중요 메모', () => {
  it('중요 메모가 있으면 제목과 본문을 보인다. 날짜는 ISO 가 아니다 (A53)', () => {
    state.importantMemos = [memo({ id: 1, content: '배포 동결 기간 확인' })]
    const html = render()
    expect(html).toContain('id="home-overview"')
    expect(html).toContain('중요 메모')
    expect(html).toContain('배포 동결 기간 확인')
    // created_at 은 datetime('now') 로 저장한 UTC 다. 로컬 시각으로 바꿔 보인다(한국이면 18:15)
    expect(html).toContain(format(new Date(Date.UTC(2026, 10, 2, 9, 15, 0)), 'M/d HH:mm'))
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('UTC 저장 시각을 로컬로 읽지 않는다 (9시간 어긋남 회귀 방지)', () => {
    state.importantMemos = [memo({ id: 1, content: '시각 확인', created_at: '2026-11-02 23:30:00' })]
    const html = render()
    expect(html).toContain(format(new Date(Date.UTC(2026, 10, 2, 23, 30, 0)), 'M/d HH:mm'))
    // 로컬로 잘못 읽은 값은 UTC 가 아닌 시간대에서만 달라진다
    const wrong = format(new Date('2026-11-02T23:30:00'), 'M/d HH:mm')
    if (new Date('2026-11-02T23:30:00').getTimezoneOffset() !== 0) expect(html).not.toContain(wrong)
  })

  it('중요 메모가 0건이면 아무것도 그리지 않는다', () => {
    expect(render()).toBe('')
  })
})
