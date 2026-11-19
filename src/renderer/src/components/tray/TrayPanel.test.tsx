import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as TrayModule from './TrayPanel'

const { TrayEventList } = TrayModule

// 트레이는 오늘 일정 목록만 보인다. '오늘 계획' 섹션과 하루 시작/퇴근 버튼은 지웠다 (부록 O).

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

describe('TrayPanel 계획 섹션 제거', () => {
  it('계획 섹션 컴포넌트·문구 함수를 내보내지 않는다', () => {
    const mod = TrayModule as Record<string, unknown>
    expect(mod.TrayAssistantSection).toBeUndefined()
    expect(mod.trayStatusLine).toBeUndefined()
  })

  it('소스에 오늘 계획·하루 시작·퇴근·집중 문구와 assistant 호출이 없다', () => {
    const src = readFileSync(resolve(__dirname, 'TrayPanel.tsx'), 'utf8')
    for (const word of ['오늘 계획', '하루 시작', '퇴근', '집중', 'window.api.assistant']) {
      expect(src).not.toContain(word)
    }
  })
})
