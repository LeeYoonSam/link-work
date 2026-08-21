import { describe, it, expect } from 'vitest'
import { buildReleaseNoteMarkdown } from './releaseNoteExport'
import type { ReleaseNoteItem, ReleaseNoteWithItems } from '../types'

function note(overrides: Partial<ReleaseNoteWithItems> = {}): ReleaseNoteWithItems {
  return {
    id: 1,
    jira_project_key: 'ICA',
    jira_version_id: '10042',
    version_name: 'v4.162.0',
    description: null,
    released: 0,
    archived: 0,
    release_date: null,
    start_date: null,
    last_synced_at: '2026-08-20 10:00:00',
    last_sync_error: null,
    created_at: '',
    updated_at: '',
    items: [],
    ...overrides
  }
}

function item(overrides: Partial<ReleaseNoteItem> = {}): ReleaseNoteItem {
  return {
    id: 1,
    release_note_id: 1,
    issue_key: 'ICA-1',
    issue_type: 'Story',
    status: '완료',
    resolution: '해결됨',
    summary: '작업',
    parent_key: null,
    sort_order: 0,
    ...overrides
  }
}

// `## 유형` 헤딩만 추려 그룹 순서를 본다.
function groupHeadings(markdown: string): string[] {
  return markdown.split('\n').filter((line) => line.startsWith('## '))
}

// 그룹 헤딩 다음 줄부터 다음 빈 줄 직전까지 — 해당 그룹의 항목 줄만 잘라낸다.
function groupItems(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n')
  const body = lines.slice(lines.indexOf(heading) + 1)
  const end = body.indexOf('')
  return end === -1 ? body : body.slice(0, end)
}

