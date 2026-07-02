import { describe, expect, it } from 'vitest'
import { extractHtmlTitle, getUrlBlockReason, htmlToText } from './web-fetch'

describe('getUrlBlockReason', () => {
  it('공개 http/https URL은 통과한다', () => {
    expect(getUrlBlockReason('https://example.com/page')).toBeNull()
    expect(getUrlBlockReason('http://docs.example.co.kr/a?b=1')).toBeNull()
    expect(getUrlBlockReason('https://8.8.8.8/x')).toBeNull()
  })

  it('http/https 외 스킴을 차단한다', () => {
    expect(getUrlBlockReason('file:///etc/passwd')).toContain('http/https')
    expect(getUrlBlockReason('ftp://example.com')).toContain('http/https')
    expect(getUrlBlockReason('javascript:alert(1)')).toContain('http/https')
  })

  it('로컬호스트/로컬 도메인을 차단한다', () => {
    expect(getUrlBlockReason('http://localhost:3000')).toContain('로컬')
    expect(getUrlBlockReason('http://app.localhost/x')).toContain('로컬')
    expect(getUrlBlockReason('http://printer.local')).toContain('로컬')
  })

  it('사설/루프백/링크로컬 IPv4를 차단한다', () => {
    for (const host of [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0'
    ]) {
      expect(getUrlBlockReason(`http://${host}/`), host).toContain('사설망')
    }
  })

  it('사설 대역이 아닌 IPv4는 통과한다', () => {
    expect(getUrlBlockReason('http://172.32.0.1/')).toBeNull()
    expect(getUrlBlockReason('http://100.128.0.1/')).toBeNull()
  })

  it('IPv6 루프백/ULA를 차단한다', () => {
    expect(getUrlBlockReason('http://[::1]/')).toContain('사설망')
    expect(getUrlBlockReason('http://[fe80::1]/')).toContain('사설망')
    expect(getUrlBlockReason('http://[fd00::1]/')).toContain('사설망')
  })

  it('인증 정보가 포함된 URL을 차단한다', () => {
    expect(getUrlBlockReason('https://user:pw@example.com/')).toContain('인증 정보')
  })

  it('URL 형식 오류를 알린다', () => {
    expect(getUrlBlockReason('not a url')).toContain('형식')
  })
})

describe('extractHtmlTitle', () => {
  it('title 태그에서 제목을 추출하고 엔티티를 디코드한다', () => {
    expect(extractHtmlTitle('<html><head><title>문서 &amp; 제목</title></head></html>')).toBe(
      '문서 & 제목'
    )
  })

  it('title이 없으면 null', () => {
    expect(extractHtmlTitle('<html><body>x</body></html>')).toBeNull()
  })
})

describe('htmlToText', () => {
  it('script/style을 제거하고 구조를 텍스트로 변환한다', () => {
    const html = `
      <html><head><style>.a{color:red}</style></head>
      <body>
        <script>alert(1)</script>
        <h1>제목</h1>
        <p>첫 문단</p>
        <ul><li>항목 A</li><li>항목 B</li></ul>
      </body></html>`
    const text = htmlToText(html)
    expect(text).toContain('# 제목')
    expect(text).toContain('첫 문단')
    expect(text).toContain('- 항목 A')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color:red')
  })

  it('링크를 마크다운 링크로 변환한다', () => {
    expect(htmlToText('<a href="https://example.com">예시</a>')).toBe('[예시](https://example.com)')
  })

  it('javascript: 링크는 텍스트만 남긴다', () => {
    expect(htmlToText('<a href="javascript:alert(1)">클릭</a>')).toBe('클릭')
  })

  it('HTML 엔티티를 디코드한다', () => {
    expect(htmlToText('A &lt; B &amp;&nbsp;C &#44608;')).toBe('A < B & C 김')
  })

  it('pre/code를 보존한다', () => {
    const text = htmlToText('<pre><code>const a = 1</code></pre>')
    expect(text).toContain('```')
    expect(text).toContain('const a = 1')
  })

  it('연속 개행과 공백을 정리한다', () => {
    const text = htmlToText('<p>하나</p>\n\n\n<div></div><div></div><p>둘   셋</p>')
    expect(text).toBe('하나\n\n둘 셋')
  })
})
