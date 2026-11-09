import { useEffect, useRef, useState } from 'react'
import type {
  CandidateSource,
  DayTimeline,
  PlanExclusion,
  PlanItem,
  PlanItemStatus,
  TimelineEntry,
  WorkType
} from '../../types'
import { Badge, LinkIcon, button } from '../ui'
import { openInternalLink } from '../../utils/openInternalLink'
import { isInternalLink } from '../../utils/internalLink'
import {
  EMPHASIS,
  META_TEXT,
  NEUTRAL_BADGE,
  NO_BAR,
  ROW_BOX,
  TASK_ROW_GRID,
  TITLE_TEXT
} from './todayTokens'

// 출처 배지. Jira·작업·TODO 는 회색 1색이다. 이유: 출처는 판단 신호가 아니다 (부록 M12).
// 액션아이템은 추측 항목이라 알아볼 수 있게 amber 를 남긴다
export const SOURCE_BADGE: Record<CandidateSource, { label: string; color: string }> = {
  jira: { label: 'Jira', color: NEUTRAL_BADGE },
  task: { label: '작업', color: NEUTRAL_BADGE },
  todo: { label: 'TODO', color: NEUTRAL_BADGE },
  action_item: { label: '액션아이템', color: 'bg-amber-50 text-amber-700' },
  // source 가 'manual' 인 임시 항목. 명령으로 만든다 (부록 G.6)
  manual: { label: '임시', color: 'bg-gray-100 text-gray-600' }
}

export function SourceBadge({ source }: { source: CandidateSource }): React.ReactNode {
  const s = SOURCE_BADGE[source] ?? { label: source, color: 'bg-gray-100 text-gray-600' }
  return (
    <Badge color={s.color}>
      {s.label}
    </Badge>
  )
}

// 업무 유형 배지 (부록 J.8). etc 는 배지를 그리지 않는다
export const WORK_TYPE_BADGE: Record<Exclude<WorkType, 'etc'>, { label: string; color: string }> = {
  qa: { label: 'QA', color: 'bg-rose-50 text-rose-700' },
  sus: { label: 'SUS', color: 'bg-orange-50 text-orange-700' },
  trd: { label: 'TRD', color: 'bg-cyan-50 text-cyan-700' },
  prd: { label: 'PRD', color: 'bg-violet-50 text-violet-700' }
}

// 유형 라벨. QA 만 버전을 붙인다. main 의 assistant-worktype.workTypeLabel 과 같다
export function workTypeLabel(type: WorkType, version: string | null): string {
  if (type === 'etc') return '기타'
  const label = WORK_TYPE_BADGE[type]?.label ?? '기타'
  return type === 'qa' && version ? `${label} ${version}` : label
}

export function WorkTypeBadge({
  type,
  version
}: {
  type: WorkType
  version: string | null
}): React.ReactNode {
  if (type === 'etc') return null
  const b = WORK_TYPE_BADGE[type]
  if (!b) return null
  return (
    <Badge color={b.color}>
      {workTypeLabel(type, version)}
    </Badge>
  )
}

// 묶음 판정에서 세는 하위 상태. 사용자가 받아들인 하위만 묶음을 만든다 (부록 J.4)
const GROUP_CHILD_STATUSES: ReadonlySet<PlanItemStatus> = new Set(['planned', 'in_progress', 'done', 'deferred'])

