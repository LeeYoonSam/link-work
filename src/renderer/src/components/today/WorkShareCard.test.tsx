import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import WorkShareCard, { PAST_DONE_LIMIT, PAST_MEETING_LIMIT, SHARE_SECTION_LIMIT } from './WorkShareCard'
import { workShareText, type ShareItem, type ShareMeeting, type WorkShare } from './shareModel'
import { collect, click, findButton, textOf } from './testTree'

// 카드는 훅이 없어 함수로 직접 부른다. 행 선택·기간 규칙은 shareModel.test.ts 가 맡는다

const issue = (id: string, title: string, note: string | null = null): ShareItem => ({ kind: 'issue', id, title, note })
const todo = (id: number, title: string, note: string | null = null): ShareItem => ({ kind: 'todo', id: String(id), title, note })
const meeting = (over: Partial<ShareMeeting> & Pick<ShareMeeting, 'id' | 'title'>): ShareMeeting => ({
  start: '10:00',
  day: 'today',
  dayLabel: '오늘',
  review: false,
  noteId: null,
  tldr: null,
  ...over
})

const share = (over: Partial<WorkShare> = {}): WorkShare => {
  const base: WorkShare = {
    range: { from: new Date(2026, 10, 19), to: new Date(2026, 10, 20), multiDay: false, label: '11월 19일 (목)' },
    pastTitle: '어제',
    dateLabel: '11월 20일 (금)',
    jiraKnown: true,
    done: [issue('ICA-801', '결제 버그 수정'), todo(7, '주간 보고 작성')],
    doing: [issue('ICA-812', '쿠폰 API', '코드 리뷰')],
    planned: [todo(9, '배포 체크리스트', '기한 지남')],
    doneToday: [todo(11, '아침 메일 회신')],
    meetings: [
      meeting({ id: 'cal-p', title: '스프린트 회고', start: '11:00', day: 'past', dayLabel: '어제', noteId: 30, tldr: '회고 요약' }),
      meeting({ id: 'cal-a', title: 'PRD 리뷰', start: '14:00', review: true, noteId: 31, tldr: '범위 확정' }),
      meeting({ id: 'cal-b', title: '1:1', start: '16:00' })
    ],
    total: 0,
    ...over
  }
  const total = base.done.length + base.doneToday.length + base.doing.length + base.planned.length + base.meetings.length
  return { ...base, total: over.total ?? total }
}

const handlers = () => ({ onOpenIssue: vi.fn(), onOpenTodo: vi.fn(), onOpenNote: vi.fn(), onCopy: vi.fn() })
const html = (s: WorkShare): string => renderToStaticMarkup(<WorkShareCard share={s} {...handlers()} />)
/** data-share-column 열 하나의 마크업(다음 열 시작 전까지) */
const column = (out: string, name: 'past' | 'today'): string => {
  const start = out.indexOf(`data-share-column="${name}"`)
  if (start < 0) return ''
  const next = out.indexOf('data-share-column=', start + 1)
  return out.slice(start, next < 0 ? undefined : next)
}

