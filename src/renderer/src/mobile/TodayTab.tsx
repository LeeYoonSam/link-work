// 모바일 '오늘' 탭. 데스크톱이 조립해 올린 오늘 대시보드 스냅샷을 그린다.
// 표시 규칙·문구는 데스크톱 today 카드(SignalPanel·ReleaseCard·JiraWorkCard·TodoCard·ScheduleCard)를 따른다.
// 데스크톱 카드는 스토어·네비게이션에 묶여 있어 가져오지 않고, 순수 모델·토큰만 가져온다.
// 화면 구성: sticky 헤더(대형 타이틀·새로고침) → 히어로(날짜·헤드라인·갱신 상태) → 신호 → 일정 → 다음 배포 → Jira → 할 일.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SignalSeverity } from '../types'
import type { JiraRow, NextRelease, ScheduleRow, TodayDashboard, TodaySignal } from '../components/today/todayModel'
import { visibleRefs } from '../components/today/todayModel'
import { SEVERITY_STYLE } from '../components/today/todayTokens'
import { statusVisual } from '../components/project/boardModel'
import { todoPriority } from '../components/ui/tokens'
import type { MobileTodaySnapshot } from './contract'
import type { MobileApi } from './api'
import { errorText, isAuthError, isNetworkError } from './api'
import { createRequestGate, dDayLabel, dueLabel, localDay, minutesUntil, monthDay, publishedAgo, shortDayLabel } from './mobileModel'
import { CheckButton, Empty, ErrorNote, PageHeader, RefreshButton, Section, Skeleton } from './ui'

/** 재발행을 요청한 뒤 최신본을 다시 읽기까지 기다리는 시간 */
export const FOLLOW_UP_MS = 1500
/** 화면이 보이는 동안 다시 읽는 주기 */
export const POLL_MS = 60_000

// ─── 신호 ─────────────────────────────────────────────────

/** severity 아이콘. 색과 함께 모양(◆ ▲ ●)과 글자 라벨로도 구분한다 */
function SeverityIcon({ severity }: { severity: SignalSeverity }): React.ReactNode {
  const s = SEVERITY_STYLE[severity]
  return (
    <span aria-hidden data-severity={severity} className="m-sev">
      <svg width="18" height="18" viewBox="0 0 16 16">
        {s.shape === 'diamond' ? (
          <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill="currentColor" />
        ) : s.shape === 'triangle' ? (
          <path d="M8 1.8 15 14H1Z" fill="currentColor" strokeLinejoin="round" />
        ) : (
          <circle cx="8" cy="8" r="4.5" fill="currentColor" />
        )}
      </svg>
    </span>
  )
}

const REF_TONE: Record<string, string | undefined> = { issue: 'mono', todo: 'success', meeting: 'purple', release: 'mono' }

/** meeting_soon 의 'n분 뒤'. 데스크톱 meetingSoonSuffix 와 같다 */
export function meetingSuffix(signal: TodaySignal, rows: ScheduleRow[], now: Date): string {
  if (signal.kind !== 'meeting_soon') return ''
  const ref = signal.refs.find((r) => r.type === 'meeting')
  const row = ref ? rows.find((r) => r.id === ref.id) : undefined
  if (!row) return ''
  const min = minutesUntil(row.startISO, now)
  return min > 0 ? `${min}분 뒤` : ''
}

