import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import {
  buildMeetingBriefing,
  escapeMarkdownText,
  hasMeetingContext,
  matchProjects,
  MEETING_LINE_MAX,
  MEETING_TITLE_MAX,
  meetingNoticeText,
  normalizeTitle,
  sameTitle
} from './assistant-meeting'
import type { MeetingContext } from './assistant-types'

function ctx(over: Partial<MeetingContext> = {}): MeetingContext {
  return {
    meeting: { id: 'evt1', title: 'LinkWork 주간 회의', startAt: '2026-11-02 14:00:00', endAt: '2026-11-02 15:00:00' },
    projects: [],
    pastMeetings: [],
    openActionItems: [],
    relatedItems: [],
    errors: [],
    ...over
  }
}

const FULL = ctx({
  projects: [{ id: 1, name: 'LinkWork' }, { id: 2, name: '비서' }],
  pastMeetings: [
    {
      meetingId: 10, title: 'LinkWork 주간 회의', startedAt: '2026-10-26 14:00:00',
      tldr: '배포 일정 확정.\n다음 주 QA 진행', openActionItems: ['QA 체크리스트 작성']
    },
    { meetingId: 9, title: 'LinkWork 주간회의', startedAt: '2026-10-19 14:00:00', tldr: null, openActionItems: [] }
  ],
  openActionItems: ['QA 체크리스트 작성', '릴리스 노트 초안'],
  relatedItems: [{ id: 5, title: '비서 MVP5 구현', status: 'in_progress' }]
})

describe('상수', () => {
  it('상수는 계약 값이다', () => {
    expect(MEETING_TITLE_MAX).toBe(30)
    expect(MEETING_LINE_MAX).toBe(200)
  })
})

describe('normalizeTitle·sameTitle', () => {
  it('normalizeTitle 은 소문자화하고 공백·구두점을 지운다', () => {
    expect(normalizeTitle('  LinkWork 주간 회의! ')).toBe('linkwork주간회의')
    expect(normalizeTitle('[Weekly] Sync-Up / 2차')).toBe('weeklysyncup2차')
  })

  it('sameTitle: 정규화한 제목이 같으면 참이다', () => {
    expect(sameTitle('LinkWork 주간 회의', 'linkwork 주간회의')).toBe(true)
    expect(sameTitle('[주간] 회의', '주간 회의.')).toBe(true)
  })

  it('sameTitle: 정규화한 제목이 다르거나 비어 있으면 거짓이다', () => {
    expect(sameTitle('주간 회의', '주간 회의 2')).toBe(false)
    expect(sameTitle('---', '...')).toBe(false)
    expect(sameTitle('', '')).toBe(false)
  })
})

describe('matchProjects', () => {
  it('matchProjects: 정규화한 제목에 프로젝트 이름이 포함되면 매칭이다', () => {
    const projects = [
      { id: 1, name: 'Link Work' },
      { id: 2, name: '결제' },
      { id: 3, name: '정산' }
    ]
    expect(matchProjects('[LinkWork] 결제 연동 리뷰', projects)).toEqual([
      { id: 1, name: 'Link Work' },
      { id: 2, name: '결제' }
    ])
    expect(matchProjects('전사 타운홀', projects)).toEqual([])
  })

  it('matchProjects: 정규화한 이름이 1자인 프로젝트는 제외한다', () => {
    const projects = [{ id: 1, name: 'A' }, { id: 2, name: '앱' }, { id: 3, name: ' A! ' }, { id: 4, name: '앱 팀' }]
    expect(matchProjects('A 앱 팀 회의', projects)).toEqual([{ id: 4, name: '앱 팀' }])
  })

  it('matchProjects: 최대 3건이다. 이름 길이 내림차순, 같으면 id 오름차순이다', () => {
    const projects = [
      { id: 5, name: '검색' },
      { id: 4, name: '결제' },
      { id: 3, name: '추천엔진' },
      { id: 2, name: '정산시스템' },
      { id: 1, name: '중복' },
      { id: 1, name: '중복' }
    ]
    const r = matchProjects('정산시스템 추천엔진 결제 검색 중복 통합 회의', projects)
    expect(r).toEqual([
      { id: 2, name: '정산시스템' },
      { id: 3, name: '추천엔진' },
      { id: 1, name: '중복' }
    ])
  })

  it('matchProjects: 제목이 비면 빈 배열이다', () => {
    expect(matchProjects('   ', [{ id: 1, name: '결제' }])).toEqual([])
  })
})

describe('hasMeetingContext', () => {
  it('자료가 하나라도 있으면 참이다. errors 만 있으면 거짓이다', () => {
    expect(hasMeetingContext(ctx())).toBe(false)
    expect(hasMeetingContext(ctx({ errors: ['지난 회의를 읽지 못했습니다'] }))).toBe(false)
    expect(hasMeetingContext(ctx({ projects: [{ id: 1, name: '결제' }] }))).toBe(true)
    expect(hasMeetingContext(ctx({ pastMeetings: FULL.pastMeetings }))).toBe(true)
    expect(hasMeetingContext(ctx({ openActionItems: ['x'] }))).toBe(true)
    expect(hasMeetingContext(ctx({ relatedItems: FULL.relatedItems }))).toBe(true)
  })
})

