import { describe, expect, it } from 'vitest'
import { adfToPlainText } from './jira-adf'

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
