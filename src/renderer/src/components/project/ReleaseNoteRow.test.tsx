import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReleaseNoteItem, ReleaseNoteSummary } from '../../types'

// 이 앱은 자동 클릭 기반 UI 검증이 불가능하다(접근성 권한). 릴리스 행에서 눈으로만 확인되던
// 규칙 — 0건 명시, 실패 표시, 상한 안내, 하위 이슈 들여쓰기 — 을 마크업으로 잠근다.
//
// 행은 zustand 스토어를 직접 구독하는데 zustand v5는 서버 렌더에서 초기 상태만 돌려줘
// setState로 주입되지 않는다. TaskList.test.tsx와 같이 훅을 모킹한다.

const item = (
  id: number,
  key: string,
  type: string | null,
  summary: string,
  parent: string | null = null
): ReleaseNoteItem => ({
  id,
  release_note_id: 1,
  issue_key: key,
  issue_type: type,
  status: '완료',
  resolution: '해결됨',
  summary,
  parent_key: parent,
  sort_order: id
})

const note = (over: Partial<ReleaseNoteSummary> = {}): ReleaseNoteSummary => ({
  id: 1,
  jira_project_key: 'ICA',
  jira_version_id: '10042',
  version_name: 'v1.2.0',
  description: null,
  released: 0,
  archived: 0,
  release_date: null,
  start_date: null,
  last_synced_at: '2026-08-19 10:30:00',
  last_sync_error: null,
  created_at: '2026-08-01 09:00:00',
  updated_at: '2026-08-19 10:30:00',
  item_count: 0,
    ...over
})

interface MockState {
  syncingId: number | null
  syncResults: Record<number, { itemCount: number; truncated: boolean }>
  syncErrors: Record<number, string>
}

const BASE: MockState = { syncingId: null, syncResults: {}, syncErrors: {} }
let state: MockState = BASE

const noop = async (): Promise<void> => {}

vi.mock('../../stores/releaseNoteStore', () => ({
  useReleaseNoteStore: () => ({
    ...state,
    notes: [],
    allNotes: [],
    details: {},
    jiraStatus: null,
    loading: false,
    allLoading: false,
    fetchJiraStatus: noop,
    fetchReleaseNotes: noop,
    fetchAllReleaseNotes: noop,
    fetchDetail: async () => null,
    syncNote: async () => ({ success: true })
  })
}))

const mod = await import('./ReleaseNoteRow')
const ReleaseNoteRow = mod.default
const { ReleaseNoteItemList, groupReleaseNoteItems } = mod

const renderRow = (over: Partial<ReleaseNoteSummary>, mock: Partial<MockState> = {}): string => {
  state = { ...BASE, ...mock }
  return renderToStaticMarkup(<ReleaseNoteRow note={note(over)} />)
}

describe('groupReleaseNoteItems', () => {
  it('하위 이슈는 자기 유형이 아니라 부모 그룹에 부모 바로 뒤로 들어간다', () => {
    // Jira에서 Sub-task는 부모(Story)와 유형이 다르다 — 유형으로만 묶으면 부모와 갈라진다
    const groups = groupReleaseNoteItems([
      item(1, 'ICA-1', 'Story', '검색홈 개편'),
      item(2, 'ICA-2', 'Sub-task', '검색 필터 UI', 'ICA-1'),
      item(3, 'ICA-3', 'Bug', '필터 오작동 수정')
    ])
    expect(groups.map((g) => g.type)).toEqual(['Story', 'Bug'])
    expect(groups[0].rows.map((r) => [r.item.issue_key, r.child])).toEqual([
      ['ICA-1', false],
      ['ICA-2', true]
    ])
  })

  it('부모가 릴리스 안에 없으면 최상위로 둔다', () => {
    const groups = groupReleaseNoteItems([item(1, 'ICA-2', 'Sub-task', '고아 하위', 'ICA-999')])
    expect(groups[0].rows).toEqual([
      { item: expect.objectContaining({ issue_key: 'ICA-2' }), child: false }
    ])
  })

  it('issue_type이 비면 기타 그룹으로 모은다', () => {
    const groups = groupReleaseNoteItems([item(1, 'ICA-1', null, '유형 없음')])
    expect(groups.map((g) => g.type)).toEqual(['기타'])
  })

  it('부모-자식이 순환해도 항목이 사라지지 않는다', () => {
    const groups = groupReleaseNoteItems([
      item(1, 'ICA-1', 'Story', 'A', 'ICA-2'),
      item(2, 'ICA-2', 'Story', 'B', 'ICA-1')
    ])
    const keys = groups.flatMap((g) => g.rows.map((r) => r.item.issue_key))
    expect(keys.sort()).toEqual(['ICA-1', 'ICA-2'])
  })

  it('sort_order 순으로 그룹 순서를 정한다', () => {
    const groups = groupReleaseNoteItems([
      item(3, 'ICA-3', 'Bug', '늦게 온 버그'),
      item(1, 'ICA-1', 'Story', '먼저 온 스토리')
    ])
    expect(groups.map((g) => g.type)).toEqual(['Story', 'Bug'])
  })
})