// 받아들인 하위 항목이 같은 계획에 1건 이상 있는 Jira 항목이다. main 의 isGroupItem 과 같은 정의다
export function isGroupItem(
  item: Pick<PlanItem, 'id' | 'jira_issue_key'>,
  items: Pick<PlanItem, 'id' | 'parent_key' | 'status'>[]
): boolean {
  const key = item.jira_issue_key
  if (key === null) return false
  return items.some((o) => o.id !== item.id && o.parent_key === key && GROUP_CHILD_STATUSES.has(o.status))
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

// 'YYYY-MM-DD' 를 '11월 3일 화요일' 로 바꾼다. 형식이 아니면 입력 그대로다
export function longDateLabel(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return date
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = new Date(Date.UTC(y, mo - 1, d))
  if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return date
  return `${mo}월 ${d}일 ${WEEKDAYS[t.getUTCDay()]}요일`
}

// 로컬 datetime 'YYYY-MM-DD HH:mm:ss' 에서 'HH:mm' 만 꺼낸다
export function hhmmOf(datetime: string | null | undefined): string {
  if (!datetime) return ''
  const m = datetime.match(/(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : ''
}

// 'YYYY-MM-DD' 를 'MM/DD' 로 줄인다
export function shortDate(date: string | null | undefined): string {
  if (!date) return ''
  const m = date.match(/^\d{4}-(\d{2})-(\d{2})/)
  return m ? `${m[1]}/${m[2]}` : date
}

// 두 'YYYY-MM-DD' 사이의 날짜 차이(to - from). 형식이 아니면 null
export function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  const parse = (d: string | null | undefined): number | null => {
    const m = d?.match(/^(\d{4})-(\d{2})-(\d{2})/)
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
  }
  const a = parse(from)
  const b = parse(to)
  if (a === null || b === null) return null
  return Math.round((b - a) / 86_400_000)
}

// 여러 날 작업 표시 (부록 B.5). 처음 계획한 날이 오늘보다 이르면 'n일째'. n 은 차이 + 1
export function dayCountLabel(firstPlannedDate: string | null | undefined, logicalDate: string): string {
  const d = daysBetween(firstPlannedDate, logicalDate)
  return d !== null && d > 0 ? `${d + 1}일째` : ''
}

// 마감 표시. 'D-n', '마감 오늘', 'n일 지남'
export function dueLabel(dueDate: string | null | undefined, logicalDate: string): string {
  const d = daysBetween(logicalDate, dueDate)
  if (d === null) return ''
  if (d > 0) return `D-${d}`
  if (d === 0) return '마감 오늘'
  return `${-d}일 지남`
}

// 블록 길이. 예: 75 → '1h15m', 120 → '2h', 20 → '20m'
export function durationLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h === 0) return `${r}m`
  return r === 0 ? `${h}h` : `${h}h${r}m`
}

// 남은 집중 가능 시간. 예: 270 → '4시간 30분', 120 → '2시간', 0 → '0분'
export function freeTimeLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h === 0) return `${r}분`
  return r === 0 ? `${h}시간` : `${h}시간 ${r}분`
}

// 항목 링크. 내부 링크는 버튼, 외부 링크(Jira)는 새 창 링크다.
// 외부 링크는 main 의 setWindowOpenHandler 가 브라우저로 연다
export function ItemLink({ link }: { link: string | null }): React.ReactNode {
  if (!link) return null
  if (isInternalLink(link)) {
    return (
      <button
        type="button"
        onClick={() => void openInternalLink(link)}
        className="p-1 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
        title="열기"
      >
        <LinkIcon size={16} />
      </button>
    )
  }
  if (/^https?:\/\//.test(link)) {
    return (
      <a
        href={link}
        target="_blank"
        rel="noreferrer"
        className="p-1 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
        title="Jira 에서 열기"
      >
        <LinkIcon size={16} />
      </a>
    )
  }
  return null
}


// 행에 늘 보이는 상태 버튼 2개 (부록 M11). 나머지 상태는 '⋯' 안에 둔다
const MAIN_BUTTONS: { status: PlanItemStatus; label: string; active: string }[] = [
  { status: 'done', label: '완료', active: 'bg-green-100 text-green-700' },
  { status: 'dropped', label: '제외', active: 'bg-gray-200 text-gray-600' }
]

// '⋯' 를 펼치면 보이는 상태 버튼 2개. 그 뒤에 '지금 집중' 이 온다
const MENU_BUTTONS: { status: PlanItemStatus; label: string; active: string }[] = [
  { status: 'in_progress', label: '진행 중', active: 'bg-yellow-100 text-yellow-700' },
  { status: 'deferred', label: '미룸', active: 'bg-slate-200 text-slate-700' }
]

export const STATUS_LABEL: Record<PlanItemStatus, string> = {
  suggested: '제안',
  planned: '예정',
  in_progress: '진행 중',
  done: '완료',
  deferred: '미룸',
  dropped: '제외',
  dismissed: '무시'
}

