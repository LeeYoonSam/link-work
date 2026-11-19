// 오늘 대시보드의 '다음 배포' 카드 (docs/ASSISTANT.md 부록 O, docs/RELEASE_NOTES.md '오늘 화면의 다음 배포 판정').
// 판정은 releaseModel 이 한다. 여기서는 그리기와 이동만 한다.
import type { JiraRow, NextRelease } from './releaseModel'
import { Card } from '../ui'
import { IssueRow } from './JiraWorkCard'
import { CARD_COUNT, CARD_HEAD, MORE_LINK } from './todayTokens'

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

/** 'YYYY-MM-DD' → '11/24(화)'. 형식이 틀리면 그대로 */
export function shortDayLabel(date: string | null): string {
  if (!date) return ''
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return date
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return `${Number(m[2])}/${Number(m[3])}(${WEEKDAYS[d.getDay()]})`
}

/** D-day 라벨. 0 → 'D-day', 5 → 'D-5', -1 → 'D+1' */
export function dDayLabel(dDay: number): string {
  if (dDay === 0) return 'D-day'
  return dDay > 0 ? `D-${dDay}` : `D+${-dDay}`
}

type Phase = NextRelease['phase']
const PHASE_ORDER: Phase[] = ['dev', 'qa', 'release_day']

/** 단계 선 데이터. 현재 단계는 current, 앞은 done, 뒤는 todo */
export function phaseSteps(r: Pick<NextRelease, 'phase' | 'qaStart' | 'qaEnd' | 'date'>): {
  key: Phase
  label: string
  sub: string
  state: 'done' | 'current' | 'todo'
}[] {
  const at = PHASE_ORDER.indexOf(r.phase)
  const state = (i: number): 'done' | 'current' | 'todo' => (i < at ? 'done' : i === at ? 'current' : 'todo')
  const md = (d: string | null): string => shortDayLabel(d)
  const qaSub = r.qaStart ? `${md(r.qaStart)}${r.qaEnd && r.qaEnd !== r.qaStart ? `~${md(r.qaEnd)}` : ''}` : '일정 없음'
  return [
    { key: 'dev', label: '개발', sub: '', state: state(0) },
    { key: 'qa', label: 'QA', sub: qaSub, state: state(1) },
    { key: 'release_day', label: '배포', sub: md(r.date), state: state(2) }
  ]
}

function PhaseLine({ release }: { release: NextRelease }): React.ReactNode {
  const steps = phaseSteps(release)
  return (
    <ol aria-label="배포 단계" className="flex items-start px-4 pt-1 pb-3">
      {steps.map((s, i) => (
        <li key={s.key} data-phase={s.key} data-state={s.state} className={`flex min-w-0 items-start ${i < steps.length - 1 ? 'flex-1' : ''}`}>
          <div className="flex min-w-0 flex-col items-center text-center">
            <span
              aria-hidden
              className={`mt-0.5 block h-3 w-3 rounded-full border-2 ${
                s.state === 'current'
                  ? 'border-blue-600 bg-blue-600 ring-4 ring-blue-100'
                  : s.state === 'done'
                    ? 'border-gray-400 bg-gray-400'
                    : 'border-gray-300 bg-white'
              }`}
            />
            <span
              className={`mt-1.5 whitespace-nowrap text-xs ${
                s.state === 'current' ? 'font-semibold text-blue-700' : s.state === 'done' ? 'text-gray-500' : 'text-gray-600'
              }`}
            >
              {s.label}
              {s.state === 'current' ? <span className="sr-only"> (오늘)</span> : null}
            </span>
            {s.sub ? <span className="mt-0.5 whitespace-nowrap text-[11px] text-gray-400 tabular-nums">{s.sub}</span> : null}
            {s.state === 'current' ? (
              <span aria-hidden className="mt-0.5 text-xs font-semibold text-blue-600">
                오늘
              </span>
            ) : null}
          </div>
          {i < steps.length - 1 ? (
            <span
              aria-hidden
              className={`mx-1 mt-[0.6rem] h-0.5 min-w-4 flex-1 rounded-full ${i < PHASE_ORDER.indexOf(release.phase) ? 'bg-gray-400' : 'bg-gray-200'}`}
            />
          ) : null}
        </li>
      ))}
    </ol>
  )
}

const MINE_SEGMENTS: { key: 'done' | 'review' | 'progress' | 'todo'; label: string; color: string }[] = [
  { key: 'done', label: '완료', color: 'bg-green-500' },
  { key: 'review', label: '리뷰', color: 'bg-violet-500' },
  { key: 'progress', label: '진행', color: 'bg-blue-500' },
  { key: 'todo', label: '할 일', color: 'bg-gray-300' }
]

