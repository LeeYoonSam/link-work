// 오늘 대시보드의 '내 Jira 작업' 카드 (docs/ASSISTANT.md 부록 O).
// 행 선택·정렬·상한은 todayModel 이 프로젝트 화면 규칙(boardModel)으로 한다. 여기서는 그리기와 이동만 한다.
import type { JiraRow, TodayDashboard } from './todayModel'
import { Card } from '../ui'
import { JiraStatusBadge } from '../project/BoardBits'
import {
  CARD_COUNT,
  CARD_HEAD,
  DUE_OVERDUE,
  DUE_TODAY,
  ISSUE_KEY,
  MORE_LINK,
  ROW,
  ROW_TITLE,
  SIGNALED_MARK
} from './todayTokens'

/** 마감 표시. 지남·오늘만 글자로 강조한다. 그 밖은 'M/D 마감' */
export function jiraDueText(row: Pick<JiraRow, 'duedate' | 'overdue' | 'dueToday'>): { text: string; cls: string } | null {
  if (!row.duedate) return null
  const m = row.duedate.match(/^\d{4}-(\d{2})-(\d{2})$/)
  const md = m ? `${Number(m[1])}/${Number(m[2])}` : row.duedate
  if (row.overdue) return { text: `${md} 지남`, cls: DUE_OVERDUE }
  if (row.dueToday) return { text: '오늘 마감', cls: DUE_TODAY }
  return { text: `${md} 마감`, cls: 'text-gray-500' }
}

/**
 * 이슈 행 1줄: 신호 표식 · 키 · 제목 · (마감) 상태 배지. 배지는 제목 바로 뒤에 붙고 좁으면 줄바꿈한다.
 * 다음 배포 카드도 같은 행 모양을 쓴다
 */
export function IssueRow({
  row,
  onOpenIssue,
  showDue = true
}: {
  row: JiraRow
  onOpenIssue: (row: JiraRow) => void
  showDue?: boolean
}): React.ReactNode {
  const due = showDue ? jiraDueText(row) : row.overdue ? { text: '마감 지남', cls: DUE_OVERDUE } : null
  return (
    <li data-issue={row.key} className={ROW}>
      <span className="flex h-5 w-2 shrink-0 items-center">
        {row.signaled ? <span className={SIGNALED_MARK} title="지금 챙길 것에 있음" aria-label="지금 챙길 것에 있음" /> : null}
      </span>
      <button
        type="button"
        onClick={() => onOpenIssue(row)}
        className={`${ISSUE_KEY} mt-0.5 hover:bg-indigo-100`}
        title={`${row.key} 프로젝트 화면에서 보기`}
      >
        {row.key}
      </button>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={`${ROW_TITLE} max-w-full flex-none basis-auto ${row.signaled ? 'font-medium text-gray-900' : ''}`}>
          {row.summary}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {due ? <span className={`text-[11px] tabular-nums whitespace-nowrap ${due.cls}`}>{due.text}</span> : null}
          <JiraStatusBadge status={row.status} category={row.statusCategory} />
        </span>
      </div>
    </li>
  )
}

export function JiraWorkRow({ row, onOpenIssue }: { row: JiraRow; onOpenIssue: (row: JiraRow) => void }): React.ReactNode {
  return <IssueRow row={row} onOpenIssue={onOpenIssue} />
}

const EMPTY_TEXT: Record<Exclude<TodayDashboard['jira']['state'], 'ok'>, string> = {
  not_connected: 'Jira가 연결되지 않았어요.',
  no_project: '기본 Jira 프로젝트가 정해지지 않았어요.',
  loading: 'Jira 작업을 불러오는 중…',
  error: 'Jira 작업을 불러오지 못했어요.'
}

export default function JiraWorkCard({
  jira,
  onOpenIssue,
  onOpenBoard,
  onOpenSettings,
  errorText = null,
  onRetry,
  retrying = false
}: {
  jira: TodayDashboard['jira']
  // 'error' 상태일 때 덧붙일 오류 문구(jiraBoardStore.error)
  errorText?: string | null
  // 'error' 상태의 다시 시도(todayStore.refresh). 진행 중이면 retrying
  onRetry?: () => void
  retrying?: boolean
  onOpenIssue: (row: JiraRow) => void
  // 프로젝트 화면 티켓 탭
  onOpenBoard: () => void
  // 설정 > 연동
  onOpenSettings: () => void
}): React.ReactNode {
  const total = jira.rows.length + jira.moreCount
  return (
    <Card padding="none">
      <section id="today-jira" aria-labelledby="today-jira-title">
        <div className={CARD_HEAD}>
          <h3 id="today-jira-title" className="text-sm font-semibold text-gray-700">
            내 Jira 작업
            {jira.state === 'ok' && total > 0 ? <span className={CARD_COUNT}>{total}</span> : null}
          </h3>
          {jira.state === 'ok' ? (
            <button type="button" onClick={onOpenBoard} className={MORE_LINK}>
              티켓 보드 →
            </button>
          ) : null}
        </div>

        {jira.state !== 'ok' ? (
          <div className="px-4 pb-4 text-sm text-gray-400">
            <p>{EMPTY_TEXT[jira.state]}</p>
            {jira.state === 'error' ? (
              <>
                {errorText ? <p className="mt-1 break-words text-xs text-red-600">{errorText}</p> : null}
                {onRetry ? (
                  <button
                    type="button"
                    onClick={onRetry}
                    disabled={retrying}
                    className="mt-2 rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {retrying ? '다시 불러오는 중…' : '다시 시도'}
                  </button>
                ) : null}
              </>
            ) : null}
            {jira.state === 'not_connected' || jira.state === 'no_project' ? (
              <button type="button" onClick={onOpenSettings} className={`mt-1 ${MORE_LINK}`}>
                설정에서 연결하기 →
              </button>
            ) : null}
          </div>
        ) : jira.rows.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-gray-400">지금 맡은 진행 작업이 없어요.</p>
        ) : (
          <>
            <ul className="pb-1">
              {jira.rows.map((row) => (
                <JiraWorkRow key={row.key} row={row} onOpenIssue={onOpenIssue} />
              ))}
            </ul>
            {jira.moreCount > 0 ? (
              <div className="border-t border-gray-100 px-4 py-2 text-right">
                <button type="button" onClick={onOpenBoard} className={MORE_LINK}>
                  외 {jira.moreCount}건 →
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </Card>
  )
}
