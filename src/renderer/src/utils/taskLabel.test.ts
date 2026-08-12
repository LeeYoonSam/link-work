import { describe, it, expect } from 'vitest'
import { parseTaskLabel, isIssueKey } from './taskLabel'

describe('parseTaskLabel', () => {
  it('Jira 키 접두사 하나를 분리한다', () => {
    expect(parseTaskLabel('[ICA-8678] 위젯 공통 기반 구축 (디자인 토큰·공통 부품·상태 규칙)')).toEqual({
      tags: ['ICA-8678'],
      title: '위젯 공통 기반 구축 (디자인 토큰·공통 부품·상태 규칙)'
    })
  })

  it('이중 접두사(Jira 키 + 도메인 태그)를 순서대로 분리한다', () => {
    expect(parseTaskLabel('[ICA-8681] [검색홈] 트렌드 검색어 가로 스크롤 크래시 수정')).toEqual({
      tags: ['ICA-8681', '검색홈'],
      title: '트렌드 검색어 가로 스크롤 크래시 수정'
    })
  })

  it('도메인 태그만 있는 경우도 분리한다', () => {
    expect(parseTaskLabel('[커뮤니티] 영상(clip) 유닛 추가')).toEqual({
      tags: ['커뮤니티'],
      title: '영상(clip) 유닛 추가'
    })
  })

  it('닫는 괄호 앞 공백은 trim 된다', () => {
    expect(parseTaskLabel('[할인탭 ] 어쩌고')).toEqual({
      tags: ['할인탭'],
      title: '어쩌고'
    })
  })

  it('대괄호가 없으면 원문을 제목으로 둔다', () => {
    const name = 'd+즉시할인 - 적립금 전환 관련 PRD 리뷰'
    expect(parseTaskLabel(name)).toEqual({ tags: [], title: name })
  })

  it('접두사를 떼면 제목이 없어지는 경우 분리하지 않는다', () => {
    expect(parseTaskLabel('[PDP]')).toEqual({ tags: [], title: '[PDP]' })
  })

  it('빈 대괄호는 태그로 취급하지 않는다', () => {
    expect(parseTaskLabel('[]')).toEqual({ tags: [], title: '[]' })
  })

  it('빈 문자열은 원문 그대로 반환한다', () => {
    expect(parseTaskLabel('')).toEqual({ tags: [], title: '' })
  })

  it('대괄호 안이 20자를 넘으면 태그로 보지 않는다', () => {
    const name = '[아주아주아주아주아주아주많이긴태그입니다요] 제목' // 대괄호 안 21자
    expect(parseTaskLabel(name)).toEqual({ tags: [], title: name })
  })

  it('태그 길이 경계는 20자다 — 20자는 인정, 21자는 제외', () => {
    const boundary = '가'.repeat(20)
    expect(parseTaskLabel(`[${boundary}] 제목`)).toEqual({ tags: [boundary], title: '제목' })

    const overflow = '가'.repeat(21)
    const name = `[${overflow}] 제목`
    expect(parseTaskLabel(name)).toEqual({ tags: [], title: name })
  })

  it('공백뿐인 대괄호는 태그가 아니며 그 자리에서 추출을 멈춘다', () => {
    expect(parseTaskLabel('[  ] 제목')).toEqual({ tags: [], title: '[  ] 제목' })
    expect(parseTaskLabel('[ICA-1] [  ] 제목')).toEqual({ tags: ['ICA-1'], title: '[  ] 제목' })
  })

  it('태그는 최대 3개까지만 분리하고 나머지는 제목에 남긴다', () => {
    expect(parseTaskLabel('[A] [B] [C] [D] 제목')).toEqual({
      tags: ['A', 'B', 'C'],
      title: '[D] 제목'
    })
  })

  it('공백뿐인 입력은 원문 그대로 반환한다', () => {
    expect(parseTaskLabel('   ')).toEqual({ tags: [], title: '   ' })
  })

  it('선두 공백과 태그 사이 공백을 흡수한다', () => {
    expect(parseTaskLabel('  [ICA-8678]   위젯 개편  ')).toEqual({
      tags: ['ICA-8678'],
      title: '위젯 개편'
    })
  })

  it('문장 중간의 대괄호는 건드리지 않는다', () => {
    expect(parseTaskLabel('검색 [자동완성] 개선')).toEqual({
      tags: [],
      title: '검색 [자동완성] 개선'
    })
  })

  it('태그와 제목을 합치면 원문의 의미 있는 내용이 모두 남는다', () => {
    const names = [
      '[ICA-8678] 위젯 공통 기반 구축',
      '[ICA-8681] [검색홈] 트렌드 검색어 가로 스크롤 크래시 수정',
      '[커뮤니티] 영상(clip) 유닛 추가',
      'd+즉시할인 - 적립금 전환 관련 PRD 리뷰',
      '[PDP]'
    ]
    for (const name of names) {
      const { tags, title } = parseTaskLabel(name)
      const joined = [...tags.map((t) => `[${t}]`), title].join(' ').trim()
      expect(joined.replace(/\s+/g, '')).toBe(name.replace(/\s+/g, ''))
    }
  })
})

describe('isIssueKey', () => {
  it('Jira 이슈 키 형태를 판정한다', () => {
    expect(isIssueKey('ICA-8678')).toBe(true)
    expect(isIssueKey('검색홈')).toBe(false)
    expect(isIssueKey('PDP')).toBe(false)
  })

  it('프로젝트 키에 숫자가 섞여도 인정한다', () => {
    expect(isIssueKey('AB2-1')).toBe(true)
  })

  it('소문자·숫자 누락·번호 없음은 이슈 키가 아니다', () => {
    expect(isIssueKey('ica-8678')).toBe(false)
    expect(isIssueKey('ICA-')).toBe(false)
    expect(isIssueKey('-123')).toBe(false)
    expect(isIssueKey('')).toBe(false)
  })
})