describe('buildReleaseNoteMarkdown', () => {
  it('데이터가 모두 있는 릴리스를 헤더·메타·유형별 목록 순으로 내보낸다', () => {
    const markdown = buildReleaseNoteMarkdown(
      note({
        version_name: 'v4.162.0',
        description: '검색 개편과 사스테이닝 수정',
        released: 1,
        release_date: '2026-09-01',
        items: [
          item({ id: 1, issue_key: 'ICA-8678', issue_type: 'Story', summary: '검색홈 개편', sort_order: 0 }),
          item({
            id: 2,
            issue_key: 'ICA-8679',
            issue_type: 'Sub-task',
            summary: '검색 필터 UI',
            parent_key: 'ICA-8678',
            sort_order: 1
          }),
          item({ id: 3, issue_key: 'ICA-8681', issue_type: 'Bug', summary: '필터 오작동 수정', sort_order: 2 })
        ]
      })
    )

    expect(markdown).toBe(
      [
        '# v4.162.0',
        '',
        '> 검색 개편과 사스테이닝 수정',
        '',
        '- **릴리스일**: 2026-09-01',
        '- **상태**: 출시됨',
        '- **Jira**: ICA',
        '',
        '## Story',
        '- [ICA-8678] 검색홈 개편',
        '  - [ICA-8679] 검색 필터 UI',
        '',
        '## Bug',
        '- [ICA-8681] 필터 오작동 수정'
      ].join('\n')
    )
  })

  it('그룹 순서는 sort_order 안에서 유형이 처음 등장한 순서를 따른다', () => {
    const markdown = buildReleaseNoteMarkdown(
      note({
        items: [
          item({ id: 1, issue_key: 'ICA-3', issue_type: 'Bug', summary: 'b1', sort_order: 2 }),
          item({ id: 2, issue_key: 'ICA-1', issue_type: 'Task', summary: 't1', sort_order: 0 }),
          item({ id: 3, issue_key: 'ICA-4', issue_type: 'Task', summary: 't2', sort_order: 3 }),
          item({ id: 4, issue_key: 'ICA-2', issue_type: 'Story', summary: 's1', sort_order: 1 })
        ]
      })
    )
    expect(groupHeadings(markdown)).toEqual(['## Task', '## Story', '## Bug'])
    // 같은 유형의 항목은 한 그룹으로 모인다
    expect(groupItems(markdown, '## Task')).toEqual(['- [ICA-1] t1', '- [ICA-4] t2'])
  })

  it('issue_type이 없으면 기타 그룹으로 모은다', () => {
    const markdown = buildReleaseNoteMarkdown(
      note({
        items: [
          item({ id: 1, issue_key: 'ICA-1', issue_type: null, summary: 'a', sort_order: 0 }),
          item({ id: 2, issue_key: 'ICA-2', issue_type: '   ', summary: 'b', sort_order: 1 })
        ]
      })
    )
    expect(groupHeadings(markdown)).toEqual(['## 기타'])
    expect(groupItems(markdown, '## 기타')).toEqual(['- [ICA-1] a', '- [ICA-2] b'])
  })

  it('하위 이슈는 자기 유형 그룹을 만들지 않고 부모 아래로 들여쓴다', () => {
    const markdown = buildReleaseNoteMarkdown(
      note({
        items: [
          item({ id: 1, issue_key: 'ICA-1', issue_type: 'Story', summary: '상위', sort_order: 0 }),
          item({
            id: 2,
            issue_key: 'ICA-3',
            issue_type: 'Sub-task',
            summary: '하위 2',
            parent_key: 'ICA-1',
            sort_order: 2
          }),
          item({
            id: 3,
            issue_key: 'ICA-2',
            issue_type: 'Sub-task',
            summary: '하위 1',
            parent_key: 'ICA-1',
            sort_order: 1
          })
        ]
      })
    )
    expect(groupHeadings(markdown)).toEqual(['## Story'])
    expect(groupItems(markdown, '## Story')).toEqual([
      '- [ICA-1] 상위',
      '  - [ICA-2] 하위 1',
      '  - [ICA-3] 하위 2'
    ])
  })

  it('부모가 릴리스에 없는 하위 이슈는 최상위로 표시한다', () => {
    // 상위 에픽이 다른 릴리스에 붙어 있는 경우 — 누락되면 안 된다
    const markdown = buildReleaseNoteMarkdown(
      note({
        items: [
          item({
            id: 1,
            issue_key: 'ICA-9',
            issue_type: 'Story',
            summary: '고아 스토리',
            parent_key: 'ICA-1000',
            sort_order: 0
          }),
          item({ id: 2, issue_key: 'ICA-10', issue_type: 'Bug', summary: '버그', sort_order: 1 })
        ]
      })
    )
    expect(groupHeadings(markdown)).toEqual(['## Story', '## Bug'])
    expect(groupItems(markdown, '## Story')).toEqual(['- [ICA-9] 고아 스토리'])
    expect(markdown).not.toContain('  - [ICA-9]')
  })

  it('자기 자신을 부모로 가리켜도 최상위로 한 번만 표시한다', () => {
    const markdown = buildReleaseNoteMarkdown(
      note({
        items: [
          item({ id: 1, issue_key: 'ICA-1', issue_type: 'Bug', summary: '자기 참조', parent_key: 'ICA-1' })
        ]
      })
    )
    expect(groupItems(markdown, '## Bug')).toEqual(['- [ICA-1] 자기 참조'])
  })

  it('항목이 없으면 안내 문구만 남는다', () => {
    const markdown = buildReleaseNoteMarkdown(note({ items: [] }))
    expect(markdown).toBe(
      [
        '# v4.162.0',
        '',
        '- **상태**: 미출시',
        '- **Jira**: ICA',
        '',
        '_릴리스에 포함된 이슈가 없습니다._'
      ].join('\n')
    )
    expect(groupHeadings(markdown)).toEqual([])
  })

  it('description과 release_date가 없으면 해당 줄이 아예 빠진다', () => {
    const markdown = buildReleaseNoteMarkdown(
      note({
        description: null,
        release_date: null,
        items: [item({ issue_key: 'ICA-1', summary: 'a' })]
      })
    )
    expect(markdown.split('\n').slice(0, 4)).toEqual([
      '# v4.162.0',
      '',
      '- **상태**: 미출시',
      '- **Jira**: ICA'
    ])
    expect(markdown).not.toContain('>')
    expect(markdown).not.toContain('릴리스일')
  })

  it('빈 문자열 description은 인용구를 만들지 않는다', () => {
    const markdown = buildReleaseNoteMarkdown(note({ description: '  \n ' }))
    expect(markdown).not.toContain('>')
  })

  it('여러 줄 description과 제목은 한 줄로 접는다', () => {
    const markdown = buildReleaseNoteMarkdown(
      note({
        description: '첫 줄\n둘째 줄',
        items: [item({ issue_key: 'ICA-1', summary: '두 줄\n제목' })]
      })
    )
    expect(markdown).toContain('> 첫 줄 둘째 줄')
    expect(markdown).toContain('- [ICA-1] 두 줄 제목')
  })

  it('released 플래그를 한국어 상태로 바꾼다', () => {
    expect(buildReleaseNoteMarkdown(note({ released: 1 }))).toContain('- **상태**: 출시됨')
    expect(buildReleaseNoteMarkdown(note({ released: 0 }))).toContain('- **상태**: 미출시')
  })

  it('프로젝트명이 비면 버전 이름만 제목으로 쓴다', () => {
    expect(buildReleaseNoteMarkdown(note({ version_name: 'v1.0.0' })).split('\n')[0]).toBe(
      '# v1.0.0'
    )
  })
})
