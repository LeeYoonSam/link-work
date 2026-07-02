import { describe, expect, it } from 'vitest'
import {
  blocksToMarkdown,
  extractNotionPageId,
  extractPageTitle,
  richTextToMarkdown,
  type NotionBlock
} from './notion-markdown'

const rt = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  plain_text: text,
  ...extra
})

describe('extractNotionPageId', () => {
  it('notion.so URL 끝의 32자리 hex를 UUID로 변환한다', () => {
    expect(
      extractNotionPageId(
        'https://www.notion.so/workspace/My-Page-0123456789abcdef0123456789abcdef'
      )
    ).toBe('01234567-89ab-cdef-0123-456789abcdef')
  })

  it('쿼리스트링이 붙은 URL도 처리한다', () => {
    expect(
      extractNotionPageId('https://www.notion.so/제목-0123456789abcdef0123456789abcdef?pvs=4')
    ).toBe('01234567-89ab-cdef-0123-456789abcdef')
  })

  it('notion.site 도메인도 지원한다', () => {
    expect(
      extractNotionPageId('https://acme.notion.site/Doc-0123456789abcdef0123456789abcdef')
    ).toBe('01234567-89ab-cdef-0123-456789abcdef')
  })

  it('bare ID(하이픈 유무 모두)를 받아들인다', () => {
    expect(extractNotionPageId('0123456789abcdef0123456789abcdef')).toBe(
      '01234567-89ab-cdef-0123-456789abcdef'
    )
    expect(extractNotionPageId('01234567-89ab-cdef-0123-456789abcdef')).toBe(
      '01234567-89ab-cdef-0123-456789abcdef'
    )
  })

  it('Notion이 아닌 URL과 비정상 입력은 null', () => {
    expect(extractNotionPageId('https://example.com/0123456789abcdef0123456789abcdef')).toBeNull()
    expect(extractNotionPageId('그냥 텍스트')).toBeNull()
    expect(extractNotionPageId('https://www.notion.so/짧은-id-1234')).toBeNull()
  })
})

describe('richTextToMarkdown', () => {
  it('주석(annotation)을 마크다운으로 변환한다', () => {
    expect(
      richTextToMarkdown([
        rt('굵게', { annotations: { bold: true } }),
        rt(' 그리고 '),
        rt('코드', { annotations: { code: true } })
      ])
    ).toBe('**굵게** 그리고 `코드`')
  })

  it('링크를 마크다운 링크로 변환한다', () => {
    expect(richTextToMarkdown([rt('문서', { href: 'https://example.com' })])).toBe(
      '[문서](https://example.com)'
    )
  })

  it('빈 입력은 빈 문자열', () => {
    expect(richTextToMarkdown(undefined)).toBe('')
    expect(richTextToMarkdown([])).toBe('')
  })
})

const block = (type: string, data: Record<string, unknown>, children?: NotionBlock[]): NotionBlock =>
  ({ id: `id-${type}`, type, [type]: data, ...(children ? { children, has_children: true } : {}) }) as NotionBlock

describe('blocksToMarkdown', () => {
  it('제목/문단/리스트를 변환한다', () => {
    const md = blocksToMarkdown([
      block('heading_1', { rich_text: [rt('제목')] }),
      block('paragraph', { rich_text: [rt('본문')] }),
      block('bulleted_list_item', { rich_text: [rt('항목1')] }),
      block('numbered_list_item', { rich_text: [rt('첫째')] }),
      block('numbered_list_item', { rich_text: [rt('둘째')] })
    ])
    expect(md).toBe('# 제목\n본문\n- 항목1\n1. 첫째\n2. 둘째')
  })

  it('번호 리스트는 다른 블록이 끼면 번호가 초기화된다', () => {
    const md = blocksToMarkdown([
      block('numbered_list_item', { rich_text: [rt('하나')] }),
      block('paragraph', { rich_text: [rt('중간')] }),
      block('numbered_list_item', { rich_text: [rt('다시 하나')] })
    ])
    expect(md).toBe('1. 하나\n중간\n1. 다시 하나')
  })

  it('to_do 체크 상태를 표시한다', () => {
    const md = blocksToMarkdown([
      block('to_do', { rich_text: [rt('할 일')], checked: false }),
      block('to_do', { rich_text: [rt('끝난 일')], checked: true })
    ])
    expect(md).toBe('- [ ] 할 일\n- [x] 끝난 일')
  })

  it('중첩 리스트는 들여쓰기된다', () => {
    const md = blocksToMarkdown([
      block('bulleted_list_item', { rich_text: [rt('부모')] }, [
        block('bulleted_list_item', { rich_text: [rt('자식')] })
      ])
    ])
    expect(md).toBe('- 부모\n  - 자식')
  })

  it('코드 블록은 언어와 함께 fenced code로 변환한다', () => {
    const md = blocksToMarkdown([
      block('code', { rich_text: [rt('const a = 1')], language: 'typescript' })
    ])
    expect(md).toBe('```typescript\nconst a = 1\n```')
  })

  it('표는 마크다운 표로 변환한다 (구분행 포함)', () => {
    const md = blocksToMarkdown([
      block('table', { has_column_header: true }, [
        block('table_row', { cells: [[rt('이름')], [rt('값')]] }),
        block('table_row', { cells: [[rt('a')], [rt('1|2')]] })
      ])
    ])
    expect(md).toBe('| 이름 | 값 |\n| --- | --- |\n| a | 1\\|2 |')
  })

  it('child_page는 링크 안내로만 표시한다', () => {
    const md = blocksToMarkdown([block('child_page', { title: '하위 문서' })])
    expect(md).toContain('하위 페이지: 하위 문서')
  })

  it('미지원 블록은 표시를 남긴다', () => {
    const md = blocksToMarkdown([block('video', { external: { url: 'x' } })])
    expect(md).toBe('[미지원 블록: video]')
  })
})

describe('extractPageTitle', () => {
  it('title 타입 프로퍼티에서 제목을 찾는다', () => {
    expect(
      extractPageTitle({
        Name: { type: 'title', title: [{ plain_text: '문서 ' }, { plain_text: '제목' }] },
        Status: { type: 'select' }
      })
    ).toBe('문서 제목')
  })

  it('제목이 없으면 대체 텍스트', () => {
    expect(extractPageTitle(undefined)).toBe('(제목 없음)')
    expect(extractPageTitle({ Name: { type: 'title', title: [] } })).toBe('(제목 없음)')
  })
})
