import { describe, expect, it } from 'vitest'
import {
  MEETING_OUTPUT_KEYS,
  MEETING_TEMPLATES,
  buildOutputKeys,
  buildTemplateBlock,
  getTemplate,
  isTemplateId,
  listTemplateOptions,
  resolveTemplate
} from './meeting-templates'

describe('resolveTemplate', () => {
  it.each([
    [null, '제목 없는 회의', 'default'],
    [null, '제목 없는 면접', 'default'],
    [undefined, '주간 1:1 김OO', 'one_on_one'],
    [null, '1 on 1 미팅', 'one_on_one'],
    [null, 'Daily standup', 'standup'],
    [null, '스프린트 회고', 'review'],
    [null, '코드 리뷰', 'review'],
    ['standup', '1:1', 'standup'],
    ['default', '스프린트 회고', 'default'],
    ['bogus', '회고', 'review'],
    [null, '', 'default'],
    [null, null, 'default'],
    [null, '주간 회의', 'default']
  ] as const)('explicit=%s, title=%s → %s', (explicit, title, expected) => {
    expect(resolveTemplate(explicit, title).id).toBe(expected)
  })
})

describe('buildOutputKeys', () => {
  it('default는 MEETING_OUTPUT_KEYS 그대로', () => {
    expect(buildOutputKeys(getTemplate('default'))).toBe(MEETING_OUTPUT_KEYS)
  })

  it('one_on_one은 키 줄 묶음 바로 뒤에 힌트를 넣고 개수 문구를 유지한다', () => {
    const out = buildOutputKeys(getTemplate('one_on_one'))
    const lines = out.split('\n')
    const ai = lines.findIndex((l) => l.startsWith('- action_items:'))
    expect(ai).toBeGreaterThan(-1)
    expect(lines[ai + 1]).toBe('  - 이 회의 유형: 양쪽이 한 약속 모두')
    const tl = lines.findIndex((l) => l.startsWith('- tldr('))
    expect(lines[tl + 1]).toBe('  - 이 회의 유형: 상대의 현재 상태와 핵심 약속 중심')
    expect(out).toContain('3~8개')
    // 힌트 두 줄만 늘었다
    expect(lines.length).toBe(MEETING_OUTPUT_KEYS.split('\n').length + 2)
  })

  it('topics처럼 하위 줄이 있는 키는 하위 줄 묶음이 끝난 뒤에 넣는다', () => {
    const out = buildOutputKeys({ ...getTemplate('default'), keyHints: { topics: '힌트' } })
    const lines = out.split('\n')
    const start = lines.findIndex((l) => l.startsWith('- topics:'))
    const hint = lines.indexOf('  - 이 회의 유형: 힌트')
    expect(hint).toBeGreaterThan(start)
    expect(lines[hint - 1]).toBe('  - start 오름차순으로 나열하세요.')
    expect(lines[hint + 1].startsWith('- decisions:')).toBe(true)
  })

  it('standup·review 힌트', () => {
    expect(buildOutputKeys(getTemplate('standup'))).toContain(
      '  - 이 회의 유형: 블로커 중 해결 담당이 정해지지 않은 것'
    )
    expect(buildOutputKeys(getTemplate('review'))).toContain('  - 이 회의 유형: 승인·반려·보류 판정을 명시')
  })
})

describe('buildTemplateBlock', () => {
  it('default는 빈 문자열', () => {
    expect(buildTemplateBlock(getTemplate('default'))).toBe('')
  })

  it('목적과 주제 이름 후보를 담는다', () => {
    const block = buildTemplateBlock(getTemplate('standup'))
    expect(block).toBe(
      '[회의 형식]\n짧은 진행 공유 회의(스탠드업)입니다. 사람별 지난 진행, 오늘 할 일, 블로커를 중심으로 정리하세요.\n' +
        'topics의 title은 가능하면 다음 이름 중 실제로 다뤄진 것만 그대로 쓰세요: 지난 진행, 오늘 할 일, 블로커. 다뤄지지 않은 이름은 만들지 마세요. 목록에 없는 논의는 자유 제목으로 추가하세요.'
    )
  })
})

describe('isTemplateId·listTemplateOptions', () => {
  it('isTemplateId', () => {
    for (const id of ['default', 'one_on_one', 'standup', 'review']) expect(isTemplateId(id)).toBe(true)
    for (const v of ['bogus', '', null, undefined, 1]) expect(isTemplateId(v)).toBe(false)
  })

  it('목록은 정의 순서', () => {
    expect(listTemplateOptions()).toEqual([
      { id: 'default', name: '기본' },
      { id: 'one_on_one', name: '1:1' },
      { id: 'standup', name: '스탠드업' },
      { id: 'review', name: '리뷰·회고' }
    ])
    expect(MEETING_TEMPLATES.map((t) => t.id)).toEqual(['default', 'one_on_one', 'standup', 'review'])
  })
})