/** 내 작업 막대. 색에만 기대지 않도록 범례에 같은 색 점과 숫자를 함께 쓴다. 0건이면 그리지 않는다 */
export function MineBar({ mine }: { mine: NextRelease['mine'] }): React.ReactNode {
  if (mine.total === 0) return null
  const pct = (n: number): string => `${(n / mine.total) * 100}%`
  const parts = MINE_SEGMENTS.filter((s) => mine[s.key] > 0)
  const text = parts.map((s) => `${s.label} ${mine[s.key]}`).join(' · ')
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-2">
      <span className="text-xs font-medium text-gray-600 whitespace-nowrap">
        내 작업 <span className="tabular-nums">{mine.total}</span>
      </span>
      <span
        role="img"
        aria-label={`내 작업 ${mine.total}건: ${text}`}
        className="flex h-2 min-w-24 max-w-60 flex-1 overflow-hidden rounded-full bg-gray-100"
      >
        {MINE_SEGMENTS.map((s) => (
          <span key={s.key} className={s.color} style={{ width: pct(mine[s.key]) }} />
        ))}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-gray-500 tabular-nums">
        {parts.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1 whitespace-nowrap">
            <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${s.color}`} />
            {s.label} {mine[s.key]}
          </span>
        ))}
      </span>
    </div>
  )
}

/** 배포 카드의 이슈 행. 내 Jira 작업 카드와 같은 1줄 모양이다. 마감은 지난 경우만 보인다 */
export function ReleaseIssueRow({ row, onOpenIssue }: { row: JiraRow; onOpenIssue: (row: JiraRow) => void }): React.ReactNode {
  return <IssueRow row={row} onOpenIssue={onOpenIssue} showDue={false} />
}

export default function ReleaseCard({
  release,
  onOpenIssue,
  onOpenRelease,
  unknownReason = null
}: {
  release: NextRelease | null
  // release 가 null 인 까닭이 Jira 를 몰라서일 때(TodayDashboard.releaseUnknown).
  // 'not_connected' = 미연결·기본 프로젝트 없음, 'load_failed' = 불러오기 실패·불러오는 중
  unknownReason?: 'not_connected' | 'load_failed' | null
  onOpenIssue: (row: JiraRow) => void
  // 릴리스 탭(해당 릴리스)으로 간다
  onOpenRelease: () => void
}): React.ReactNode {
  if (!release) {
    return (
      <Card padding="none">
        <section id="today-release" aria-label="다음 배포">
          <div className={CARD_HEAD}>
            <h3 className="text-sm font-semibold text-gray-700">다음 배포</h3>
          </div>
          <p className="px-4 pb-4 text-sm text-gray-400">
            {unknownReason === 'not_connected'
              ? 'Jira를 연결하면 다음 배포가 보여요.'
              : unknownReason === 'load_failed'
                ? 'Jira를 불러오면 다음 배포가 보여요.'
                : '예정된 배포가 없어요.'}
          </p>
        </section>
      </Card>
    )
  }

  // mineKnown=false: Jira 스냅샷이 없어 내 작업을 셀 수 없다(0건과 다르다). 옛 모델에는 필드가 없어 true 로 본다
  const mineKnown = release.mineKnown !== false
  const urgent = release.dDay <= 1
  const title = release.version ?? '버전 미정'
  return (
    <Card padding="none">
      <section id="today-release" aria-label={`다음 배포 ${title}`}>
        <div className={CARD_HEAD}>
          <h3 className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm font-semibold text-gray-700">
            <span>다음 배포</span>
            <span className="font-mono text-base font-semibold text-gray-900">{title}</span>
          </h3>
          <span className="flex items-center gap-2 text-xs text-gray-500 tabular-nums">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                urgent ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'
              }`}
            >
              {dDayLabel(release.dDay)}
            </span>
            <span>{shortDayLabel(release.date)}</span>
          </span>
        </div>

        <PhaseLine release={release} />

        {!release.linked ? (
          <p data-testid="release-unlinked" className="mx-4 mb-4 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
            Jira 릴리스와 연결 안 됨 — 캘린더 일정만 보여요.
          </p>
        ) : (
          <>
            {mineKnown ? (
              <>
                <MineBar mine={release.mine} />
                {release.rows.length === 0 ? (
                  <p className="px-4 pb-3 text-xs text-gray-400">
                    {release.mine.total === 0 ? '이 배포에 든 내 작업이 없어요.' : '남은 내 작업이 없어요.'}
                  </p>
                ) : (
                  <ul className="pb-1">
                    {release.rows.map((row) => (
                      <ReleaseIssueRow key={row.key} row={row} onOpenIssue={onOpenIssue} />
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p data-testid="release-mine-unknown" className="px-4 pb-3 text-xs text-gray-400">
                Jira를 불러오면 이 배포의 내 작업이 보여요.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-2">
              <span className="text-xs text-gray-400 tabular-nums">
                {release.totalCount !== null ? (
                  <>
                    전체 포함<span className={CARD_COUNT}>{release.totalCount}건</span>
                  </>
                ) : null}
              </span>
              <button type="button" onClick={onOpenRelease} className={MORE_LINK}>
                {release.moreCount > 0 ? `외 ${release.moreCount}건 →` : '릴리스 노트 →'}
              </button>
            </div>
          </>
        )}
      </section>
    </Card>
  )
}
