// 오늘 대시보드의 '업무 공유' 카드 (docs/ASSISTANT.md §11.3).
// 데일리 스탠드업에서 팀에 공유할 업무를 '어제 / 오늘' 2열로 나눠 보인다.
// - 어제 열: 지난 근무일(오늘 0시 전)에 완료한 작업과 지난 회의. 한 행 한 줄로 짧게
// - 오늘 열: 작업 중 / 작업 예정 / 오늘 회의·리뷰 / 오늘 완료. 상태 메모·리뷰 배지·회의록 요약까지
// 행 선택은 shareModel 이 하고 여기서는 그리기·이동·복사 전달만 한다. 복사는 공유용 평문(workShareText, 상한 없이 전부)을
// onCopy 로 넘긴다. 클립보드·피드백은 TodayView 가 맡는다
import type { ShareItem, ShareMeeting, WorkShare } from './shareModel'
import { workShareText } from './shareModel'
import { Card } from '../ui'
import { CARD_COUNT, CARD_HEAD, ISSUE_KEY, ROW, ROW_TITLE } from './todayTokens'

/** 오늘 열 섹션별 표시 상한. 넘치면 '외 n건' 으로 줄인다(복사 글은 전부 담는다) */
export const SHARE_SECTION_LIMIT = 8
/** 어제 열 완료 항목 표시 상한 */
export const PAST_DONE_LIMIT = 8
/** 어제 열 회의 표시 상한 */
export const PAST_MEETING_LIMIT = 5

// 섹션 머리
const SECTION_HEAD = 'px-4 pt-2 pb-0.5 text-[11px] font-medium text-gray-400'
// 열 머리(어제 / 오늘)
const COLUMN_HEAD = 'flex items-baseline gap-2 px-4 pt-3 pb-1 text-xs font-semibold text-gray-600'
// 행 안의 이동 버튼. 행 폭을 차지하고 글자는 왼쪽 정렬한다
const ROW_BUTTON = 'flex min-w-0 flex-1 items-start gap-2 rounded text-left hover:text-blue-700'
// 행 옆 흐린 메모(Jira 상태 이름, '기한 지남')
const ROW_NOTE = 'mt-0.5 shrink-0 whitespace-nowrap text-[11px] text-gray-400'
// 어제 열의 한 줄 행. 넘치면 말줄임
const COMPACT_ROW = 'flex min-w-0 items-center gap-1.5 px-4 py-0.5 text-xs text-gray-700'
const COMPACT_BUTTON = 'flex min-w-0 flex-1 items-center gap-1.5 rounded text-left hover:text-blue-700'
// 열이 비었을 때 흐린 한 줄
const COLUMN_EMPTY = 'px-4 pt-1 pb-2 text-xs text-gray-400'

const moreText = (count: number, limit: number): React.ReactNode =>
  count > limit ? <p className="px-4 pb-1 text-xs text-gray-400">외 {count - limit}건</p> : null

// ── 어제 열 ──

function PastItemRow({
  item,
  onOpenIssue,
  onOpenTodo
}: {
  item: ShareItem
  onOpenIssue: (key: string) => void
  onOpenTodo: (id: number) => void
}): React.ReactNode {
  const isIssue = item.kind === 'issue'
  return (
    <li data-share-item={`${item.kind}-${item.id}`} className={COMPACT_ROW}>
      <button
        type="button"
        onClick={() => (isIssue ? onOpenIssue(item.id) : onOpenTodo(Number(item.id)))}
        className={COMPACT_BUTTON}
        title={item.title}
      >
        {isIssue ? <span className={ISSUE_KEY}>{item.id}</span> : null}
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
      </button>
    </li>
  )
}

function PastMeetingRow({
  row,
  withDay,
  onOpenNote
}: {
  row: ShareMeeting
  withDay: boolean
  onOpenNote: (noteId: number) => void
}): React.ReactNode {
  const body = (
    <>
      <span className="shrink-0 whitespace-nowrap text-gray-400 tabular-nums">
        {withDay ? `${row.dayLabel} ${row.start}` : row.start}
      </span>
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
    </>
  )
  const noteId = row.noteId
  return (
    <li data-share-meeting={row.id} className={`${COMPACT_ROW} text-gray-500`}>
      {noteId !== null ? (
        <button type="button" onClick={() => onOpenNote(noteId)} className={COMPACT_BUTTON} title="회의록 보기">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5" title={row.title}>
          {body}
        </div>
      )}
    </li>
  )
}