// 활성 항목인지 판정한다 (부록 B.2)
export const isActiveItem = (item: Pick<PlanItem, 'status'>): boolean =>
  item.status === 'planned' || item.status === 'in_progress'

// 마감 강조 대상인지 판정한다. 마감이 오늘이거나 지났거나 긴급이면 true 다 (부록 M.4 강조 2)
export function isDueAlert(item: Pick<PlanItem, 'due_date' | 'urgent'>, logicalDate: string): boolean {
  if (item.urgent) return true
  const d = daysBetween(logicalDate, item.due_date)
  return d !== null && d <= 0
}

type BlockEntry = Extract<TimelineEntry, { kind: 'block' }>

// 작업 시간 라벨에 쓰는 블록 수의 상한. 넘는 블록은 ' 외 n개' 로 줄인다
export const SLOT_LABEL_MAX = 3

// 항목에 배정된 작업 시간 라벨 (부록 M.9 N2). 지난 블록은 뺀다.
// 남은 블록을 시작순으로 쉼표로 잇는다. 예: '작업 시간 12:00–14:00, 15:00–16:00'.
// 3개를 넘으면 앞 3개 뒤에 ' 외 n개' 를 붙인다. 블록이 없으면 null 이다
export function itemSlotLabel(itemId: number, timeline: Pick<DayTimeline, 'entries'>): string | null {
  const blocks = timeline.entries
    .filter((e): e is BlockEntry => e.kind === 'block' && e.itemId === itemId && e.state !== 'past')
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  if (blocks.length === 0) return null
  const ranges = blocks
    .slice(0, SLOT_LABEL_MAX)
    .map((b) => `${hhmmOf(b.start) || b.start}–${hhmmOf(b.end) || b.end}`)
  const rest = blocks.length - SLOT_LABEL_MAX
  return `작업 시간 ${ranges.join(', ')}${rest > 0 ? ` 외 ${rest}개` : ''}`
}

// 계획 항목이 계속 제외 기록과 맞는지 판정한다. main 의 isExcludedCandidate 와 같은 규칙이다.
// 후보 id 가 같거나, 둘 다 Jira 키가 있고 같으면 true 다. 이유: task 가 생기면 같은 티켓의 후보 id 가 바뀐다
export function isItemExcluded(
  item: Pick<PlanItem, 'candidate_id' | 'jira_issue_key'>,
  exclusions: Pick<PlanExclusion, 'candidate_id' | 'jira_key'>[]
): boolean {
  const key = item.jira_issue_key ? item.jira_issue_key.toUpperCase() : null
  return exclusions.some(
    (e) => e.candidate_id === item.candidate_id || (key !== null && !!e.jira_key && e.jira_key.toUpperCase() === key)
  )
}

// 계속 제외는 Jira·작업 출처만 할 수 있다 (부록 M4)
const EXCLUDABLE_SOURCES: ReadonlySet<CandidateSource> = new Set(['jira', 'task'])

const STATUS_BUTTON_BASE = 'px-2.5 py-1 text-sm rounded-full transition-colors disabled:opacity-50'

interface PlanItemRowProps {
  item: PlanItem
  // 오늘 논리 날짜. 'n일째'·마감 표시에 쓴다
  logicalDate: string
  // 타임라인의 집중 작업 id
  focusItemId: number | null
  // 닫힌 계획이면 상태·집중을 바꾸지 않는다
  readOnly?: boolean
  busy?: boolean
  onStatus: (itemId: number, status: PlanItemStatus) => void
  onFocus: (itemId: number) => void
  // 원본 todo·task 를 완료 처리한다. 성공하면 true
  onCompleteOrigin: (item: PlanItem) => Promise<boolean>
  // 같은 계획의 항목 전체. 묶음 판정에 쓴다 (부록 J.4)
  items: Pick<PlanItem, 'id' | 'parent_key' | 'status'>[]
  // 설정 completeOriginOnDone. true 면 '완료'로 바꿀 때 원본도 완료한다. 기본은 false 다
  completeOriginOnDone?: boolean
  // 메타 줄의 작업 시간 글자. itemSlotLabel 의 값이다. null 이면 쓰지 않는다
  slotLabel?: string | null
  // 빈 시간이 없어 배정하지 못한 마감 항목이면 true 다. 메타에 '미배정' 을 쓴다
  unplaced?: boolean
  // 계속 제외 기록이 있으면 true 다
  excluded?: boolean
  onExclude?: (itemId: number) => void
  onRemoveExclusion?: (candidateId: string) => void
  // 테스트가 '⋯' 메뉴를 연 상태로 그릴 때 쓴다. 앱은 넘기지 않는다
  menuOpenInitial?: boolean
}