function SignalItem({ signal: s, rows, now }: { signal: TodaySignal; rows: ScheduleRow[]; now: Date }): React.ReactNode {
  const style = SEVERITY_STYLE[s.severity]
  const suffix = meetingSuffix(s, rows, now)
  const { refs, moreCount } = visibleRefs(s)
  // 회의 신호는 문구에 이미 제목이 있어 칩을 그리지 않는다(데스크톱은 '일정 보기' 이동 칩)
  const chips = refs.filter((r) => r.type !== 'meeting')
  return (
    <li data-signal={s.id} data-severity={s.severity} className="m-signal">
      <SeverityIcon severity={s.severity} />
      <div className="min-w-0 flex-1">
        <span className="m-sev-label" data-severity={s.severity}>
          {style.label}
        </span>
        <p data-primary className="m-body-strong">
          {s.text}
          {suffix ? <span className="m-soon"> · {suffix}</span> : null}
        </p>
        {chips.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {chips.map((r) => (
              <span key={`${r.type}:${r.id}`} data-ref-type={r.type} data-tone={REF_TONE[r.type]} className="m-chip max-w-[16rem]">
                <span className="m-ellipsis">{r.label}</span>
              </span>
            ))}
            {moreCount > 0 ? <span className="m-meta">외 {moreCount}</span> : null}
          </div>
        ) : null}
      </div>
    </li>
  )
}

export function SignalsSection({ dashboard, now }: { dashboard: TodayDashboard; now: Date }): React.ReactNode {
  const hidden = dashboard.hiddenSignals ?? []
  const rows = dashboard.schedule.rows
  return (
    <Section id="m-signals" title="지금 챙길 것">
      {dashboard.signals.length === 0 ? (
        <Empty>{dashboard.summaryLine || '오늘 따로 챙길 일이 없어요.'}</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {dashboard.signals.map((s) => (
            <SignalItem key={s.id} signal={s} rows={rows} now={now} />
          ))}
        </ul>
      )}
      {hidden.length > 0 ? (
        <details className="mt-1">
          <summary className="m-more">외 {hidden.length}건 더 보기</summary>
          <ul className="flex flex-col gap-2">
            {hidden.map((s) => (
              <SignalItem key={s.id} signal={s} rows={rows} now={now} />
            ))}
          </ul>
        </details>
      ) : dashboard.hiddenSignalCount > 0 ? (
        <p className="m-card-foot">외 {dashboard.hiddenSignalCount}건</p>
      ) : null}
    </Section>
  )
}

// ─── Jira 행 ─────────────────────────────────────────────────

/** 상태 칩. 진행 카테고리를 모양(● ◐ ○)과 이름으로 함께 보인다 */
function StatusChip({ row }: { row: JiraRow }): React.ReactNode {
  const v = statusVisual(row.statusCategory)
  const tone = v.categoryLabel === '완료' ? 'success' : v.categoryLabel === '진행 중' ? 'accent' : undefined
  return (
    <span title={v.categoryLabel} data-tone={tone} className="m-chip max-w-[11rem]">
      <span aria-hidden>{v.shape}</span>
      <span className="m-ellipsis">{row.status}</span>
    </span>
  )
}

/** 마감 표시. 데스크톱 jiraDueText 와 같은 문구 */
export function jiraDue(
  row: Pick<JiraRow, 'duedate' | 'overdue' | 'dueToday'>,
  showAll = true
): { text: string; tone: 'danger' | 'warn' | undefined } | null {
  if (row.overdue) return { text: row.duedate && showAll ? `${monthDay(row.duedate)} 지남` : '마감 지남', tone: 'danger' }
  if (!showAll || !row.duedate) return null
  if (row.dueToday) return { text: '오늘 마감', tone: 'warn' }
  return { text: `${monthDay(row.duedate)} 마감`, tone: undefined }
}

