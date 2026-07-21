import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import MarkdownContent from './MarkdownContent'

// react-markdown 트리를 정적 HTML로 렌더해 실제 출력 문자열을 검증한다.
// (jsdom 없이 react-dom/server만으로 동작)
function render(props: Parameters<typeof MarkdownContent>[0]): string {
  return renderToStaticMarkup(<MarkdownContent {...props} />)
}

// Google Calendar description 실제 형태(스크린샷 재현)
const CALENDAR_HTML =
  '<ul><li>PRD : <a href="https://docs.google.com/document/d/PRD_ID/edit">[작가] 브랜드 광고</a></li>' +
  '<li>자동입찰 정책 : https://docs.google.com/document/d/BID_ID/edit?usp=sharing</li>' +
  '<li>Figma (구매자) : TBU </li>' +
  '<li>WBS : </li></ul>'

describe('MarkdownContent allowHtml (캘린더 description)', () => {
  it('<ul>/<li> 블록 HTML을 실제 리스트로 렌더한다 (raw 태그 노출 없음)', () => {
    const html = render({ content: CALENDAR_HTML, allowHtml: true })
    // 리스트 요소가 실제로 생성됨
    expect(html).toContain('<ul')
    expect(html).toContain('<li')
    // 이스케이프된 raw 태그가 그대로 노출되지 않음
    expect(html).not.toContain('&lt;ul&gt;')
    expect(html).not.toContain('&lt;li&gt;')
    // 리스트 항목 텍스트가 보존됨
    expect(html).toContain('PRD :')
    expect(html).toContain('WBS :')
  })

  it('HTML 내부의 <a href> 앵커를 링크로 렌더한다', () => {
    const html = render({ content: CALENDAR_HTML, allowHtml: true })
    expect(html).toContain('href="https://docs.google.com/document/d/PRD_ID/edit"')
    expect(html).toContain('[작가] 브랜드 광고')
  })

  it('HTML 내부의 맨 URL(앵커로 안 감싼)도 클릭 가능한 링크로 변환한다', () => {
    const html = render({ content: CALENDAR_HTML, allowHtml: true })
    expect(html).toContain('href="https://docs.google.com/document/d/BID_ID/edit?usp=sharing"')
  })

  it('이미 <a>로 감싼 URL은 이중으로 링크화하지 않는다', () => {
    const html = render({ content: CALENDAR_HTML, allowHtml: true })
    // PRD_ID 링크가 하나만 존재해야 함
    const matches = html.match(/https:\/\/docs\.google\.com\/document\/d\/PRD_ID\/edit/g) || []
    // href 속성 + (앵커 텍스트는 "[작가]..."라 URL 텍스트 중복 없음) => 1회
    expect(matches.length).toBe(1)
  })
})

describe('MarkdownContent allowHtml — 마크다운도 함께 동작', () => {
  it('마크다운 리스트를 렌더한다', () => {
    const html = render({ content: '- 첫째\n- 둘째', allowHtml: true })
    expect(html).toContain('<ul')
    expect(html).toContain('첫째')
    expect(html).toContain('둘째')
  })

  it('마크다운 볼드/링크를 렌더한다', () => {
    const html = render({ content: '**굵게** 그리고 [링크](https://example.com)', allowHtml: true })
    expect(html).toContain('<strong')
    expect(html).toContain('href="https://example.com"')
  })

  it('마크다운 텍스트의 맨 URL을 자동 링크화한다 (remark-gfm)', () => {
    const html = render({ content: '방문: https://example.com/page', allowHtml: true })
    expect(html).toContain('href="https://example.com/page"')
  })
})

describe('MarkdownContent allowHtml — 보안(sanitize)', () => {
  it('<script> 태그를 제거한다', () => {
    const html = render({ content: '<p>안전</p><script>alert(1)</script>', allowHtml: true })
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('javascript: 프로토콜 href를 제거한다', () => {
    const html = render({ content: '<a href="javascript:alert(1)">클릭</a>', allowHtml: true })
    expect(html).not.toContain('javascript:')
  })

  it('이벤트 핸들러 속성(onerror 등)을 제거한다', () => {
    const html = render({ content: '<img src="x" onerror="alert(1)">', allowHtml: true })
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
  })
})

describe('MarkdownContent allowHtml — 실제 Google Calendar HTML 특성', () => {
  it('<html-blob> 래퍼를 벗겨내고 내용을 보존한다', () => {
    const html = render({
      content: '<html-blob><ul><li>항목 A</li><li>항목 B</li></ul></html-blob>',
      allowHtml: true
    })
    expect(html).toContain('항목 A')
    expect(html).toContain('항목 B')
    expect(html).toContain('<ul')
    expect(html).not.toContain('html-blob')
  })

  it('래퍼 제거로 생긴 빈 문단을 남기지 않는다', () => {
    const html = render({
      content: '<html-blob><ul><li>항목</li></ul></html-blob>',
      allowHtml: true
    })
    // 빈 <p ...></p> 가 없어야 접힘 미리보기가 낭비되지 않음
    expect(html).not.toMatch(/<p[^>]*><\/p>/)
  })

  it('HTML 엔티티를 디코딩한다 (&nbsp; → U+00A0, &amp; → &)', () => {
    const html = render({ content: '<ul><li>A&nbsp;&amp;&nbsp;B</li></ul>', allowHtml: true })
    // &nbsp;는 비분리 공백 문자로, &amp;는 & 로 디코딩된다(출력 시 다시 이스케이프)
    expect(html).toContain('A\u00A0&amp;\u00A0B')
    // 엔티티가 날것으로 노출되지 않음
    expect(html).not.toContain('&amp;nbsp;')
  })

  it('<br> 을 줄바꿈으로 렌더한다', () => {
    const html = render({ content: '첫째<br>둘째', allowHtml: true })
    expect(html).toContain('<br/>')
  })

  it('<u>/<b>/<i> 인라인 서식을 보존한다', () => {
    const html = render({ content: '<b>굵게</b> <u>밑줄</u> <i>기울임</i>', allowHtml: true })
    expect(html).toContain('<b>굵게</b>')
    expect(html).toContain('<u>밑줄</u>')
    expect(html).toContain('<i>기울임</i>')
  })

  it('중첩 리스트를 보존한다', () => {
    const html = render({ content: '<ul><li>부모<ul><li>자식</li></ul></li></ul>', allowHtml: true })
    expect(html).toContain('부모')
    expect(html).toContain('자식')
    expect((html.match(/<ul/g) || []).length).toBe(2)
  })
})

describe('MarkdownContent — 기본(allowHtml=false)에서는 raw HTML을 렌더하지 않음', () => {
  it('allowHtml 미지정 시 <ul> 태그가 스타일된 리스트로 렌더되지 않는다', () => {
    const html = render({ content: CALENDAR_HTML })
    // list-disc(우리 ul 컴포넌트 스타일)가 적용된 실제 리스트가 생기지 않아야 함
    expect(html).not.toContain('list-disc')
  })
})
