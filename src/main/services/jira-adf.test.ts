import { describe, expect, it } from 'vitest'
import { adfToPlainText, extractAdfLinks, guessLinkName } from './jira-adf'

const text = (t: string): unknown => ({ type: 'text', text: t })
const para = (...content: unknown[]): unknown => ({ type: 'paragraph', content })

describe('adfToPlainText', () => {
  it('문단을 줄로 펼치고 비어 있으면 null', () => {
    const doc = {
      type: 'doc',
      content: [
        para(text('알림센터를 개편한다.')),
        para(text('기획서 / 디자인 '), {
          type: 'inlineCard',
          attrs: { url: 'https://www.figma.com/design/abc123/Notice' }
        })
      ]
    }
    const out = adfToPlainText(doc)
    expect(out?.split('\n')[0]).toBe('알림센터를 개편한다.')
    expect(out).toContain('기획서 / 디자인 https://www.figma.com/design/abc123/Notice')
    expect(adfToPlainText(null)).toBeNull()
    expect(adfToPlainText({ type: 'doc', content: [{ type: 'paragraph', content: [] }] })).toBeNull()
  })

  it('목록은 - 머리표로 펼친다', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [para(text('하나'))] },
            { type: 'listItem', content: [para(text('둘'))] }
          ]
        }
      ]
    }
    expect(adfToPlainText(doc)).toBe('- 하나\n- 둘')
  })

  it('문자열은 그대로 다듬어 돌려준다', () => {
    expect(adfToPlainText('  평문 설명 ')).toBe('평문 설명')
    expect(adfToPlainText('   ')).toBeNull()
  })
})

describe('extractAdfLinks·guessLinkName', () => {
  it('http(s) 링크만 모으고 링크 텍스트가 URL이면 호스트로 이름을 추정한다', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'https://www.notion.so/p',
              marks: [{ type: 'link', attrs: { href: 'https://www.notion.so/p' } }]
            },
            {
              type: 'text',
              text: '나쁜 링크',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]
            },
            { type: 'text', text: '기획서', marks: [{ type: 'link', attrs: { href: 'https://docs.google.com/d/1' } }] },
            { type: 'blockCard', attrs: { url: 'https://example.com/a' } },
            { type: 'text', text: '중복 https://example.com/a' }
          ]
        }
      ]
    }
    expect(extractAdfLinks(doc)).toEqual([
      { name: 'Notion 문서', url: 'https://www.notion.so/p' },
      { name: '기획서', url: 'https://docs.google.com/d/1' },
      { name: 'example.com', url: 'https://example.com/a' }
    ])
    expect(extractAdfLinks(null)).toEqual([])
    expect(extractAdfLinks('https://plain.example')).toEqual([])
  })

  it('URL 안에서 짝이 맞는 괄호는 포함하고 짝 없는 끝 괄호·문장부호만 뗀다', () => {
    const doc = {
      type: 'doc',
      content: [
        para(text('참고 https://ko.wikipedia.org/wiki/Foo_(bar). 그리고 (https://example.com/a), 끝'))
      ]
    }
    expect(extractAdfLinks(doc).map((l) => l.url)).toEqual([
      'https://ko.wikipedia.org/wiki/Foo_(bar)',
      'https://example.com/a'
    ])
  })

  it('guessLinkName 은 호스트로 출처를 추정한다', () => {
    const site = 'https://acme.atlassian.net'
    expect(guessLinkName(`${site}/browse/PROJ-1`)).toBe('Jira 티켓 (PROJ-1)')
    expect(guessLinkName(`${site}/wiki/spaces/X/pages/1`)).toBe('Confluence')
    expect(guessLinkName('https://www.figma.com/design/abc')).toBe('Figma')
    expect(guessLinkName('https://acme.notion.site/p')).toBe('Notion 문서')
    expect(guessLinkName('https://www.example.com/x')).toBe('example.com')
    expect(guessLinkName('엉망')).toBe('엉망')
  })
})