// ── 오늘 열 ──

function ItemRow({
  item,
  onOpenIssue,
  onOpenTodo
}: {
  item: ShareItem
  onOpenIssue: (key: string) => void
  onOpenTodo: (id: number) => void
}): React.ReactNode {
  const isIssue = item.kind === 'issue'
  return (
    <li data-share-item={`${item.kind}-${item.id}`} className={ROW}>
      <button
        type="button"
        onClick={() => (isIssue ? onOpenIssue(item.id) : onOpenTodo(Number(item.id)))}
        className={ROW_BUTTON}
        title={isIssue ? `${item.id} 프로젝트 화면에서 보기` : '할 일 화면에서 보기'}
      >
        {isIssue ? <span className={`${ISSUE_KEY} mt-0.5`}>{item.id}</span> : null}
        <span className={ROW_TITLE}>{item.title}</span>
      </button>
      {item.note ? <span className={ROW_NOTE}>{item.note}</span> : null}
    </li>
  )
}

function MeetingRow({ row, onOpenNote }: { row: ShareMeeting; onOpenNote: (noteId: number) => void }): React.ReactNode {
  const body = (
    <>
      <span className="mt-0.5 shrink-0 whitespace-nowrap text-xs text-gray-500 tabular-nums">{row.start}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-start gap-1.5">
          <span className={ROW_TITLE}>{row.title}</span>
          {row.review ? (
            <span className="mt-0.5 shrink-0 rounded bg-violet-50 px-1 text-[10px] font-medium text-violet-700">리뷰</span>
          ) : null}
        </span>
        {row.tldr ? <span className="mt-0.5 block truncate text-xs text-gray-500">{row.tldr}</span> : null}
      </span>
    </>
  )
  const noteId = row.noteId
  return (
    <li data-share-meeting={row.id} className={ROW}>
      {noteId !== null ? (
        <button type="button" onClick={() => onOpenNote(noteId)} className={ROW_BUTTON} title="회의록 보기">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2">{body}</div>
      )}
    </li>
  )
}

const TODAY_SECTION_TITLE = { doing: '작업 중', planned: '작업 예정', meetings: '회의·리뷰', doneToday: '오늘 완료' } as const

function TodaySection({
  name,
  count,
  children
}: {
  name: keyof typeof TODAY_SECTION_TITLE
  count: number
  children: React.ReactNode
}): React.ReactNode {
  return (
    <div data-share-section={name}>
      <p className={SECTION_HEAD}>
        {TODAY_SECTION_TITLE[name]}
        <span className="ml-1 tabular-nums">{count}</span>
      </p>
      <ul>{children}</ul>
      {moreText(count, SHARE_SECTION_LIMIT)}
    </div>
  )
}