describe('ReleaseNoteItemList 렌더', () => {
  const html = renderToStaticMarkup(
    <ReleaseNoteItemList
      items={[
        item(1, 'ICA-1', 'Story', '검색홈 개편'),
        item(2, 'ICA-2', 'Sub-task', '검색 필터 UI', 'ICA-1')
      ]}
    />
  )
  const rows = [...html.matchAll(/class="flex items-center gap-2 py-1\.5 pr-3 ([^"]*)"/g)].map(
    (m) => m[1]
  )

  it('하위 행만 깊게 들여쓴다', () => {
    expect(rows).toEqual(['pl-3', 'pl-9'])
  })

  it('이슈 키 칩은 taskTag.issue 스타일을 재사용한다', () => {
    expect(html).toContain('bg-indigo-50 text-indigo-600 font-mono')
    expect(html).toContain('ICA-1')
  })

  it('항목이 없으면 빈 릴리스임을 문구로 밝힌다', () => {
    expect(renderToStaticMarkup(<ReleaseNoteItemList items={[]} />)).toContain(
      '이 릴리스에 포함된 이슈가 없습니다'
    )
  })
})

describe('ReleaseNoteRow 상태 표시', () => {
  it('동기화 결과가 0건이면 0건임을 명시한다 — 빈 화면이 실패로 읽히면 안 된다', () => {
    const html = renderRow({ item_count: 0 })
    expect(html).toContain('가져온 이슈: 0건')
    expect(html).toContain('마지막 동기화 2026-08-19 10:30')
    expect(html).not.toContain('동기화 실패')
  })

  it('한 번도 동기화하지 않았으면 0건이 아니라 미동기화로 구분한다', () => {
    const html = renderRow({ last_synced_at: null })
    expect(html).toContain('아직 동기화하지 않았습니다')
    expect(html).not.toContain('가져온 이슈')
  })

  it('last_sync_error는 붉은 톤으로 드러낸다', () => {
    const html = renderRow({ last_sync_error: 'Jira 토큰이 만료됐거나 유효하지 않습니다.' })
    expect(html).toContain('동기화 실패 — Jira 토큰이 만료됐거나 유효하지 않습니다.')
    expect(html).toMatch(/bg-red-50[^"]*text-red-600|text-red-600[^"]*bg-red-50/)
  })

  it('세션 중 난 실패는 last_sync_error가 없어도 표시한다', () => {
    const html = renderRow({}, { syncErrors: { 1: '네트워크에 연결할 수 없습니다' } })
    expect(html).toContain('네트워크에 연결할 수 없습니다')
  })

  it('출시 여부와 Jira 프로젝트 키를 함께 보여준다', () => {
    expect(renderRow({ released: 1 })).toContain('출시됨')
    expect(renderRow({ released: 0 })).toContain('미출시')
    expect(renderRow({})).toContain('ICA')
  })

  it('500건 상한에 걸리면 잘렸음을 알린다', () => {
    const html = renderRow(
      { item_count: 500 },
      { syncResults: { 1: { itemCount: 500, truncated: true } } }
    )
    expect(html).toContain('상위 500건만 가져왔습니다')
  })

  it('truncated 플래그가 없어도(앱 재시작 후) 항목 수가 상한이면 단정하지 않고 알린다', () => {
    const html = renderRow({ item_count: 500 })
    expect(html).toContain('상한(500건)에 닿았습니다')
    expect(html).not.toContain('상위 500건만 가져왔습니다')
    // 상한 미만이면 띄우지 않는다
    expect(renderRow({ item_count: 499 })).not.toContain('상한(500건)')
  })
})