describe('WorkShareCard', () => {
  it('헤더: 제목·건수·날짜·복사 버튼', () => {
    const out = html(share())
    expect(out).toContain('id="today-share"')
    expect(out).toContain('업무 공유')
    expect(out).toContain('11월 20일 (금)')
    expect(out).toContain('>8<')
    expect(out).toMatch(/<button[^>]*>복사<\/button>/)
    expect(out).not.toMatch(/disabled=""[^>]*>복사/)
  })

  it('어제 / 오늘 2열: 좁으면 1열, 넓으면 2열이고 어제 열이 먼저다', () => {
    const out = html(share())
    expect(out.indexOf('data-share-column="past"')).toBeGreaterThan(0)
    expect(out.indexOf('data-share-column="past"')).toBeLessThan(out.indexOf('data-share-column="today"'))
    expect(out).toContain('@container')
    expect(out).toMatch(/grid-cols-1 @min-\[560px\]:grid-cols-/)
  })

  it('어제 열: pastTitle·기간, 완료 항목과 지난 회의를 한 줄씩 짧게(메모·요약·배지 없음)', () => {
    const past = column(html(share()), 'past')
    expect(past).toContain('어제')
    expect(past).toContain('11월 19일 (목)')
    expect(past).toContain('ICA-801')
    expect(past).toContain('주간 보고 작성')
    expect(past).toContain('truncate')
    // 지난 회의는 완료 항목 아래, 시각·제목만
    expect(past.indexOf('data-share-section="done"')).toBeLessThan(past.indexOf('data-share-section="past-meetings"'))
    expect(past).toContain('>11:00<')
    expect(past).toContain('스프린트 회고')
    expect(past).not.toContain('회고 요약')
    expect(past).not.toContain('>어제 11:00<')
    // 오늘 항목(오늘 완료 포함)은 어제 열에 없다
    expect(past).not.toContain('아침 메일 회신')
    expect(past).not.toContain('쿠폰 API')
    expect(past).not.toContain('PRD 리뷰')
  })

  it('어제 열: 여러 날이면 지난 회의에 요일을 붙인다', () => {
    const out = html(
      share({
        pastTitle: '지난 근무일 이후',
        range: { from: new Date(2026, 10, 20), to: new Date(2026, 10, 23), multiDay: true, label: '11월 20일 (금) ~ 22일 (일)' },
        meetings: [meeting({ id: 'cal-f', title: '회고', start: '10:00', day: 'past', dayLabel: '금' })]
      })
    )
    const past = column(out, 'past')
    expect(past).toContain('지난 근무일 이후')
    expect(past).toContain('11월 20일 (금) ~ 22일 (일)')
    expect(past).toContain('금 10:00')
  })

  it('오늘 열: 작업 중 → 작업 예정 → 회의·리뷰 → 오늘 완료. 메모·리뷰 배지·요약은 보이고 오늘 회의는 시각만', () => {
    const today = column(html(share()), 'today')
    expect(today).toContain('오늘 완료')
    expect(today).toContain('아침 메일 회신')
    const pos = ['doing', 'planned', 'meetings', 'doneToday'].map((s) => today.indexOf(`data-share-section="${s}"`))
    expect(pos.every((p) => p >= 0)).toBe(true)
    expect([...pos].sort((a, b) => a - b)).toEqual(pos)
    expect(today).toContain('>코드 리뷰<')
    expect(today).toContain('>기한 지남<')
    expect(today).toMatch(/PRD 리뷰<\/span><span[^>]*>리뷰<\/span>/)
    expect(today).toContain('범위 확정')
    expect(today).toContain('>14:00<')
    expect(today).not.toContain('오늘 14:00')
    expect(today.match(/>리뷰<\/span>/g)?.length).toBe(1)
    expect(today).not.toContain('스프린트 회고')
  })

  it('한 열이 비면 그 열에 흐린 한 줄. 어제 열 문구는 pastTitle 을 따른다', () => {
    const noPast = html(share({ done: [], meetings: [meeting({ id: 'x', title: '스탠드업' })] }))
    expect(column(noPast, 'past')).toContain('어제 완료한 작업이 없어요')
    expect(column(noPast, 'today')).not.toContain('진행 중·예정 작업이 없어요')
    const noPastMulti = html(share({ pastTitle: '지난 근무일 이후', done: [], meetings: [meeting({ id: 'x', title: '스탠드업' })] }))
    expect(column(noPastMulti, 'past')).toContain('지난 근무일 이후 완료한 작업이 없어요')
    const noToday = html(share({ doing: [], planned: [], doneToday: [], meetings: [] }))
    expect(column(noToday, 'today')).toContain('진행 중·예정 작업이 없어요')
    expect(column(noToday, 'past')).not.toContain('완료한 작업이 없어요')
    // 오늘 완료만 있어도 오늘 열은 비지 않는다
    const onlyDoneToday = html(share({ doing: [], planned: [], meetings: [] }))
    expect(column(onlyDoneToday, 'today')).not.toContain('진행 중·예정 작업이 없어요')
    expect(column(onlyDoneToday, 'today')).toContain('data-share-section="doneToday"')
  })

  it('오늘 완료: 메모 없이 그리고 상한 8 뒤 외 n건, 클릭하면 이동한다', () => {
    const many = Array.from({ length: SHARE_SECTION_LIMIT + 2 }, (_, i) => issue(`ICA-9${i}`, `오늘 끝낸 ${i}`, '완료됨'))
    const out = html(share({ doneToday: many }))
    const today = column(out, 'today')
    const section = today.slice(today.indexOf('data-share-section="doneToday"'))
    expect(section).toContain('외 2건')
    expect(section).not.toContain('완료됨')
    expect(section).not.toContain(`오늘 끝낸 ${SHARE_SECTION_LIMIT}<`)
    const h = handlers()
    click(findButton(WorkShareCard({ share: share(), ...h }), '아침 메일 회신'))
    expect(h.onOpenTodo).toHaveBeenCalledWith(11)
  })

  it('Jira 를 모르면 안내 한 줄, 알면 없다', () => {
    expect(html(share({ jiraKnown: false, done: [todo(7, 'a')], doing: [] }))).toContain('data-share-section="jira-unknown"')
    expect(html(share())).not.toContain('jira-unknown')
  })

  it('전체 0건이면 빈 상태 문구와 비활성 복사 버튼만', () => {
    const out = html(share({ jiraKnown: false, done: [], doneToday: [], doing: [], planned: [], meetings: [] }))
    expect(out).toContain('공유할 작업이 없어요')
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>복사<\/button>/)
    expect(out).not.toContain('data-share-column')
  })

  it('표시 상한: 어제 완료·어제 회의·오늘 섹션이 따로 걸린다', () => {
    const done = Array.from({ length: PAST_DONE_LIMIT + 2 }, (_, i) => todo(100 + i, `완료 ${i}`))
    const past = Array.from({ length: PAST_MEETING_LIMIT + 1 }, (_, i) =>
      meeting({ id: `p${i}`, title: `지난 회의 ${i}`, day: 'past', dayLabel: '어제' })
    )
    const todayM = Array.from({ length: SHARE_SECTION_LIMIT + 3 }, (_, i) => meeting({ id: `t${i}`, title: `오늘 회의 ${i}` }))
    const out = html(share({ done, meetings: [...past, ...todayM] }))
    const p = column(out, 'past')
    const t = column(out, 'today')
    expect(p).toContain('외 2건')
    expect(p).toContain('외 1건')
    expect(p).toContain(`완료 ${PAST_DONE_LIMIT - 1}<`)
    expect(p).not.toContain(`완료 ${PAST_DONE_LIMIT}<`)
    expect(p).not.toContain(`지난 회의 ${PAST_MEETING_LIMIT}<`)
    expect(t).toContain('외 3건')
    expect(t).not.toContain(`오늘 회의 ${SHARE_SECTION_LIMIT}<`)
  })

  it('복사: 공유용 평문(workShareText)을 onCopy 로 넘긴다', () => {
    const h = handlers()
    const s = share()
    click(findButton(WorkShareCard({ share: s, ...h }), '복사'))
    expect(h.onCopy).toHaveBeenCalledWith(workShareText(s))
  })

  it('행 클릭: 이슈·할 일(숫자 id)·회의록으로 이동하고 회의록 없는 회의는 버튼이 아니다', () => {
    const h = handlers()
    const tree = WorkShareCard({ share: share(), ...h })
    click(findButton(tree, '결제 버그 수정'))
    expect(h.onOpenIssue).toHaveBeenCalledWith('ICA-801')
    click(findButton(tree, '주간 보고 작성'))
    expect(h.onOpenTodo).toHaveBeenCalledWith(7)
    click(findButton(tree, '쿠폰 API'))
    expect(h.onOpenIssue).toHaveBeenLastCalledWith('ICA-812')
    click(findButton(tree, '스프린트 회고'))
    expect(h.onOpenNote).toHaveBeenCalledWith(30)
    click(findButton(tree, 'PRD 리뷰'))
    expect(h.onOpenNote).toHaveBeenLastCalledWith(31)
    expect(textOf(findButton(tree, 'PRD 리뷰'))).toContain('범위 확정')
    expect(collect(tree).some((e) => e.type === 'button' && textOf(e).includes('1:1'))).toBe(false)
  })
})
