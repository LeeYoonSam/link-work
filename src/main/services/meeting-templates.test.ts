import { describe, expect, it } from 'vitest'
import {
  AUTO_TEMPLATE_OUTPUT_KEYS,
  DEFAULT_MEETING_TITLE,
  MEETING_OUTPUT_KEYS,
  MEETING_TEMPLATES,
  buildOutputKeys,
  buildTemplateBlock,
  buildTemplateSelectionBlock,
  getTemplate,
  isTemplateId,
  listTemplateOptions,
  resolveTemplatePlan
} from './meeting-templates'

describe('resolveTemplatePlan', () => {
  type Expected = 'auto' | { source: 'manual' | 'title'; id: string }
  it.each([
    ['standup', '형태 윤삼 1on1', false, { source: 'manual', id: 'standup' }],
    ['default', '형태 윤삼 1on1', false, { source: 'manual', id: 'default' }],
    ['default', '스프린트 회고', true, { source: 'manual', id: 'default' }],
    [null, '형태 윤삼 1on1', false, { source: 'title', id: 'one_on_one' }],
    [null, '형태 윤삼 1on1', true, 'auto'],
    [null, '제목 없는 회의', false, 'auto'],
    [null, '브랜드 키워드 광고 - 스크럼', false, { source: 'title', id: 'standup' }],
    [null, '혜택 탭 UX 리뷰', false, { source: 'title', id: 'review' }],
    [null, '혜탭 탭 API 논의', false, 'auto'],
    ['bogus', '', false, 'auto'],
    [undefined, null, false, 'auto']
  ] as Array<[string | null | undefined, string | null, boolean, Expected]>)(
    'explicit=%s, title=%s, titleAuto=%s',
    (explicit, title, titleAuto, expected) => {
      const plan = resolveTemplatePlan({ explicit, title, titleAuto })
      if (expected === 'auto') {
        expect(plan).toEqual({ mode: 'auto' })
        return
      }
      expect(plan.mode).toBe('fixed')
      if (plan.mode !== 'fixed') return
      expect(plan.source).toBe(expected.source)
      expect(plan.template.id).toBe(expected.id)
      if (expected.source === 'manual') expect(plan.reason).toBeNull()
    }
  )

  it('제목 판별은 맞은 부분을 이유로 남긴다', () => {
    const plan = resolveTemplatePlan({ explicit: null, title: '형태 윤삼 1on1', titleAuto: false })
    expect(plan.mode === 'fixed' && plan.reason).toBe('제목의 "1on1"')
  })

  it('기본 제목 상수', () => {
    expect(DEFAULT_MEETING_TITLE).toBe('제목 없는 회의')
  })
})

describe('buildTemplateSelectionBlock', () => {
  it('4개 형식 id·선택 기준과 비기본 형식의 목적·주제 후보를 담는다', () => {
    const block = buildTemplateSelectionBlock()
    const lines = block.split('\n')
    expect(lines[0]).toBe('[회의 형식 고르기]')
    for (const t of MEETING_TEMPLATES) {
      expect(block).toContain(`- ${t.id}(${t.name}): ${t.selectHint}`)
      if (t.id === 'default') continue
      expect(block).toContain(t.purpose)
      for (const title of t.topicTitles) expect(block).toContain(title)
    }
    expect(block).toContain('출력 키 힌트: tldr — 상대의 현재 상태와 핵심 약속 중심; action_items — 양쪽이 한 약속 모두')
    expect(lines[lines.length - 1]).toBe('JSON은 template_id와 template_reason을 맨 앞에 쓰세요.')
  })

  it('자동 선택 출력 키는 template_id·template_reason 두 줄이다', () => {
    const lines = AUTO_TEMPLATE_OUTPUT_KEYS.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0].startsWith('- template_id(string):')).toBe(true)
    expect(lines[1].startsWith('- template_reason(string):')).toBe(true)
  })
})

describe('MEETING_OUTPUT_KEYS', () => {
  it('둘째 줄이 title 키다', () => {
    expect(MEETING_OUTPUT_KEYS.split('\n')[1].startsWith('- title(string):')).toBe(true)
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
