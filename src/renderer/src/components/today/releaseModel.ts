// 오늘 대시보드의 "다음 배포" 순수 모델.
// React·스토어·window 를 쓰지 않는다. 오늘 날짜(YYYY-MM-DD)는 호출부가 넘긴다.
// 규칙의 근거는 docs/RELEASE_NOTES.md "오늘 화면의 다음 배포 판정" 절이다.
// 거짓 경보 방어가 최우선이다 — 캘린더 일정과 Jira 릴리스가 연결되지 않으면 위험을 말하지 않는다.
import type {
  CalendarEvent,
  JiraBoardIssue,
  JiraBoardSnapshot,
  JiraStatusCategory,
  ReleaseNoteSummary
} from '../../types'
import { compareIssueKeys, isOverdue, isReviewStatus, isRevealable } from '../project/boardModel'

// ─── 캘린더 일정 분류 ─────────────────────────────────────────

export interface ReleaseCalendarEvent {
  kind: 'release' | 'qa'
  title: string
  /** 제목에서 읽은 x.y.z. 없으면 null */
  version: string | null
  /** YYYY-MM-DD */
  start: string
  /** 포함 종료일 YYYY-MM-DD. Google 종일 일정의 end.date 는 배타적이라 하루 뺀다 */
  endInclusive: string
}

const RELEASE_TITLE_RE = /^app\s*release\b/i
const QA_TITLE_RE = /^\[qa\]/i
const TRAIN_TITLE_RE = /release\s*train/i
const TITLE_VERSION_RE = /v?(\d+\.\d+\.\d+)/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 종일 일정만 본다. 'App Release(v4.177.0)' → release, '[QA] Release Train' → qa.
 * 시간 있는 회의(예: 'Release Train 회고')는 배포 일정이 아니다.
 */
export function classifyReleaseEvent(e: CalendarEvent): ReleaseCalendarEvent | null {
  if (!e.allDay) return null
  const start = e.start.slice(0, 10)
  if (!DATE_RE.test(start)) return null
  const title = (e.summary ?? '').trim()
  let kind: ReleaseCalendarEvent['kind'] | null = null
  if (RELEASE_TITLE_RE.test(title)) kind = 'release'
  else if (QA_TITLE_RE.test(title) || TRAIN_TITLE_RE.test(title)) kind = 'qa'
  if (!kind) return null
  const endRaw = (e.end ?? '').slice(0, 10)
  const endInclusive = DATE_RE.test(endRaw) ? shiftDay(endRaw, -1) : start
  const m = kind === 'release' ? TITLE_VERSION_RE.exec(title) : null
  return {
    kind,
    title,
    version: m ? m[1] : null,
    start,
    endInclusive: endInclusive < start ? start : endInclusive
  }
}

/** 'v4.177.0'·'4.177.0' → '4.177.0'. 접미사가 붙은 이름('4.177.0-alpha02')·그 밖의 형식은 null */
export function normalizeVersion(name: string): string | null {
  const m = /^v?(\d+\.\d+\.\d+)$/i.exec((name ?? '').trim())
  return m ? m[1] : null
}

// ─── 날짜 도우미 ─────────────────────────────────────────────

/** 'YYYY-MM-DD' 에 n 일을 더한 날짜 */
export function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10)
}

/** to − from 일수. 둘 다 'YYYY-MM-DD' */
export function dayDiff(from: string, to: string): number {
  const ms = (s: string): number => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((ms(to) - ms(from)) / 86_400_000)
}

// ─── 다음 배포 ─────────────────────────────────────────────

export interface JiraRow {
  key: string
  summary: string
  status: string
  statusCategory: JiraStatusCategory
  /** 진행 중 카테고리이면서 리뷰·QA 계열 상태명 */
  review: boolean
  duedate: string | null
  overdue: boolean
  dueToday: boolean
  /** 화면 위 신호에 올라간 이슈. 카드에서는 강조 표식만 한다 */
  signaled: boolean
  /** 프로젝트 화면 트리에서 보여 줄 수 있는가(boardModel.isRevealable) */
  revealable: boolean
}

export interface ReleaseMine {
  total: number
  done: number
  review: number
  progress: number
  todo: number
}

