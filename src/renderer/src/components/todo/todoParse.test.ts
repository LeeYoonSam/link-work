import { describe, it, expect } from 'vitest'
import { parseTodoInput, splitPastedLines, toTodoInput } from './todoParse'

// 기준 시각: 2026-11-20(금) 10:00 (로컬)
const NOW = new Date(2026, 10, 20, 10, 0)
const TAGS = [
  { id: 1, name: '업무' },
  { id: 2, name: 'Work' }
]
const parse = (raw: string, ignore?: number[]) => parseTodoInput(raw, { now: NOW, tags: TAGS, ignore })

// [입력, 제목, due_date, due_reminder, priority, tag_ids]
type Sample = [string, string, string | undefined, number | undefined, string | undefined, number[] | undefined]

const SAMPLES: Sample[] = [
  // 날짜 낱말
  ['내일 3시 회의 준비', '회의 준비', '2026-11-21 15:00', 1, undefined, undefined],
  ['오늘 장보기', '장보기', '2026-11-20', 0, undefined, undefined],
  ['모레 발표', '발표', '2026-11-22', 0, undefined, undefined],
  ['글피 마감', '마감', '2026-11-23', 0, undefined, undefined],
  // 요일: 오늘이 금요일이므로 금요일은 다음 주
  ['금요일 보고서 !높음', '보고서', '2026-11-27', 0, 'high', undefined],
  ['월요일 주간보고', '주간보고', '2026-11-23', 0, undefined, undefined],
  ['목 회고', '회고', '2026-11-26', 0, undefined, undefined],
  ['일요일 등산', '등산', '2026-11-22', 0, undefined, undefined],
  ['토욜 청소', '청소', '2026-11-21', 0, undefined, undefined],
  ['다음 주 수요일 워크숍', '워크숍', '2026-11-25', 0, undefined, undefined],
  ['다음주 금 정산', '정산', '2026-11-27', 0, undefined, undefined],
  // 월/일
  ['11/25 치과', '치과', '2026-11-25', 0, undefined, undefined],
  ['1/5 신년회', '신년회', '2027-01-05', 0, undefined, undefined],
  ['12월 3일 생일', '생일', '2026-12-03', 0, undefined, undefined],
  ['3월1일 이사', '이사', '2027-03-01', 0, undefined, undefined],
  // 시각
  ['오늘 오후 2시 미팅', '미팅', '2026-11-20 14:00', 1, undefined, undefined],
  ['오전 9시 30분 스탠드업', '스탠드업', '2026-11-20 09:30', 1, undefined, undefined],
  ['10시 반 리뷰', '리뷰', '2026-11-20 10:30', 1, undefined, undefined],
  ['8시 운동', '운동', '2026-11-20 08:00', 1, undefined, undefined],
  ['15:00 배포', '배포', '2026-11-20 15:00', 1, undefined, undefined],
  ['3:30 통화', '통화', '2026-11-20 15:30', 1, undefined, undefined],
  ['오후 12시 점심', '점심', '2026-11-20 12:00', 1, undefined, undefined],
  ['내일 오전 12시 백업', '백업', '2026-11-21 00:00', 1, undefined, undefined],
  ['오후3시반 면담', '면담', '2026-11-20 15:30', 1, undefined, undefined],
  // 영어
  ['tomorrow 9am standup p1', 'standup', '2026-11-21 09:00', 1, 'high', undefined],
  ['today 5pm gym', 'gym', '2026-11-20 17:00', 1, undefined, undefined],
  ['fri report', 'report', '2026-11-27', 0, undefined, undefined],
  ['sunday brunch', 'brunch', '2026-11-22', 0, undefined, undefined],
  ['9 am call', 'call', '2026-11-20 09:00', 1, undefined, undefined],
  ['mon 10:30pm deploy', 'deploy', '2026-11-23 22:30', 1, undefined, undefined],
  // 우선순위
  ['p3 청소', '청소', undefined, undefined, 'low', undefined],
  ['!low 정리', '정리', undefined, undefined, 'low', undefined],
  ['!보통 회의', '회의', undefined, undefined, 'medium', undefined],
  ['P2 검토', '검토', undefined, undefined, 'medium', undefined],
  // 태그: 있는 태그만, 대소문자 무시
  ['#업무 정리', '정리', undefined, undefined, undefined, [1]],
  ['#work 메일', '메일', undefined, undefined, undefined, [2]],
  ['#없는태그 정리', '#없는태그 정리', undefined, undefined, undefined, undefined],
  ['내일 #업무 !높음 3시 회의', '회의', '2026-11-21 15:00', 1, 'high', [1]],
  // 인식하지 않는 것
  ['3시간 걸리는 일', '3시간 걸리는 일', undefined, undefined, undefined, undefined],
  ['내일모레 출장', '내일모레 출장', undefined, undefined, undefined, undefined],
  ['일 정리', '일 정리', undefined, undefined, undefined, undefined],
  ['2시에 회의', '2시에 회의', undefined, undefined, undefined, undefined],
  ['13/40 이상한 날짜', '13/40 이상한 날짜', undefined, undefined, undefined, undefined],
  ['25시 작업', '25시 작업', undefined, undefined, undefined, undefined],
  ['내일까지 제출', '내일까지 제출', undefined, undefined, undefined, undefined],
  // 같은 종류가 또 나오면 제목 글자로 남는다
  ['내일 회의 금요일 발표', '회의 금요일 발표', '2026-11-21', 0, undefined, undefined]
]