export default function PlanItemRow({
  item,
  logicalDate,
  focusItemId,
  readOnly = false,
  busy = false,
  onStatus,
  onFocus,
  onCompleteOrigin,
  items,
  completeOriginOnDone = false,
  slotLabel = null,
  unplaced = false,
  excluded = false,
  onExclude,
  onRemoveExclusion,
  menuOpenInitial = false
}: PlanItemRowProps): React.ReactNode {
  // 이번 화면에서 사용자가 '완료'로 바꾼 항목만 원본 완료 체크박스를 보여 준다
  const [justDone, setJustDone] = useState(false)
  const [originDone, setOriginDone] = useState(false)
  const [menuOpen, setMenuOpen] = useState(menuOpenInitial)
  // 사용자가 '완료'를 눌렀고 원본 자동 완료 대상이면 true 다. item.status 가 done 이 되면 소비한다
  const autoOriginPending = useRef(false)

  // 끝난 할 일은 흐리게 그린다 (부록 M.4 강조 5)
  const finished = item.status === 'done' || item.status === 'dropped' || item.status === 'deferred'
  // 묶음 항목은 집중 작업이 되지 않는다 (부록 J.4)
  const group = isGroupItem(item, items)
  const focused = !group && focusItemId !== null && item.id === focusItemId
  const focusEmphasis = focused && !finished
  const canCompleteOrigin =
    (item.source === 'todo' || item.source === 'task') && /^(todo|task):\d+$/.test(item.candidate_id)
  const dayCount = dayCountLabel(item.first_planned_date, logicalDate)
  const due = dueLabel(item.due_date, logicalDate)
  const dueUrgent = !finished && isDueAlert(item, logicalDate)
  const showExclusion = !readOnly && item.status === 'dropped' && EXCLUDABLE_SOURCES.has(item.source)
  // '⋯' 안의 상태가 지금 상태면 버튼에 그 상태를 같이 쓴다. 이유: 메뉴를 닫아도 상태가 보인다
  const menuStatus = MENU_BUTTONS.find((b) => b.status === item.status) ?? null

  const handleStatus = (status: PlanItemStatus): void => {
    // 같은 상태를 다시 누르면 '예정'으로 되돌린다
    const next = item.status === status ? 'planned' : status
    setJustDone(next === 'done')
    if (next !== 'done') setOriginDone(false)
    // 원본 자동 완료는 계획 항목이 실제로 done 이 된 뒤에 한다. 아래 effect 가 처리한다
    autoOriginPending.current = next === 'done' && completeOriginOnDone && canCompleteOrigin
    onStatus(item.id, next)
  }

  // 상태 변경이 실패하면 item.status 가 done 이 되지 않는다. 그러면 원본도 완료하지 않는다.
  // 원본 완료는 기존 API 로 렌더러가 부른다. 비서 main 은 원본을 쓰지 않는다(A2)
  useEffect(() => {
    if (!autoOriginPending.current || item.status !== 'done') return
    autoOriginPending.current = false
    void handleOrigin(true)
  }, [item.status])

  async function handleOrigin(checked: boolean): Promise<void> {
    if (!checked || originDone) return
    const ok = await onCompleteOrigin(item)
    if (ok) setOriginDone(true)
  }

  const statusButton = (b: { status: PlanItemStatus; label: string; active: string }): React.ReactNode => (
    <button
      key={b.status}
      type="button"
      disabled={busy}
      onClick={() => handleStatus(b.status)}
      className={`${STATUS_BUTTON_BASE} ${item.status === b.status ? b.active : 'text-gray-500 hover:bg-gray-100'}`}
    >
      {b.label}
    </button>
  )

  return (
    <div
      id={`plan-item-${item.id}`}
      className={`${TASK_ROW_GRID} ${ROW_BOX} ${focusEmphasis ? EMPHASIS.focusRow : NO_BAR}`}
    >
      {/* 1열: 제목과 메타. 순위 숫자는 두지 않는다. 순서가 곧 순위다 (부록 M.9 N1) */}
      <div className="min-w-0">
        <div className={finished ? EMPHASIS.dimmed : ''}>
          <p
            className={`${TITLE_TEXT} ${focusEmphasis ? EMPHASIS.focusTitle : ''} ${
              item.status === 'done' ? 'line-through' : ''
            }`}
            title={item.title}
          >
            {item.title}
          </p>
          <div className={META_TEXT}>
            <WorkTypeBadge type={item.work_type} version={item.work_version} />
            <SourceBadge source={item.source} />
            {group ? (
              <Badge color="bg-gray-100 text-gray-600" title="하위 작업이 오늘 계획에 있어요">
                묶음
              </Badge>
            ) : null}
            {focusEmphasis ? (
              <Badge color="bg-blue-100 text-blue-700" title="지금 빈 시간에 할 작업이에요">
                집중 중
              </Badge>
            ) : null}
            {slotLabel ? <span>{slotLabel}</span> : null}
            {due ? <span className={dueUrgent ? EMPHASIS.urgentText : ''}>{due}</span> : null}
            {dayCount ? <span>{dayCount}</span> : null}
            {item.group_name ? <span className="break-words">{item.group_name}</span> : null}
            {unplaced ? <span>미배정</span> : null}
          </div>
          {item.status_note ? (
            <p className="mt-1 break-words text-sm text-gray-500">{item.status_note}</p>
          ) : null}
        </div>

        {/* 계속 제외 2단계 (부록 M5). 화면 상태가 아니라 항목 상태로 그린다 */}
        {showExclusion ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-600">
            {excluded ? (
              <>
                <span>계속 제외했어요. 내일부터 자동으로 넣지 않아요.</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRemoveExclusion?.(item.candidate_id)}
                  className={`px-2.5 py-1 text-sm ${button.subtle}`}
                >
                  제외 취소
                </button>
              </>
            ) : (
              <>
                <span>오늘만 제외했어요.</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onExclude?.(item.id)}
                  className={`px-2.5 py-1 text-sm ${button.subtle}`}
                  title="내일부터 하루 시작과 최신화에 넣지 않아요"
                >
                  계속 제외
                </button>
              </>
            )}
          </div>
        ) : null}

        {!readOnly && item.status === 'done' && justDone && canCompleteOrigin ? (
          <label className="mt-2 inline-flex items-center gap-1.5 text-sm text-gray-600">
            <input
              type="checkbox"
              checked={originDone}
              disabled={originDone}
              onChange={(e) => void handleOrigin(e.target.checked)}
            />
            원본도 완료 처리
            {originDone ? <span className="text-green-600">· 완료됨</span> : null}
          </label>
        ) : null}
      </div>

      {/* 2열: 상태 버튼. 호버로 숨기지 않는다 (부록 M11) */}
      {readOnly ? (
        <div className="flex items-center justify-end gap-1.5">
          <span className="text-sm text-gray-500">{STATUS_LABEL[item.status]}</span>
          <ItemLink link={item.link} />
        </div>
      ) : (
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center justify-end gap-1.5">
            {MAIN_BUTTONS.map(statusButton)}
            <button
              type="button"
              disabled={busy}
              aria-expanded={menuOpen}
              aria-label="상태 더 보기"
              onClick={() => setMenuOpen((o) => !o)}
              className={`${STATUS_BUTTON_BASE} ${menuStatus ? menuStatus.active : 'text-gray-500 hover:bg-gray-100'}`}
            >
              {menuStatus ? `${menuStatus.label} ⋯` : '⋯'}
            </button>
            <ItemLink link={item.link} />
          </div>
          {menuOpen ? (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              {MENU_BUTTONS.map(statusButton)}
              {isActiveItem(item) && !focused && !group ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onFocus(item.id)}
                  className={`${STATUS_BUTTON_BASE} text-blue-600 hover:bg-blue-50`}
                  title="이 작업을 1순위로 올리고 남은 빈 시간에 배정해요"
                >
                  지금 집중
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