/** 이슈 행 2줄: 제목 / 키·상태·마감 */
function IssueItem({ row, showAllDue = true }: { row: JiraRow; showAllDue?: boolean }): React.ReactNode {
  const due = jiraDue(row, showAllDue)
  return (
    <li data-issue={row.key} className="m-row">
      {row.signaled ? <span className="m-flag" role="img" aria-label="지금 챙길 것에 있음" /> : <span aria-hidden className="w-1.5 shrink-0" />}
      <div className="m-row-main">
        <p data-primary className={row.signaled ? 'm-body-strong' : 'm-body'}>
          {row.summary}
        </p>
        <div className="m-row-meta">
          <span data-tone="mono" className="m-chip">
            {row.key}
          </span>
          <StatusChip row={row} />
          {due ? (
            <span data-tone={due.tone} className="m-chip">
              {due.text}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  )
}

// ─── 다음 배포 ─────────────────────────────────────────────────

const PHASES: { key: NextRelease['phase']; label: string }[] = [
  { key: 'dev', label: '개발' },
  { key: 'qa', label: 'QA' },
  { key: 'release_day', label: '배포' }
]

const MINE_SEGMENTS: { key: 'done' | 'review' | 'progress' | 'todo'; label: string; cls: string }[] = [
  { key: 'done', label: '완료', cls: 'm-seg-done' },
  { key: 'review', label: '리뷰', cls: 'm-seg-review' },
  { key: 'progress', label: '진행', cls: 'm-seg-progress' },
  { key: 'todo', label: '할 일', cls: 'm-seg-todo' }
]

/** 내 작업 구간 막대 + 범례(색 점과 숫자를 함께 써 색에만 기대지 않는다) */
function MineBar({ mine }: { mine: NextRelease['mine'] }): React.ReactNode {
  if (mine.total === 0) return null
  const parts = MINE_SEGMENTS.filter((s) => mine[s.key] > 0)
  const text = parts.map((s) => `${s.label} ${mine[s.key]}`).join(' · ')
  return (
    <div data-testid="release-mine" className="mt-3">
      <p className="m-sub mb-1.5">
        내 작업 <strong className="m-c1">{mine.total}</strong>건 중 완료 {mine.done}
      </p>
      <span role="img" aria-label={`내 작업 ${mine.total}건: ${text}`} className="m-bar">
        {MINE_SEGMENTS.map((s) => (
          <span key={s.key} className={s.cls} style={{ width: `${(mine[s.key] / mine.total) * 100}%` }} />
        ))}
      </span>
      <div className="m-legend">
        {parts.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden className={`m-dot ${s.cls}`} />
            {s.label} {mine[s.key]}
          </span>
        ))}
      </div>
    </div>
  )
}

