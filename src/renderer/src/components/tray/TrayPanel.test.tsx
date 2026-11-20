import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TrayEventList } from './TrayPanel'

// 트레이는 오늘 일정 목록만 보인다 (docs/ASSISTANT.md §10).

describe('TrayEventList', () => {
  it('일정과 할 일을 시각·제목으로 보인다', () => {
    const html = renderToStaticMarkup(
      <TrayEventList
        events={[
          { summary: 'Tech weekly', time: '14:00', allDay: false, kind: 'event', isCompleted: false },
          { summary: '배포 체크리스트', time: '마감', allDay: false, kind: 'todo', isCompleted: true }
        ]}
      />
    )
    expect(html).toContain('Tech weekly')
    expect(html).toContain('14:00')
    expect(html).toContain('배포 체크리스트')
    expect(html).toContain('완료')
  })

  it('비면 빈 안내를 보인다', () => {
    expect(renderToStaticMarkup(<TrayEventList events={[]} />)).toContain('No events today')
  })
})
