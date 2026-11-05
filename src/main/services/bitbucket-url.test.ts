import { describe, expect, it } from 'vitest'
import { isBitbucketUrl, parseBitbucketUrl } from './bitbucket-url'

describe('isBitbucketUrl', () => {
  it('bitbucket.org 와 www.bitbucket.org 만 true 다', () => {
    expect(isBitbucketUrl('https://bitbucket.org/ws/repo')).toBe(true)
    expect(isBitbucketUrl('https://www.bitbucket.org/ws/repo')).toBe(true)
    expect(isBitbucketUrl('https://BITBUCKET.org/ws/repo')).toBe(true)
  })

  it('다른 호스트와 형식이 틀린 URL 은 false 다', () => {
    expect(isBitbucketUrl('https://github.com/ws/repo')).toBe(false)
    expect(isBitbucketUrl('https://bitbucket.org.evil.example/ws/repo')).toBe(false)
    expect(isBitbucketUrl('https://evil.example/bitbucket.org/ws/repo')).toBe(false)
    expect(isBitbucketUrl('https://api.bitbucket.org/2.0/repositories/ws/repo')).toBe(false)
    expect(isBitbucketUrl('ftp://bitbucket.org/ws/repo')).toBe(false)
    expect(isBitbucketUrl('not a url')).toBe(false)
  })
})

describe('parseBitbucketUrl', () => {
  it('사용자 예시 URL 을 workspace·repo·ref·path 로 나눈다', () => {
    expect(
      parseBitbucketUrl(
        'https://bitbucket.org/backpackr/ios-ai-workspace/src/main/labs/gihyun/skills/client-log-query/SKILL.md'
      )
    ).toEqual({
      workspace: 'backpackr',
      repo: 'ios-ai-workspace',
      ref: 'main',
      path: 'labs/gihyun/skills/client-log-query/SKILL.md'
    })
  })

  it('저장소 루트는 ref null·path 빈 문자열이다', () => {
    const expected = { workspace: 'backpackr', repo: 'ios-ai-workspace', ref: null, path: '' }
    expect(parseBitbucketUrl('https://bitbucket.org/backpackr/ios-ai-workspace')).toEqual(expected)
    expect(parseBitbucketUrl('https://bitbucket.org/backpackr/ios-ai-workspace/')).toEqual(expected)
    expect(parseBitbucketUrl('https://bitbucket.org/backpackr/ios-ai-workspace/src')).toEqual(expected)
    expect(parseBitbucketUrl('https://bitbucket.org/backpackr/ios-ai-workspace/src/')).toEqual(expected)
    expect(parseBitbucketUrl('https://bitbucket.org/backpackr/ios-ai-workspace.git')).toEqual(expected)
  })

  it('ref 만 있으면 path 는 빈 문자열이다', () => {
    expect(parseBitbucketUrl('https://bitbucket.org/ws/repo/src/develop')).toEqual({
      workspace: 'ws',
      repo: 'repo',
      ref: 'develop',
      path: ''
    })
    expect(parseBitbucketUrl('https://bitbucket.org/ws/repo/src/develop/')).toMatchObject({
      ref: 'develop',
      path: ''
    })
  })

  it('폴더 URL 의 끝 슬래시를 지운다', () => {
    expect(parseBitbucketUrl('https://bitbucket.org/ws/repo/src/main/labs/skills/')).toMatchObject({
      ref: 'main',
      path: 'labs/skills'
    })
  })

  it('쿼리스트링과 #lines- 조각을 무시한다', () => {
    expect(
      parseBitbucketUrl('https://bitbucket.org/ws/repo/src/main/a/b.md?at=main#lines-10')
    ).toEqual({ workspace: 'ws', repo: 'repo', ref: 'main', path: 'a/b.md' })
    expect(
      parseBitbucketUrl('https://bitbucket.org/ws/repo/src/3f2a1b9/a/b.md?at=develop&fileviewer=x')
    ).toMatchObject({ ref: '3f2a1b9', path: 'a/b.md' })
  })

  it('?at= 값이 경로 앞부분과 맞으면 슬래시 브랜치를 ref 로 쓴다', () => {
    expect(
      parseBitbucketUrl('https://bitbucket.org/ws/repo/src/feature/login/docs/a.md?at=feature%2Flogin')
    ).toMatchObject({ ref: 'feature/login', path: 'docs/a.md' })
  })

  it('?at= 이 없으면 첫 세그먼트를 ref 로 본다', () => {
    expect(parseBitbucketUrl('https://bitbucket.org/ws/repo/src/feature/login/docs/a.md')).toMatchObject({
      ref: 'feature',
      path: 'login/docs/a.md'
    })
  })

  it('인코딩된 ref·path 를 디코딩한다', () => {
    expect(
      parseBitbucketUrl('https://bitbucket.org/ws/repo/src/feature%2Fx/%ED%95%9C%EA%B8%80/a%20b.md')
    ).toMatchObject({ ref: 'feature/x', path: '한글/a b.md' })
  })

  it('www 호스트와 /raw/ 형식을 지원한다', () => {
    expect(parseBitbucketUrl('https://www.bitbucket.org/ws/repo/raw/main/README.md')).toEqual({
      workspace: 'ws',
      repo: 'repo',
      ref: 'main',
      path: 'README.md'
    })
  })

  it('비 bitbucket 호스트는 null 이다', () => {
    expect(parseBitbucketUrl('https://github.com/ws/repo/src/main/a.md')).toBeNull()
    expect(parseBitbucketUrl('https://bitbucket.org.evil.example/ws/repo/src/main/a.md')).toBeNull()
    expect(parseBitbucketUrl('not a url')).toBeNull()
  })

  it('저장소 소스가 아닌 형식은 null 이다', () => {
    expect(parseBitbucketUrl('https://bitbucket.org/')).toBeNull()
    expect(parseBitbucketUrl('https://bitbucket.org/ws')).toBeNull()
    expect(parseBitbucketUrl('https://bitbucket.org/ws/repo/pull-requests/12')).toBeNull()
    expect(parseBitbucketUrl('https://bitbucket.org/ws/repo/browse/a.md')).toBeNull()
    expect(parseBitbucketUrl('https://bitbucket.org/ws/repo/commits/abc')).toBeNull()
  })

  it('경로 조작 세그먼트와 잘못된 슬러그는 null 이다', () => {
    // URL 파서가 %2E%2E 를 먼저 정규화한다. 그래서 src 구역을 벗어나면 형식 불일치로 null 이다.
    expect(parseBitbucketUrl('https://bitbucket.org/ws/repo/src/%2E%2E/a.md')).toBeNull()
    // 인코딩된 슬래시로 숨긴 '..' 는 디코딩 뒤 검사로 거부한다
    expect(parseBitbucketUrl('https://bitbucket.org/ws/repo/src/feature%2F..%2Fx/a.md')).toBeNull()
    expect(parseBitbucketUrl('https://bitbucket.org/ws/repo/src/main/a%2F..%2Fb')).toBeNull()
    expect(parseBitbucketUrl('https://bitbucket.org/w%3Fs/repo')).toBeNull()
    expect(parseBitbucketUrl('https://bitbucket.org/ws/%E0%A4%A')).toBeNull()
  })
})