export function ReleaseSection({ dashboard }: { dashboard: TodayDashboard }): React.ReactNode {
  const r = dashboard.release
  if (!r) {
    const notConnected = dashboard.jira.state === 'not_connected' || dashboard.jira.state === 'no_project'
    return (
      <Section id="m-release" title="다음 배포">
        {dashboard.releaseUnknown ? (
          <Empty kind={notConnected ? 'link' : 'wait'}>
            {notConnected ? 'Jira를 연결하면 다음 배포가 보여요.' : 'Jira를 불러오면 다음 배포가 보여요.'}
          </Empty>
        ) : (
          <Empty>예정된 배포가 없어요.</Empty>
        )}
      </Section>
    )
  }
  const urgent = r.dDay <= 1
  const mineKnown = r.mineKnown !== false
  const at = PHASES.findIndex((p) => p.key === r.phase)
  // 단계 열은 좁아(360px 에서 약 100px) 요일 없이 'M/D' 로 줄이고, 요일까지 든 QA 구간은 아래 한 줄로 따로 보인다
  const qaFull = r.qaStart ? `${shortDayLabel(r.qaStart)}${r.qaEnd && r.qaEnd !== r.qaStart ? ` ~ ${shortDayLabel(r.qaEnd)}` : ''}` : '일정 없음'
  const qaShort = r.qaStart ? `${monthDay(r.qaStart)}${r.qaEnd && r.qaEnd !== r.qaStart ? `~${monthDay(r.qaEnd)}` : ''}` : '일정 없음'
  const sub: Record<NextRelease['phase'], string> = { dev: '', qa: qaShort, release_day: monthDay(r.date) }
  return (
    <section id="m-release" className="m-card" aria-labelledby="m-release-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="m-release-title" className="m-h2">
            다음 배포
          </h2>
          <p className="m-mono mt-1 text-[20px] font-bold">{r.version ?? '버전 미정'}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="m-dday" data-urgent={urgent ? 'true' : 'false'}>
            {dDayLabel(r.dDay)}
          </p>
          <p className="m-meta mt-1">{shortDayLabel(r.date)}</p>
        </div>
      </div>
      <ol aria-label="배포 단계" className="m-steps">
        {PHASES.map((p, i) => {
          const state = i < at ? 'done' : i === at ? 'current' : 'todo'
          return (
            <li key={p.key} data-phase={p.key} data-state={state} className="m-step">
              <span aria-hidden className="m-step-bar" />
              <span className="m-step-label">
                {p.label}
                {state === 'current' ? ' · 지금' : ''}
              </span>
              {sub[p.key] ? <span className="m-step-sub">{sub[p.key]}</span> : null}
            </li>
          )
        })}
      </ol>
      <p className="m-meta">QA {qaFull}</p>
      {!r.linked ? (
        <p data-testid="release-unlinked" className="m-sub mt-3">
          Jira 릴리스와 연결 안 됨 — 캘린더 일정만 보여요.
        </p>
      ) : mineKnown ? (
        <>
          <MineBar mine={r.mine} />
          {r.rows.length === 0 ? (
            <div className="mt-2">
              <Empty>{r.mine.total === 0 ? '이 배포에 든 내 작업이 없어요.' : '남은 내 작업이 없어요.'}</Empty>
            </div>
          ) : (
            <ul className="m-rows mt-2">
              {r.rows.map((row) => (
                <IssueItem key={row.key} row={row} showAllDue={false} />
              ))}
            </ul>
          )}
          {r.moreCount > 0 || r.totalCount !== null ? (
            <p className="m-card-foot">
              {r.totalCount !== null ? `전체 포함 ${r.totalCount}건` : ''}
              {r.moreCount > 0 ? `${r.totalCount !== null ? ' · ' : ''}외 ${r.moreCount}건` : ''}
            </p>
          ) : null}
        </>
      ) : (
        <div className="mt-2">
          <Empty kind="wait">Jira를 불러오면 이 배포의 내 작업이 보여요.</Empty>
        </div>
      )}
    </section>
  )
}

// ─── 내 Jira 작업 ─────────────────────────────────────────────────

const JIRA_EMPTY: Record<Exclude<TodayDashboard['jira']['state'], 'ok'>, { text: string; kind: 'link' | 'wait' | 'error' }> = {
  not_connected: { text: 'Jira가 연결되지 않았어요.', kind: 'link' },
  no_project: { text: '기본 Jira 프로젝트가 정해지지 않았어요.', kind: 'link' },
  loading: { text: 'Jira 작업을 불러오는 중…', kind: 'wait' },
  error: { text: 'Jira 작업을 불러오지 못했어요.', kind: 'error' }
}

export function JiraSection({ jira }: { jira: TodayDashboard['jira'] }): React.ReactNode {
  const total = jira.rows.length + jira.moreCount
  return (
    <Section id="m-jira" title="내 Jira 작업" meta={jira.state === 'ok' && total > 0 ? `${total}건` : undefined}>
      {jira.state !== 'ok' ? (
        <Empty kind={JIRA_EMPTY[jira.state].kind}>{JIRA_EMPTY[jira.state].text}</Empty>
      ) : jira.rows.length === 0 ? (
        <Empty>지금 맡은 진행 작업이 없어요.</Empty>
      ) : (
        <>
          <ul className="m-rows">
            {jira.rows.map((row) => (
              <IssueItem key={row.key} row={row} />
            ))}
          </ul>
          {jira.moreCount > 0 ? <p className="m-card-foot">외 {jira.moreCount}건은 Mac 에서 보기</p> : null}
        </>
      )}
    </Section>
  )
}

// ─── 할 일 요약 ─────────────────────────────────────────────────

