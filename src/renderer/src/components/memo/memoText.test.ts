import { describe, it, expect } from 'vitest'
import { formatDbTime, formatRelative, parseDbTime, parseMemoTitle, toPlainText, UNTITLED } from './memoText'

describe('parseMemoTitle', () => {
  it('앞 빈 줄을 건너뛰고 # 헤딩을 떼어 제목으로 쓴다', () => {
    expect(parseMemoTitle('\n\n## 회의 준비\n\n- 자료 확인')).toEqual({
      title: '회의 준비',
      body: '\n- 자료 확인'
    })
  })

  it('###### 헤딩과 목록 기호·체크박스·인라인 서식을 뗀다', () => {
    expect(parseMemoTitle('###### 작은 제목').title).toBe('작은 제목')
    expect(parseMemoTitle('- 목록 제목').title).toBe('목록 제목')
    expect(parseMemoTitle('* [ ] 할 일 제목').title).toBe('할 일 제목')
    expect(parseMemoTitle('# **굵은** `코드` [링크](https://x.y)').title).toBe('굵은 코드 링크')
  })

  it('80자로 자른다', () => {
    expect(parseMemoTitle(`# ${'가'.repeat(100)}`).title).toHaveLength(80)
  })

  it('빈 내용이면 제목 없음', () => {
    expect(parseMemoTitle('').title).toBe(UNTITLED)
    expect(parseMemoTitle('   \n  ').title).toBe(UNTITLED)
  })
})

describe('toPlainText', () => {
  it('헤딩·강조·링크·인라인 코드를 평문으로 바꾼다', () => {
    expect(toPlainText('# 제목\n**굵게** *기울임* ~~취소~~ [문서](http://a.b) `npm run`')).toBe(
      '제목 굵게 기울임 취소 문서 npm run'
    )
  })

  it('코드펜스 줄과 표 구분선을 지우고 표 칸은 공백으로 잇는다', () => {
    const md = '```ts\nconst a = 1\n```\n| 이름 | 값 |\n|---|:---:|\n| a | 1 |'
    expect(toPlainText(md)).toBe('const a = 1 이름 값 a 1')
  })

  it('HTML 태그를 지우고 연속 공백을 압축한다', () => {
    expect(toPlainText('<b>강조</b>   뒤\n\n\n다음 줄')).toBe('강조 뒤 다음 줄')
  })

  it('snake_case 의 밑줄은 남긴다', () => {
    expect(toPlainText('memo_categories 와 _강조_')).toBe('memo_categories 와 강조')
  })
})

describe('parseDbTime', () => {
  it('오프셋 없는 DB 문자열을 UTC 로 해석한다', () => {
    expect(parseDbTime('2026-11-18 10:33:10').getTime()).toBe(Date.UTC(2026, 10, 18, 10, 33, 10))
    expect(parseDbTime('2026-11-05T10:00:00').getTime()).toBe(Date.UTC(2026, 10, 5, 10, 0, 0))
  })

  it('Z 나 오프셋이 있으면 그대로 쓴다', () => {
    expect(parseDbTime('2026-11-18T10:33:10Z').getTime()).toBe(Date.UTC(2026, 10, 18, 10, 33, 10))
    expect(parseDbTime('2026-11-18T19:33:10+09:00').getTime()).toBe(Date.UTC(2026, 10, 18, 10, 33, 10))
  })

  it('잘못된 값이면 Invalid Date', () => {
    expect(Number.isNaN(parseDbTime('다음 주').getTime())).toBe(true)
    expect(Number.isNaN(parseDbTime('').getTime())).toBe(true)
  })

  it('formatDbTime 은 로컬 시각으로 포맷하고 해석 불가면 원문', () => {
    const d = new Date(Date.UTC(2026, 10, 18, 10, 33, 10))
    const pad = (n: number): string => String(n).padStart(2, '0')
    expect(formatDbTime('2026-11-18 10:33:10', 'HH:mm')).toBe(`${pad(d.getHours())}:${pad(d.getMinutes())}`)
    expect(formatDbTime('엉터리', 'HH:mm')).toBe('엉터리')
  })
})

describe('formatRelative', () => {
  const now = new Date(2026, 10, 18, 14, 0, 0)
  it('분·시간 경계', () => {
    expect(formatRelative(new Date(2026, 10, 18, 13, 59, 30), now)).toBe('방금')
    expect(formatRelative(new Date(2026, 10, 18, 13, 1, 0), now)).toBe('59분 전')
    expect(formatRelative(new Date(2026, 10, 18, 13, 0, 0), now)).toBe('1시간 전')
    expect(formatRelative(new Date(2026, 10, 18, 0, 0, 0), now)).toBe('14시간 전')
  })

  it('자정을 넘기면 어제, 7일까지 n일 전, 그 뒤 M/d, 해가 바뀌면 yy/M/d', () => {
    const earlyMorning = new Date(2026, 10, 18, 1, 0, 0)
    expect(formatRelative(new Date(2026, 10, 17, 23, 30, 0), earlyMorning)).toBe('어제')
    expect(formatRelative(new Date(2026, 10, 17, 9, 0, 0), now)).toBe('어제')
    expect(formatRelative(new Date(2026, 10, 11, 9, 0, 0), now)).toBe('7일 전')
    expect(formatRelative(new Date(2026, 10, 10, 9, 0, 0), now)).toBe('11/10')
    expect(formatRelative(new Date(2025, 11, 31, 9, 0, 0), now)).toBe('25/12/31')
  })

  it('미래 시각은 방금, 잘못된 시각은 빈 문자열', () => {
    expect(formatRelative(new Date(2026, 10, 18, 15, 0, 0), now)).toBe('방금')
    expect(formatRelative(new Date(NaN), now)).toBe('')
  })
})