describe('buildMeetingBriefing', () => {
  it('I.6 형식으로 모든 절을 만든다', () => {
    expect(buildMeetingBriefing(FULL).split('\n')).toEqual([
      '# LinkWork 주간 회의 14:00',
      '- 관련 프로젝트: LinkWork, 비서',
      '## 지난 회의',
      '- 10-26 LinkWork 주간 회의 — 배포 일정 확정. 다음 주 QA 진행',
      '- 10-19 LinkWork 주간회의',
      '## 미완료 액션아이템 (2)',
      '- QA 체크리스트 작성',
      '- 릴리스 노트 초안',
      '## 오늘 계획 중 관련 항목',
      '- 비서 MVP5 구현'
    ])
  })

  it('자료가 없으면 없음 문구를 쓰고 액션아이템·관련 항목 절을 뺀다', () => {
    expect(buildMeetingBriefing(ctx()).split('\n')).toEqual([
      '# LinkWork 주간 회의 14:00',
      '- 관련 프로젝트 없음',
      '## 지난 회의',
      '- 같은 제목의 지난 회의 없음'
    ])
  })

  it('각 줄은 200자에서 자른다', () => {
    const long = '가'.repeat(500)
    const md = buildMeetingBriefing(ctx({
      meeting: { ...FULL.meeting, title: long },
      pastMeetings: [{ ...FULL.pastMeetings[0], tldr: long }],
      openActionItems: [long],
      relatedItems: [{ id: 1, title: long, status: 'planned' }]
    }))
    const lines = md.split('\n')
    for (const l of lines) expect(Array.from(l).length).toBeLessThanOrEqual(MEETING_LINE_MAX)
    expect(lines[0].endsWith('…')).toBe(true)
    expect(lines.find((l) => l.startsWith('- 10-26'))?.endsWith('…')).toBe(true)
  })

  it('외부 텍스트의 Markdown 링크·이미지 문법을 이스케이프한다. 알림 문구는 이스케이프하지 않는다', () => {
    expect(escapeMarkdownText('[보안 확인](https://x.io) ![i](a) <https://y.io> \\')).toBe(
      '\\[보안 확인\\]\\(https://x.io\\) \\!\\[i\\]\\(a\\) \\<https://y.io\\> \\\\'
    )
    const evil = '[보안 확인](https://evil.example)'
    const md = buildMeetingBriefing(ctx({
      meeting: { ...FULL.meeting, title: evil },
      projects: [{ id: 1, name: evil }],
      pastMeetings: [{ ...FULL.pastMeetings[0], title: evil, tldr: evil }],
      openActionItems: [evil],
      relatedItems: [{ id: 1, title: evil, status: 'planned' }]
    }))
    // 이스케이프하지 않은 링크 문법이 본문 어디에도 없다
    expect(md).not.toMatch(/(^|[^\\])\[[^\]]*[^\\]\]\(/m)
    expect(md.split('\n')[0]).toBe('# \\[보안 확인\\]\\(https://evil.example\\) 14:00')
    expect(meetingNoticeText(ctx({ meeting: { ...FULL.meeting, title: '[a](b)' } }), 15).title).toBe('[a](b) 15분 전')
  })

  it('A14: 같은 입력에 같은 출력이고 입력을 바꾸지 않는다', () => {
    const snapshot = JSON.parse(JSON.stringify(FULL))
    expect(buildMeetingBriefing(FULL)).toBe(buildMeetingBriefing(FULL))
    meetingNoticeText(FULL, 15)
    hasMeetingContext(FULL)
    expect(FULL).toEqual(snapshot)
  })
})

describe('meetingNoticeText', () => {
  it('제목은 <회의 제목> <lead>분 전, 본문은 <프로젝트> · 미완료 액션 N건 이다', () => {
    expect(meetingNoticeText(FULL, 15)).toEqual({
      title: 'LinkWork 주간 회의 15분 전',
      body: 'LinkWork, 비서 · 미완료 액션 2건'
    })
    expect(meetingNoticeText(ctx(), 10)).toEqual({
      title: 'LinkWork 주간 회의 10분 전',
      body: '관련 프로젝트 없음 · 미완료 액션 0건'
    })
  })

  it('회의 제목은 30자를 넘으면 30자로 자르고 … 를 붙인다. 빈 제목은 (제목 없음) 이다', () => {
    const t31 = '가'.repeat(31)
    expect(meetingNoticeText(ctx({ meeting: { ...FULL.meeting, title: t31 } }), 15).title).toBe(`${'가'.repeat(30)}… 15분 전`)
    const t30 = '가'.repeat(30)
    expect(meetingNoticeText(ctx({ meeting: { ...FULL.meeting, title: t30 } }), 15).title).toBe(`${t30} 15분 전`)
    expect(meetingNoticeText(ctx({ meeting: { ...FULL.meeting, title: '  ' } }), 5).title).toBe('(제목 없음) 5분 전')
  })
})

describe('순수 모듈 경계', () => {
  const source = readFileSync(fileURLToPath(new URL('./assistant-meeting.ts', import.meta.url)), 'utf8')

  it('A3: assistant-types 만 import 한다', () => {
    const froms = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(new Set(froms)).toEqual(new Set(['./assistant-types']))
  })

  it('A16: 셸 실행 경로가 없다', () => {
    // 금지어를 쪼개 쓴다. 이 테스트 파일이 셸 실행 grep 조건에 걸리지 않게 한다
    const banned = ['child' + '_process', 'exec' + 'Sync', 'sp' + 'awn']
    for (const word of banned) expect(source).not.toContain(word)
  })
})
