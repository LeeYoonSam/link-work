import { describe, expect, it } from 'vitest'
import { resolveOpenTarget } from './open-target'

describe('resolveOpenTarget — 링크', () => {
  it.each([
    'https://example.atlassian.net/browse/ABC-1',
    'http://localhost:3000/docs',
    'mailto:someone@example.com'
  ])('허용: %s', (url) => {
    const result = resolveOpenTarget(url, 'link')
    expect(result).toMatchObject({ ok: true, kind: 'external' })
  })

  it('앞뒤 공백은 정리해서 연다', () => {
    expect(resolveOpenTarget('  https://example.com/a  ', 'link')).toEqual({
      ok: true,
      kind: 'external',
      target: 'https://example.com/a'
    })
  })

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'notion://www.notion.so/page',
    'x-apple.systempreferences:com.apple.preference.security',
    'smb://server/share',
    'example.com/no-scheme',
    '/Users/me/doc.pdf',
    ''
  ])('거부: %s', (url) => {
    expect(resolveOpenTarget(url, 'link').ok).toBe(false)
  })

  it('type이 없거나 알 수 없으면 링크 규칙을 적용한다', () => {
    expect(resolveOpenTarget('file:///etc/passwd', undefined).ok).toBe(false)
    expect(resolveOpenTarget('https://example.com', 'weird').ok).toBe(true)
  })

  it('문자열이 아닌 값은 거부한다', () => {
    expect(resolveOpenTarget(42, 'link').ok).toBe(false)
    expect(resolveOpenTarget(null, 'file').ok).toBe(false)
  })
})

describe('resolveOpenTarget — 파일', () => {
  it.each([
    '/Users/me/Documents/spec.pdf',
    '/Users/me/Documents/회의록.docx',
    '/Users/me/Documents/project folder',
    '/Users/me/Documents/project folder/',
    '/Volumes/share/설계서.xlsx',
    '/Users/me/Downloads/installer.dmg'
  ])('허용: %s', (path) => {
    expect(resolveOpenTarget(path, 'file')).toEqual({ ok: true, kind: 'path', target: path })
  })

  it('file:// URL은 경로로 바꿔 연다', () => {
    expect(resolveOpenTarget('file:///Users/me/My%20Doc.pdf', 'file')).toEqual({
      ok: true,
      kind: 'path',
      target: '/Users/me/My Doc.pdf'
    })
  })

  it.each([
    ['상대경로', 'Documents/spec.pdf'],
    ['홈 축약', '~/Documents/spec.pdf'],
    ['smb 스킴', 'smb://server/share/doc.pdf'],
    ['http 스킴', 'https://example.com/doc.pdf'],
    ['javascript 스킴', 'javascript:alert(1)'],
    ['원격 호스트 file URL', 'file://server/share/doc.pdf'],
    ['앱 번들', '/Applications/Calculator.app'],
    ['앱 번들(끝 슬래시)', '/Applications/Calculator.app/'],
    ['앱 번들 내부 실행 파일', '/Applications/Calculator.app/Contents/MacOS/Calculator'],
    ['대문자 확장자', '/Users/me/Downloads/RUN.COMMAND'],
    ['셸 스크립트', '/Users/me/Downloads/setup.sh'],
    ['터미널 설정', '/Users/me/Downloads/evil.terminal'],
    ['설치 패키지', '/Users/me/Downloads/tool.pkg'],
    ['애플스크립트', '/Users/me/Downloads/a.scpt'],
    ['오토메이터', '/Users/me/Downloads/a.workflow'],
    ['인터넷 위치 파일', '/Users/me/Downloads/link.webloc'],
    ['AFP 위치 파일', '/Users/me/Downloads/server.afploc'],
    ['FTP 위치 파일', '/Users/me/Downloads/server.ftploc'],
    ['화면 보호기', '/Users/me/Downloads/evil.saver'],
    ['구성 프로파일', '/Users/me/Downloads/profile.mobileconfig'],
    ['단축어', '/Users/me/Downloads/run.shortcut'],
    ['NUL 문자', '/Users/me/doc.pdf\0.app'],
    ['빈 값', '   ']
  ])('거부: %s', (_label, path) => {
    expect(resolveOpenTarget(path, 'file').ok).toBe(false)
  })
})