export default function WorkShareCard({
  share,
  onOpenIssue,
  onOpenTodo,
  onOpenNote,
  onCopy
}: {
  share: WorkShare
  // 프로젝트 화면의 그 이슈
  onOpenIssue: (key: string) => void
  // 할 일 화면의 그 항목
  onOpenTodo: (id: number) => void
  // 회의록 화면의 그 회의록
  onOpenNote: (noteId: number) => void
  // 공유용 평문을 넘긴다. 클립보드에 쓰고 결과를 알리는 것은 받는 쪽이 한다
  onCopy: (text: string) => void
}): React.ReactNode {
  const empty = share.total === 0
  const pastMeetings = share.meetings.filter((m) => m.day === 'past')
  const todayMeetings = share.meetings.filter((m) => m.day === 'today')
  const pastEmpty = share.done.length === 0 && pastMeetings.length === 0
  const todayEmpty =
    share.doing.length === 0 && share.planned.length === 0 && todayMeetings.length === 0 && share.doneToday.length === 0
  const itemSection = (name: 'doing' | 'planned' | 'doneToday'): React.ReactNode => {
    const list = share[name]
    if (list.length === 0) return null
    return (
      <TodaySection name={name} count={list.length}>
        {list.slice(0, SHARE_SECTION_LIMIT).map((item) => (
          <ItemRow
            key={`${item.kind}-${item.id}`}
            // 오늘 완료는 메모 없이 제목만 보인다
            item={name === 'doneToday' ? { ...item, note: null } : item}
            onOpenIssue={onOpenIssue}
            onOpenTodo={onOpenTodo}
          />
        ))}
      </TodaySection>
    )
  }

  return (
    <Card padding="none">
      <section id="today-share" aria-labelledby="today-share-title">
        <div className={CARD_HEAD}>
          <h3 id="today-share-title" className="text-sm font-semibold text-gray-700">
            업무 공유
            {!empty ? <span className={CARD_COUNT}>{share.total}</span> : null}
            <span className="ml-2 text-xs font-normal text-gray-400 tabular-nums">{share.dateLabel}</span>
          </h3>
          <button
            type="button"
            onClick={() => onCopy(workShareText(share))}
            disabled={empty}
            title="팀 공유용 글로 복사해요"
            className="rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            복사
          </button>
        </div>

        {empty ? (
          <p className="px-4 pb-4 text-sm text-gray-400">공유할 작업이 없어요.</p>
        ) : (
          <>
            {!share.jiraKnown ? (
              <p data-share-section="jira-unknown" className="px-4 pb-1 text-xs text-gray-400">
                Jira 작업은 연결·불러오기 뒤에 보여요.
              </p>
            ) : null}
            {/* 카드 폭이 좁으면 1열로 쌓는다. 어제 열은 옅은 배경과 구분선으로 오늘 열과 갈린다 */}
            <div className="@container border-t border-gray-100">
              <div className="grid grid-cols-1 @min-[560px]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <div
                  data-share-column="past"
                  className="min-w-0 border-b border-gray-100 bg-gray-50/70 pb-2 @min-[560px]:rounded-bl-lg @min-[560px]:border-r @min-[560px]:border-b-0"
                >
                  <p className={COLUMN_HEAD}>
                    {share.pastTitle}
                    <span className="text-[11px] font-normal text-gray-400 tabular-nums">{share.range.label}</span>
                  </p>
                  {pastEmpty ? <p className={COLUMN_EMPTY}>{share.pastTitle} 완료한 작업이 없어요.</p> : null}
                  {share.done.length > 0 ? (
                    <div data-share-section="done">
                      <ul>
                        {share.done.slice(0, PAST_DONE_LIMIT).map((item) => (
                          <PastItemRow
                            key={`${item.kind}-${item.id}`}
                            item={item}
                            onOpenIssue={onOpenIssue}
                            onOpenTodo={onOpenTodo}
                          />
                        ))}
                      </ul>
                      {moreText(share.done.length, PAST_DONE_LIMIT)}
                    </div>
                  ) : null}
                  {pastMeetings.length > 0 ? (
                    <div data-share-section="past-meetings" className="mt-1">
                      <p className={SECTION_HEAD}>회의</p>
                      <ul>
                        {pastMeetings.slice(0, PAST_MEETING_LIMIT).map((row) => (
                          <PastMeetingRow
                            key={row.id}
                            row={row}
                            withDay={share.range.multiDay}
                            onOpenNote={onOpenNote}
                          />
                        ))}
                      </ul>
                      {moreText(pastMeetings.length, PAST_MEETING_LIMIT)}
                    </div>
                  ) : null}
                </div>

                <div data-share-column="today" className="min-w-0 pb-2">
                  <p className={COLUMN_HEAD}>오늘</p>
                  {todayEmpty ? <p className={COLUMN_EMPTY}>진행 중·예정 작업이 없어요.</p> : null}
                  {itemSection('doing')}
                  {itemSection('planned')}
                  {todayMeetings.length > 0 ? (
                    <TodaySection name="meetings" count={todayMeetings.length}>
                      {todayMeetings.slice(0, SHARE_SECTION_LIMIT).map((row) => (
                        <MeetingRow key={row.id} row={row} onOpenNote={onOpenNote} />
                      ))}
                    </TodaySection>
                  ) : null}
                  {itemSection('doneToday')}
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </Card>
  )
}