export interface NextRelease {
  version: string | null
  /** YYYY-MM-DD */
  date: string
  dDay: number
  /** Jira 릴리스와 매칭됨 */
  linked: boolean
  noteId: number | null
  jiraVersionId: string | null
  /** QA 포함 구간. 없으면 null */
  qaStart: string | null
  qaEnd: string | null
  phase: 'dev' | 'qa' | 'release_day'
  /** note.item_count. 미연결이면 null */
  totalCount: number | null
  /**
   * 내 작업을 셀 수 있었는가. Jira 스냅샷이 있고 내 계정 id 를 알 때만 true.
   * false 면 mine 은 0 이지만 "내 작업이 없다"는 뜻이 아니다. 위험(release_risk)도 만들지 않는다.
   * 계약 뒤에 추가한 필드라 선택이지만 resolveNextRelease 는 늘 채운다. 없으면 아는 것으로 본다.
   */
  mineKnown?: boolean
  mine: ReleaseMine
  /** 위험 행 전부 + 나머지 상한 RELEASE_ROW_LIMIT. 완료는 넣지 않는다 */
  rows: JiraRow[]
  moreCount: number
}

export interface ReleaseModelInput {
  /** 오늘 YYYY-MM-DD(로컬) */
  today: string
  events: CalendarEvent[]
  notes: ReleaseNoteSummary[]
  snapshot: JiraBoardSnapshot | null
}

export const RELEASE_ROW_LIMIT = 3
/** QA 일정이 배포일보다 이만큼 앞에서 끝나도 그 배포의 QA 로 본다 */
const QA_GAP_DAYS = 4

const emptyMine = (): ReleaseMine => ({ total: 0, done: 0, review: 0, progress: 0, todo: 0 })

/** 날짜가 있고 보관되지 않았으며 정식 버전 이름(x.y.z)을 가진 릴리스만 다음 배포 후보다 */
function noteCandidates(notes: ReleaseNoteSummary[], today: string): ReleaseNoteSummary[] {
  return notes
    .filter(
      (n) =>
        !!n.release_date &&
        n.release_date.slice(0, 10) >= today &&
        !(n.archived ?? 0) &&
        normalizeVersion(n.version_name) !== null
    )
    .sort(
      (a, b) =>
        a.release_date!.slice(0, 10).localeCompare(b.release_date!.slice(0, 10)) ||
        a.version_name.localeCompare(b.version_name, undefined, { numeric: true })
    )
}

/** 캘린더 배포 일정에 맞는 Jira 릴리스. 버전 일치가 먼저, 날짜 일치가 다음이다 */
function matchNote(
  cal: ReleaseCalendarEvent,
  notes: ReleaseNoteSummary[],
  candidates: ReleaseNoteSummary[]
): ReleaseNoteSummary | null {
  if (cal.version) {
    const byVersion = notes.find((n) => !(n.archived ?? 0) && normalizeVersion(n.version_name) === cal.version)
    if (byVersion) return byVersion
  }
  return candidates.find((n) => n.release_date!.slice(0, 10) === cal.start) ?? null
}

/** 스냅샷에서 그 릴리스에 묶인 이슈(fixVersion id 또는 정규화한 이름 일치). 에픽은 뺀다 */
export function issuesInRelease(
  issues: JiraBoardIssue[],
  version: string | null,
  jiraVersionId: string | null
): JiraBoardIssue[] {
  if (!version && !jiraVersionId) return []
  return issues.filter(
    (i) =>
      i.level !== 'epic' &&
      (i.fixVersions ?? []).some(
        (v) => (jiraVersionId !== null && v.id === jiraVersionId) || (version !== null && normalizeVersion(v.name) === version)
      )
  )
}

/** Jira 이슈 → 카드 행. signaled 는 호출부가 신호를 만든 뒤 다시 정한다 */
export function toJiraRow(issue: JiraBoardIssue, issues: JiraBoardIssue[], today: string): JiraRow {
  const done = issue.statusCategory === 'done'
  return {
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    statusCategory: issue.statusCategory,
    review: issue.statusCategory === 'indeterminate' && isReviewStatus(issue.status),
    duedate: issue.duedate,
    overdue: isOverdue(issue, today),
    dueToday: !done && issue.duedate === today,
    signaled: false,
    revealable: isRevealable(issues, issue.key)
  }
}

/**
 * 배포에 포함된 내 이슈가 위험한가.
 * - QA 가 시작돼 배포일 전까지인데 아직 할 일이거나 리뷰가 아닌 진행 중
 * - 배포 D-1·D-day 인데 완료가 아님
 */
export function isReleaseRiskIssue(
  issue: Pick<JiraBoardIssue, 'statusCategory' | 'status'>,
  r: Pick<NextRelease, 'qaStart' | 'date' | 'dDay'>,
  today: string
): boolean {
  if (issue.statusCategory === 'done') return false
  const inQa = r.qaStart !== null && r.qaStart <= today && today <= r.date
  const notReady = issue.statusCategory === 'new' || !isReviewStatus(issue.status)
  if (inQa && notReady) return true
  return r.dDay >= 0 && r.dDay <= 1
}

const ROW_ORDER = (row: JiraRow): number =>
  row.statusCategory === 'indeterminate' ? (row.review ? 1 : 0) : row.statusCategory === 'new' ? 2 : 3