export function TodoSummarySection({
  todos,
  today,
  doneIds,
  error,
  onComplete
}: {
  todos: TodayDashboard['todos']
  today: string
  // 완료를 눌러 서버 응답을 기다리거나 끝난 행. 체크 표시로 보인다
  doneIds: number[]
  error: string | null
  onComplete: (id: number) => void
}): React.ReactNode {
  return (
    <Section id="m-todos" title="할 일" meta={todos.doneTodayCount > 0 ? `오늘 완료 ${todos.doneTodayCount}` : undefined}>
      <ErrorNote text={error} />
      {todos.rows.length === 0 ? (
        <Empty>남은 할 일이 없어요.</Empty>
      ) : (
        <ul className="m-rows">
          {todos.rows.map((row) => {
            const done = doneIds.includes(row.id)
            const due = dueLabel(row.dueDate, today)
            const pri = todoPriority[row.priority]
            return (
              <li key={row.id} data-todo={row.id} className="m-row">
                <CheckButton checked={done} disabled={done} label={`${row.title} 완료`} onClick={() => onComplete(row.id)} />
                <div className="m-row-main pt-0.5">
                  <p data-primary className={`${row.signaled ? 'm-body-strong' : 'm-body'} ${done ? 'm-done-title' : ''}`}>
                    {row.title}
                  </p>
                  {(row.priority === 'high' && pri) || due ? (
                    <div className="m-row-meta">
                      {row.priority === 'high' && pri ? (
                        <span data-tone="danger" className="m-chip" title={`우선순위 ${pri.label}`}>
                          우선순위 {pri.label}
                        </span>
                      ) : null}
                      {due ? (
                        <span data-tone={due.bucket === 'overdue' ? 'danger' : due.bucket === 'today' ? 'warn' : undefined} className="m-chip">
                          {due.bucket === 'today' ? '오늘 마감' : due.text}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {todos.moreCount > 0 ? <p className="m-card-foot">외 {todos.moreCount}건 — 할 일 탭에서 보기</p> : null}
    </Section>
  )
}

// ─── 일정 ─────────────────────────────────────────────────

function ScheduleItem({ row }: { row: ScheduleRow }): React.ReactNode {
  const current = row.timing === 'current'
  const other = !!row.calendarId && row.calendarId !== 'primary'
  return (
    <li data-timing={row.timing} className="m-tl-row">
      <span className="m-tl-time">
        {row.start}
        <small>{row.end}</small>
      </span>
      <span className="m-tl-rail" aria-hidden>
        <span className="m-tl-dot" />
      </span>
      <div className="m-tl-body">
        <p data-primary className={current ? 'm-body-strong' : 'm-body'}>
          {row.title}
        </p>
        {current || other || row.location ? (
          <div className="m-row-meta">
            {current ? (
              <span data-tone="purple" className="m-chip">
                진행 중
              </span>
            ) : null}
            {other ? <span className="m-chip">다른 캘린더</span> : null}
            {row.location ? <span className="m-meta min-w-0">{row.location}</span> : null}
          </div>
        ) : null}
      </div>
    </li>
  )
}

export function ScheduleSection({ schedule, now }: { schedule: TodayDashboard['schedule']; now?: Date }): React.ReactNode {
  if (!schedule.connected) {
    return (
      <Section id="m-schedule" title="일정">
        <Empty kind="link">캘린더가 연결되지 않았어요.</Empty>
      </Section>
    )
  }
  const clock = now ? `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` : null
  const nowLine = clock ? (
    <li key="now-line" className="m-now" aria-label={`지금 ${clock}`} data-testid="now-line">
      <span>{clock}</span>
      <span aria-hidden />
      <span aria-hidden />
    </li>
  ) : null
  return (
    <Section id="m-schedule" title="일정">
      {schedule.allDay.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {schedule.allDay.map((a) => (
            <span key={a.id} title="종일" className="m-chip max-w-full">
              <span className="m-meta shrink-0">종일</span>
              <span className="m-ellipsis">{a.title}</span>
            </span>
          ))}
        </div>
      ) : null}
      {schedule.rows.length === 0 ? (
        <Empty>오늘 시간 일정이 없어요.</Empty>
      ) : (
        <ul className="m-tl">
          {schedule.rows.flatMap((row, i) => [
            i === schedule.nowIndex ? nowLine : null,
            <ScheduleItem key={row.id} row={row} />
          ])}
          {schedule.nowIndex >= schedule.rows.length ? nowLine : null}
        </ul>
      )}
      <p className="m-card-foot">
        <strong className="m-c2 font-semibold">내일</strong>{' '}
        {schedule.tomorrowCount > 0
          ? `일정 ${schedule.tomorrowCount}건${schedule.tomorrowFirst ? ` · 첫 ${schedule.tomorrowFirst}` : ''}`
          : '시간 일정 없음'}
      </p>
    </Section>
  )
}

// ─── 화면 ─────────────────────────────────────────────────

export const SNAPSHOT_EMPTY_TEXT = 'Mac 의 LinkWork 에서 아직 오늘 화면을 준비하지 못했어요. 잠시 뒤 다시 시도하세요.'

export interface TodayContentProps {
  /** undefined = 아직 한 번도 못 읽음, null = 서버에 스냅샷 없음 */
  snapshot: MobileTodaySnapshot | null | undefined
  now: Date
  refreshing: boolean
  error: string | null
  todoError: string | null
  doneTodoIds: number[]
  onRefresh: () => void
  onCompleteTodo: (id: number) => void
}

/** 오늘 탭 본문. 훅을 쓰지 않는다 */
export function TodayContent(p: TodayContentProps): React.ReactNode {
  const header = <PageHeader title="오늘" actions={<RefreshButton busy={p.refreshing} onClick={p.onRefresh} />} />

  if (p.snapshot === undefined) {
    return (
      <>
        {header}
        <div className="m-stack">{p.error ? <ErrorNote text={p.error} /> : <Skeleton lines={4} />}</div>
      </>
    )
  }

  if (p.snapshot === null) {
    return (
      <>
        {header}
        <div className="m-card flex flex-col items-center gap-4 px-5 py-8 text-center">
          <p data-testid="snapshot-empty" data-primary className="m-body m-c2">
            {SNAPSHOT_EMPTY_TEXT}
          </p>
          <ErrorNote text={p.error} />
          <button type="button" onClick={p.onRefresh} disabled={p.refreshing} className="m-btn">
            {p.refreshing ? '읽는 중…' : '다시 읽기'}
          </button>
        </div>
      </>
    )
  }

  const { dashboard } = p.snapshot
  const ago = publishedAgo(p.snapshot.publishedAt, p.now)
  const today = dashboard.date || localDay(p.now)
  return (
    <>
      {header}
      <div className="m-stack">
        <section className="m-card m-hero" aria-label="오늘 요약">
          <p className="m-sub font-semibold">{p.snapshot.heading}</p>
          <p data-testid="today-headline" data-primary className="m-headline">
            {dashboard.headline}
          </p>
          <span data-testid="published-ago" data-stale={ago.stale ? 'true' : 'false'} className="m-status">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              {ago.stale ? <path d="M12 7v6M12 17v.01" /> : <path d="m6 12.5 4 4 8-9" />}
            </svg>
            {ago.text}
            {ago.stale ? ' · 오래된 내용일 수 있어요' : ''}
          </span>
          {p.snapshot.loading ? <p className="m-meta mt-2">Mac 에서 일정·Jira 를 불러오는 중이었어요.</p> : null}
        </section>
        <ErrorNote text={p.error} />
        <SignalsSection dashboard={dashboard} now={p.now} />
        <ScheduleSection schedule={dashboard.schedule} now={p.now} />
        <ReleaseSection dashboard={dashboard} />
        <JiraSection jira={dashboard.jira} />
        <TodoSummarySection
          todos={dashboard.todos}
          today={today}
          doneIds={p.doneTodoIds}
          error={p.todoError}
          onComplete={p.onCompleteTodo}
        />
      </div>
    </>
  )
}

export interface TabProps {
  api: MobileApi
  /** 바뀌면 다시 읽는다(오프라인 배너의 '다시 시도') */
  reloadKey: number
  /** 요청 성공·실패를 연결 상태에 알린다 */
  onOk: () => void
  onFail: (e: unknown) => void
}

export default function TodayTab({ api, reloadKey, onOk, onFail }: TabProps): React.ReactNode {
  const [snapshot, setSnapshot] = useState<MobileTodaySnapshot | null | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [todoError, setTodoError] = useState<string | null>(null)
  const [doneIds, setDoneIds] = useState<number[]>([])
  const [now, setNow] = useState(() => new Date())
  const followUp = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 진입·재발행 뒤 다시 읽기·60초 폴링이 겹칠 수 있다. 마지막으로 시작한 읽기의 응답만 적용한다
  const gate = useRef(createRequestGate()).current

  const load = useCallback(async (): Promise<void> => {
    const seq = gate.begin()
    try {
      const res = await api.getToday()
      if (!gate.isLatest(seq)) return
      setSnapshot(res.snapshot)
      setError(null)
      setDoneIds([])
      onOk()
    } catch (e) {
      if (!gate.isLatest(seq)) return
      onFail(e)
      // 네트워크·만료는 앱 전체가 안내한다. 마지막 스냅샷은 그대로 둔다
      if (!isAuthError(e) && !isNetworkError(e)) setError(errorText(e))
    } finally {
      setNow(new Date())
    }
  }, [api, onOk, onFail, gate])

  /** 읽고(서버가 Mac 에 재발행 요청) 잠시 뒤 한 번 더 읽어 최신본을 반영한다 */
  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    if (followUp.current) clearTimeout(followUp.current)
    await load()
    setRefreshing(false)
    followUp.current = setTimeout(() => {
      followUp.current = null
      void load()
    }, FOLLOW_UP_MS)
  }, [load])

  useEffect(() => {
    let poll: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (poll) return
      poll = setInterval(() => void load(), POLL_MS)
    }
    const stop = (): void => {
      if (poll) clearInterval(poll)
      poll = null
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh()
        start()
      } else {
        stop()
        if (followUp.current) clearTimeout(followUp.current)
      }
    }
    void refresh()
    if (document.visibilityState === 'visible') start()
    // 'n분 전 갱신' 이 흐르도록 시계만 따로 돌린다
    const tick = setInterval(() => setNow(new Date()), 30_000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      clearInterval(tick)
      if (followUp.current) clearTimeout(followUp.current)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh, load, reloadKey])

  const completeTodo = async (id: number): Promise<void> => {
    setTodoError(null)
    // 완료 전에 시작한 읽기가 체크 표시를 지우고 옛 행을 되살리지 않게 버린다
    gate.invalidate()
    setDoneIds((cur) => (cur.includes(id) ? cur : [...cur, id]))
    try {
      await api.completeTodo(id)
      onOk()
      void refresh()
    } catch (e) {
      setDoneIds((cur) => cur.filter((x) => x !== id))
      onFail(e)
      setTodoError(isNetworkError(e) ? 'Mac 에 연결할 수 없어 완료하지 못했어요.' : `완료하지 못했어요: ${errorText(e)}`)
    }
  }

  return (
    <TodayContent
      snapshot={snapshot}
      now={now}
      refreshing={refreshing}
      error={error}
      todoError={todoError}
      doneTodoIds={doneIds}
      onRefresh={() => void refresh()}
      onCompleteTodo={(id) => void completeTodo(id)}
    />
  )
}
