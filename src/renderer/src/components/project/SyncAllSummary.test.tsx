import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SyncAllResult } from '../../types'
import SyncAllSummary from './SyncAllSummary'

// 전체 동기화는 성공·이슈 보류·오류가 한 번에 섞여 나온다.
// 특히 이슈 보류를 조용히 넘기면 "가져왔는데 왜 내용이 비었지" 상태가 되므로
// 버전과 사유가 실제로 화면에 나오는지 고정한다.

const EMPTY: SyncAllResult = { synced: [], metaOnly: [], failed: [] }

const render = (over: Partial<SyncAllResult>): string =>
  renderToStaticMarkup(<SyncAllSummary result={{ ...EMPTY, ...over }} />)

describe('SyncAllSummary', () => {
  it('동기화된 릴리스는 가져온 이슈 수까지 낸다', () => {
    const html = render({
      synced: [{ noteId: 1, version: '4.164.0', itemCount: 12 }]
    })
    expect(html).toContain('4.164.0 · 이슈 12건')
    expect(html).toContain('동기화 1건')
  })

  it('실패한 릴리스는 오류 메시지를 그대로 붙인다', () => {
    const html = render({
      failed: [{ version: '1.0.0', error: 'Jira 토큰이 만료됐거나 유효하지 않습니다.' }]
    })
    expect(html).toContain('1.0.0 — Jira 토큰이 만료됐거나 유효하지 않습니다.')
  })

  it('이슈를 미룬 릴리스는 이유와 함께 나열한다 — 빈 릴리스로 오해하면 안 된다', () => {
    const html = render({ metaOnly: [{ noteId: 5, version: '4.150.0' }] })
    expect(html).toContain('4.150.0')
    expect(html).toContain('동기화 버튼을 누르면 이슈를 가져옵니다')
  })

  it('세 갈래를 한 줄 요약으로 함께 보여준다 — 성공만 보고 끝나면 안 된다', () => {
    const html = render({
      synced: [{ noteId: 1, version: '1', itemCount: 1 }],
      metaOnly: [{ noteId: 9, version: '4.150.0' }],
      failed: [{ version: '3', error: 'boom' }]
    })
    for (const label of ['동기화 1건', '이슈 보류 1건', '오류 1건']) {
      expect(html).toContain(label)
    }
  })

  it('프로젝트 이름은 어디에도 나오지 않는다 — 릴리스는 프로젝트에 묶이지 않는다', () => {
    const html = render({ synced: [{ noteId: 1, version: '4.164.0', itemCount: 3 }] })
    expect(html).not.toContain('프로젝트')
  })

  it('대상이 하나도 없으면 그 사실을 밝힌다', () => {
    expect(render({})).toContain('Jira에서 가져올 릴리스가 없었습니다')
  })
})
