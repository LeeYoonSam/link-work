import { describe, it, expect } from 'vitest'
import {
  isSafeSourceLink,
  issueTodoPrefill,
  meetingTodoPrefill,
  memoTodoPrefill,
  sourceLinkLabel,
  stripMarkdownLine
} from './sourceLink'

describe('sourceLinkLabel', () => {
  it('앱 안 링크는 종류 이름', () => {
    expect(sourceLinkLabel('linkwork://memo/12')).toBe('메모')
    expect(sourceLinkLabel('linkwork://note/5')).toBe('회의록')
    expect(sourceLinkLabel('linkwork://recording/5')).toBe('녹음')
    expect(sourceLinkLabel('linkwork://todo/3')).toBe('원본')
  })

  it('https 는 경로의 Jira 키, 없으면 호스트 이름', () => {
    expect(sourceLinkLabel('https://x.atlassian.net/browse/AB-123')).toBe('AB-123')
    expect(sourceLinkLabel('https://x.atlassian.net/browse/AB-123?focusedCommentId=1')).toBe('AB-123')
    expect(sourceLinkLabel('https://docs.example.com/page/1')).toBe('docs.example.com')
  })

  it('Bitbucket PR 주소는 저장소 #번호', () => {
    expect(sourceLinkLabel('https://bitbucket.org/ws/app/pull-requests/12')).toBe('app #12')
    expect(sourceLinkLabel('https://bitbucket.org/ws/app/pull-requests/12/overview')).toBe('app #12')
    expect(sourceLinkLabel('https://bitbucket.org/ws/app/src/main')).toBe('bitbucket.org')
  })
})

describe('isSafeSourceLink', () => {
  it('linkwork:// 와 https:// 만 true', () => {
    expect(isSafeSourceLink('linkwork://memo/1')).toBe(true)
    expect(isSafeSourceLink('https://x.atlassian.net/browse/AB-1')).toBe(true)
    expect(isSafeSourceLink('http://a.com')).toBe(false)
    expect(isSafeSourceLink('javascript:alert(1)')).toBe(false)
    expect(isSafeSourceLink(' https://a.com')).toBe(false)
    expect(isSafeSourceLink('')).toBe(false)
  })
})

describe('할 일로 만들기 미리 채움', () => {
  it('메모: 첫 줄에서 마크다운 기호를 빼고 80자로 자른다', () => {
    expect(memoTodoPrefill({ id: 12, content: '\n# 배포 **절차** 정리\n\n본문' })).toEqual({
      text: '배포 절차 정리',
      sourceLink: 'linkwork://memo/12'
    })
    expect(memoTodoPrefill({ id: 1, content: '- [ ] [링크](https://a.com) 확인' }).text).toBe('링크 확인')
    expect(memoTodoPrefill({ id: 1, content: 'ㄱ'.repeat(100) }).text).toHaveLength(80)
    expect(memoTodoPrefill({ id: 1, content: '' }).text).toBe('')
  })

  it('stripMarkdownLine: 인용·번호 목록·코드 기호', () => {
    expect(stripMarkdownLine('> 1. `npm` 실행')).toBe('npm 실행')
    expect(stripMarkdownLine('*강조* 와 _밑줄_')).toBe('강조 와 밑줄')
    expect(stripMarkdownLine('2) 정리')).toBe('정리')
  })

  it('회의록: 제목 + 후속, 회의 id 의 회의록 링크', () => {
    expect(meetingTodoPrefill({ id: 5, title: '주간 회의' })).toEqual({
      text: '주간 회의 후속',
      sourceLink: 'linkwork://note/5'
    })
  })

  it('Jira: [KEY] 요약, 티켓 웹 주소. 사이트 주소를 모르거나 https 가 아니면 null', () => {
    expect(issueTodoPrefill('AB-1', '로그인 오류', 'https://x.atlassian.net/')).toEqual({
      text: '[AB-1] 로그인 오류',
      sourceLink: 'https://x.atlassian.net/browse/AB-1'
    })
    expect(issueTodoPrefill('AB-1', '로그인 오류', null)).toBeNull()
    expect(issueTodoPrefill('AB-1', '로그인 오류', 'http://x.atlassian.net')).toBeNull()
  })
})