describe('parseTodoInput 표본', () => {
  it('표본이 30개 이상이다', () => {
    expect(SAMPLES.length).toBeGreaterThanOrEqual(30)
  })

  it.each(SAMPLES)('%s', (raw, title, due, reminder, priority, tagIds) => {
    const p = parse(raw)
    expect(p.title).toBe(title)
    expect(p.due_date).toBe(due)
    expect(p.due_reminder).toBe(reminder)
    expect(p.priority).toBe(priority)
    expect(p.tag_ids).toEqual(tagIds)
  })
})

describe('parseTodoInput 토큰', () => {
  it('토큰 위치·원문·칩 문구를 낸다', () => {
    const p = parse('내일 3시 회의 준비')
    expect(p.tokens).toEqual([
      { kind: 'date', text: '내일', start: 0, end: 2, label: '내일' },
      { kind: 'time', text: '3시', start: 3, end: 5, label: '15:00' }
    ])
  })

  it('여러 낱말 토큰은 한 덩어리다', () => {
    const p = parse('다음 주 수요일 워크숍')
    expect(p.tokens).toHaveLength(1)
    expect(p.tokens[0]).toMatchObject({ kind: 'date', text: '다음 주 수요일', start: 0, end: 8, label: '11/25 (수)' })
  })

  it('우선순위·태그 칩 문구', () => {
    const p = parse('#업무 보고 !높음')
    expect(p.tokens.map((t) => [t.kind, t.label])).toEqual([
      ['tag', '#업무'],
      ['priority', '높음']
    ])
  })

  it('ignore 에 넣은 토큰은 일반 글자로 되돌린다', () => {
    const p = parse('내일 회의', [0])
    expect(p.title).toBe('내일 회의')
    expect(p.due_date).toBeUndefined()
    expect(p.tokens).toEqual([])
  })

  it('시각 토큰만 되돌리면 날짜만 남고 알림은 끈다', () => {
    const p = parse('내일 3시 회의', [3])
    expect(p.title).toBe('3시 회의')
    expect(p.due_date).toBe('2026-11-21')
    expect(p.due_reminder).toBe(0)
  })

  it('여러 낱말 토큰을 되돌리면 그 낱말 전체가 글자로 남는다', () => {
    const p = parse('다음 주 수요일 워크숍', [0])
    expect(p.title).toBe('다음 주 수요일 워크숍')
    expect(p.due_date).toBeUndefined()
  })

  it('토큰만 있는 입력은 원문을 제목으로 두고 토큰을 내지 않는다', () => {
    for (const raw of ['내일', '내일 3시', '!높음', '#업무']) {
      const p = parse(raw)
      expect(p.title).toBe(raw)
      expect(p.tokens).toEqual([])
      expect(p.due_date).toBeUndefined()
      expect(p.priority).toBeUndefined()
      expect(p.tag_ids).toBeUndefined()
    }
  })

  it('공백을 정리한다', () => {
    expect(parse('  내일   회의   준비  ').title).toBe('회의 준비')
  })

  it('태그 목록이 없으면 #낱말은 제목에 남는다', () => {
    const p = parseTodoInput('#업무 정리', { now: NOW })
    expect(p.title).toBe('#업무 정리')
    expect(p.tag_ids).toBeUndefined()
  })
})

describe('toTodoInput', () => {
  it('값이 있는 필드만 넣는다', () => {
    expect(toTodoInput(parse('회의 준비'))).toEqual({ title: '회의 준비' })
    expect(toTodoInput(parse('내일 3시 회의 준비 !높음 #업무'))).toEqual({
      title: '회의 준비',
      priority: 'high',
      due_date: '2026-11-21 15:00',
      due_reminder: 1,
      tag_ids: [1]
    })
    expect(toTodoInput(parse('11/25 치과'))).toEqual({ title: '치과', due_date: '2026-11-25', due_reminder: 0 })
  })
})

describe('splitPastedLines', () => {
  it('빈 줄을 빼고 글머리 기호를 지운다', () => {
    const text = '- 첫째\n\n* 둘째\r\n• 셋째\n1. 넷째\n2) 다섯째\n[ ] 여섯째\n[x] 일곱째\n- [ ] 여덟째\n   \n그냥 줄'
    expect(splitPastedLines(text)).toEqual(['첫째', '둘째', '셋째', '넷째', '다섯째', '여섯째', '일곱째', '여덟째', '그냥 줄'])
  })

  it('기호 뒤에 공백이 없는 하이픈·숫자는 내용으로 본다', () => {
    expect(splitPastedLines('-1도 낮추기\n1.5배 빠르게')).toEqual(['-1도 낮추기', '1.5배 빠르게'])
  })

  it('최대 50줄', () => {
    const text = Array.from({ length: 60 }, (_, i) => `할 일 ${i + 1}`).join('\n')
    const lines = splitPastedLines(text)
    expect(lines).toHaveLength(50)
    expect(lines[49]).toBe('할 일 50')
  })
})
