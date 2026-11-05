import { useEffect, useRef, useState } from 'react'
import type { CandidateSource, PlanItem, PlanItemStatus, WorkType } from '../../types'
import { Badge, LinkIcon } from '../ui'
import { openInternalLink } from '../../utils/openInternalLink'
import { isInternalLink } from '../../utils/internalLink'

// 출처 배지. 색은 tokens 의 파스텔 필 문법을 따른다
export const SOURCE_BADGE: Record<CandidateSource, { label: string; color: string }> = {
  jira: { label: 'Jira', color: 'bg-indigo-50 text-indigo-600' },
  task: { label: '작업', color: 'bg-green-50 text-green-700' },
  todo: { label: 'TODO', color: 'bg-blue-50 text-blue-600' },
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

const STATUS_BUTTONS: { status: PlanItemStatus; label: string; active: string }[] = [
  { status: 'in_progress', label: '진행 중', active: 'bg-yellow-100 text-yellow-700' },
  { status: 'done', label: '완료', active: 'bg-green-100 text-green-700' },
  { status: 'deferred', label: '미룸', active: 'bg-slate-200 text-slate-700' },
  { status: 'dropped', label: '제외', active: 'bg-gray-200 text-gray-600' }
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

// 마감이 오늘이거나 지났으면 빨간 글자로 보여 준다
function dueTone(dueDate: string | null, logicalDate: string): string {
  const d = daysBetween(logicalDate, dueDate)
  return d !== null && d <= 0 ? 'text-red-600' : 'text-gray-500'
}

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
  completeOriginOnDone = false
}: PlanItemRowProps): React.ReactNode {
  // 이번 화면에서 사용자가 '완료'로 바꾼 항목만 원본 완료 체크박스를 보여 준다
  const [justDone, setJustDone] = useState(false)
  const [originDone, setOriginDone] = useState(false)
  // 사용자가 '완료'를 눌렀고 원본 자동 완료 대상이면 true 다. item.status 가 done 이 되면 소비한다
  const autoOriginPending = useRef(false)

  const finished = item.status === 'done' || item.status === 'dropped'
  // 묶음 항목은 집중 작업이 되지 않는다 (부록 J.4)
  const group = isGroupItem(item, items)
  const focused = !group && focusItemId !== null && item.id === focusItemId
  const canCompleteOrigin =
    (item.source === 'todo' || item.source === 'task') && /^(todo|task):\d+$/.test(item.candidate_id)
  const dayCount = dayCountLabel(item.first_planned_date, logicalDate)
  const due = dueLabel(item.due_date, logicalDate)

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

  return (
    <div
      id={`plan-item-${item.id}`}
      className={`px-5 py-3 border-b border-gray-100 last:border-b-0 ${
        finished ? 'bg-gray-50' : focused ? 'bg-blue-50/40' : ''
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="w-6 text-right text-sm font-semibold text-gray-500 tabular-nums shrink-0">
          {group ? '–' : (item.rank ?? '–')}
        </span>
        <SourceBadge source={item.source} />
        <WorkTypeBadge type={item.work_type} version={item.work_version} />
        {group ? (
          <Badge color="bg-gray-100 text-gray-600" title="하위 작업이 오늘 계획에 있어요">
            묶음
          </Badge>
        ) : null}
        <div className="flex-1 min-w-0">
          <p
            className={`min-w-0 break-words text-base ${finished ? 'text-gray-400 line-through' : 'text-gray-900'}`}
            title={item.title}
          >
            {item.title}
          </p>
          {item.group_name ? (
            <p className="break-words text-sm text-gray-500">
              {item.group_name}
            </p>
          ) : null}
        </div>
        {focused && !finished ? (
          <Badge color="bg-blue-100 text-blue-700" title="지금 빈 시간에 할 작업이에요">
            집중 중
          </Badge>
        ) : null}
        {dayCount ? (
          <span className="text-sm text-gray-500 shrink-0 tabular-nums">{dayCount}</span>
        ) : null}
        {due ? (
          <span className={`text-sm shrink-0 tabular-nums ${dueTone(item.due_date, logicalDate)}`}>
            {due}
          </span>
        ) : null}
        <ItemLink link={item.link} />
      </div>

      {item.status_note ? (
        <p className="ml-9 mt-1 break-words text-sm text-gray-500">
          {item.status_note}
        </p>
      ) : null}

      {readOnly ? (
        <div className="ml-9 mt-2 text-sm text-gray-500">{STATUS_LABEL[item.status]}</div>
      ) : (
        <div className="ml-9 mt-2 flex flex-wrap items-center gap-1.5">
          {STATUS_BUTTONS.map((b) => (
            <button
              key={b.status}
              type="button"
              disabled={busy}
              onClick={() => handleStatus(b.status)}
              className={`px-2.5 py-1 text-sm rounded-full transition-colors disabled:opacity-50 ${
                item.status === b.status ? b.active : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {b.label}
            </button>
          ))}
          {isActiveItem(item) && !focused && !group ? (
            <>
              <span className="mx-1 h-4 w-px bg-gray-200" />
              <button
                type="button"
                disabled={busy}
                onClick={() => onFocus(item.id)}
                className="px-2.5 py-1 text-sm text-blue-600 rounded-full hover:bg-blue-50 disabled:opacity-50"
                title="이 작업을 1순위로 올리고 남은 빈 시간에 배정해요"
              >
                지금 집중
              </button>
            </>
          ) : null}
        </div>
      )}

      {!readOnly && item.status === 'done' && justDone && canCompleteOrigin ? (
        <label className="ml-9 mt-2 inline-flex items-center gap-1.5 text-sm text-gray-600">
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
  )
}
