import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SyncAllResult } from '../../types'
import SyncAllSummary from './SyncAllSummary'

// 전체 동기화는 성공·매칭 실패·오류가 한 번에 섞여 나온다.
// 특히 unmatched를 조용히 넘기면 "동기화했는데 왜 릴리스가 없지" 상태가 되므로
// 프로젝트명과 버전이 실제로 화면에 나오는지 고정한다.

const EMPTY: SyncAllResult = { synced: [], unmatched: [], failed: [], skipped: 0 }

const render = (over: Partial<SyncAllResult>): string =>
  renderToStaticMarkup(<SyncAllSummary result={{ ...EMPTY, ...over }} />)

describe('SyncAllSummary', () => {
  it('매칭 실패한 프로젝트와 버전을 하나하나 나열한다', () => {
    const html = render({
      unmatched: [
        { projectId: 1, projectName: '[작가앱] 웹뷰 초기화 실패 크래시 대응', version: '2.8.2' },
        { projectId: 2, projectName: '[구매자앱] 검색 개편', version: '4.164.0' }
      ]
    })
    expect(html).toContain('[작가앱] 웹뷰 초기화 실패 크래시 대응 (2.8.2)')
    expect(html).toContain('[구매자앱] 검색 개편 (4.164.0)')
    expect(html).toContain('매칭 실패 2건')
  })

  it('동기화된 프로젝트는 가져온 이슈 수까지 낸다', () => {
    const html = render({
      synced: [{ projectId: 1, projectName: '검색 개편', version: '4.164.0', itemCount: 12 }]
    })
    expect(html).toContain('검색 개편 — 4.164.0 · 이슈 12건')
    expect(html).toContain('동기화 1건')
  })

  it('실패한 프로젝트는 오류 메시지를 그대로 붙인다', () => {
    const html = render({
      failed: [
        {
          projectId: 3,
          projectName: '결제 개선',
          version: '1.0.0',
          error: 'Jira 토큰이 만료됐거나 유효하지 않습니다.'
        }
      ]
    })
    expect(html).toContain('결제 개선 (1.0.0) — Jira 토큰이 만료됐거나 유효하지 않습니다.')
  })

  it('배포 버전이 없어 건너뛴 개수를 밝힌다', () => {
    const html = render({ skipped: 5 })
    expect(html).toContain('배포 버전 없음 5건')
    expect(html).toContain('건너뛴 프로젝트 5개')
  })

  it('네 갈래를 한 줄 요약으로 함께 보여준다 — 성공만 보고 끝나면 안 된다', () => {
    const html = render({
      synced: [{ projectId: 1, projectName: 'A', version: '1', itemCount: 1 }],
      unmatched: [{ projectId: 2, projectName: 'B', version: '2' }],
      failed: [{ projectId: 3, projectName: 'C', version: '3', error: 'boom' }],
      skipped: 4
    })
    for (const label of ['동기화 1건', '매칭 실패 1건', '오류 1건', '배포 버전 없음 4건']) {
      expect(html).toContain(label)
    }
  })

  it('대상이 하나도 없으면 그 사실을 밝힌다', () => {
    expect(render({})).toContain('동기화 대상 프로젝트가 없었습니다')
  })
})