/**
 * 다음 배포를 정한다.
 * (a) 오늘 이후 가장 가까운 캘린더 배포 일정 (b) 오늘 이후 가장 가까운 정식 버전 Jira 릴리스.
 * released 플래그는 보지 않는다(날짜가 미래인데 released=1 인 릴리스가 있다).
 * 캘린더가 있으면 그것이 기준이고 Jira 릴리스는 버전 → 날짜 순으로 매칭한다. 둘 다 실패면 linked:false.
 * 캘린더가 없으면 Jira 릴리스 단독(QA 정보 없음). 둘 다 없으면 null.
 */
export function resolveNextRelease(input: ReleaseModelInput): NextRelease | null {
  const { today, events, notes, snapshot } = input
  const classified = events.map(classifyReleaseEvent).filter((e): e is ReleaseCalendarEvent => e !== null)
  const calReleases = classified
    .filter((e) => e.kind === 'release' && e.start >= today)
    // 같은 날 일정이 둘이면 버전이 적힌 쪽
    .sort((a, b) => a.start.localeCompare(b.start) || (a.version ? 0 : 1) - (b.version ? 0 : 1))
  const candidates = noteCandidates(notes, today)
  const cal = calReleases[0] ?? null

  let base: Pick<NextRelease, 'version' | 'date' | 'linked' | 'qaStart' | 'qaEnd'>
  let note: ReleaseNoteSummary | null
  if (cal) {
    note = matchNote(cal, notes, candidates)
    const qa = classified
      .filter((e) => e.kind === 'qa' && e.start <= cal.start && e.endInclusive >= shiftDay(cal.start, -QA_GAP_DAYS))
      .sort((a, b) => b.start.localeCompare(a.start))[0]
    base = {
      version: note ? normalizeVersion(note.version_name) : cal.version,
      date: cal.start,
      linked: note !== null,
      qaStart: qa?.start ?? null,
      qaEnd: qa?.endInclusive ?? null
    }
  } else {
    note = candidates[0] ?? null
    if (!note) return null
    base = {
      version: normalizeVersion(note.version_name),
      date: note.release_date!.slice(0, 10),
      linked: true,
      qaStart: null,
      qaEnd: null
    }
  }

  const dDay = dayDiff(today, base.date)
  const phase: NextRelease['phase'] =
    dDay === 0 ? 'release_day' : base.qaStart !== null && base.qaStart <= today ? 'qa' : 'dev'
  const jiraVersionId = note?.jira_version_id ?? null
  const release: NextRelease = {
    ...base,
    dDay,
    noteId: note?.id ?? null,
    jiraVersionId,
    phase,
    totalCount: note ? note.item_count : null,
    mineKnown: !!snapshot && !!snapshot.myAccountId,
    mine: emptyMine(),
    rows: [],
    moreCount: 0
  }

  // 포함 이슈는 Jira 릴리스와 연결됐을 때만 센다. 내 계정을 모르면 "내 작업"이 없다
  const my = snapshot?.myAccountId ?? null
  if (!release.linked || !snapshot || !my) return release
  const issues = snapshot.issues
  const mineIssues = issuesInRelease(issues, release.version, jiraVersionId).filter(
    (i) => i.assigneeAccountId === my
  )
  const mine = emptyMine()
  const risk: JiraRow[] = []
  const rest: JiraRow[] = []
  for (const i of mineIssues) {
    mine.total += 1
    const row = toJiraRow(i, issues, today)
    if (i.statusCategory === 'done') mine.done += 1
    else if (i.statusCategory === 'indeterminate') {
      if (row.review) mine.review += 1
      else mine.progress += 1
    } else mine.todo += 1
    if (i.statusCategory === 'done') continue
    if (isReleaseRiskIssue(i, release, today)) {
      row.signaled = true
      risk.push(row)
    } else rest.push(row)
  }
  const byOrder = (a: JiraRow, b: JiraRow): number => ROW_ORDER(a) - ROW_ORDER(b) || compareIssueKeys(a.key, b.key)
  risk.sort(byOrder)
  rest.sort(byOrder)
  release.mine = mine
  release.rows = [...risk, ...rest.slice(0, RELEASE_ROW_LIMIT)]
  release.moreCount = Math.max(0, rest.length - RELEASE_ROW_LIMIT)
  return release
}

/** 위험 행 키. 위험 행은 상한과 무관하게 rows 에 모두 들어 있다. 미연결이면 늘 빈 배열 */
export function releaseRiskKeys(r: NextRelease | null, today: string): string[] {
  if (!r || !r.linked || r.mineKnown === false) return []
  return r.rows.filter((row) => isReleaseRiskIssue(row, r, today)).map((row) => row.key)
}
