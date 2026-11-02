import { useState } from 'react'
import type { CandidateSource, PlanItem, PlanItemStatus } from '../../types'
import { Badge, LinkIcon } from '../ui'
import { useProjectStore } from '../../stores/projectStore'

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
    <Badge color={s.color} size="xs">
      {s.label}
    </Badge>
  )
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

// linkwork:// 링크를 앱 안에서 연다. AiChatView.handleInternalLink 와 같은 규칙이다
export async function openInternalLink(href: string): Promise<void> {
  const match = href.match(/^linkwork:\/\/([a-z]+)\/?(.*)$/)
  if (!match) return
  const [, kind, rest] = match
  const { fetchProject, setProjectView, setView } = useProjectStore.getState()
  if (kind === 'project' && /^\d+$/.test(rest)) {
    await fetchProject(Number(rest))
    setProjectView('detail')
    setView('projects')
  } else if (kind === 'document' && /^\d+$/.test(rest)) {
    const docs = await window.api.document.listAll()
    const doc = docs.find((d) => d.id === Number(rest))
    if (doc) await window.api.document.open(doc.url, doc.type)
    else setView('documents')
  } else if (kind === 'view') {
    const views = [
      'dashboard',
      'today',
      'projects',
      'todos',
      'documents',
      'variables',
      'memos',
      'calendar',
      'releases',
      'reports',
      'notes'
    ] as const
    const target = views.find((v) => v === rest)
    if (target) setView(target)
  }
}

// 항목 링크. 내부 링크는 버튼, 외부 링크(Jira)는 새 창 링크다.
// 외부 링크는 main 의 setWindowOpenHandler 가 브라우저로 연다
export function ItemLink({ link }: { link: string | null }): React.ReactNode {
  if (!link) return null
  if (link.startsWith('linkwork://')) {
    return (
      <button
        type="button"
        onClick={() => void openInternalLink(link)}
        className="p-1 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
        title="열기"
      >
        <LinkIcon size={14} />
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
        <LinkIcon size={14} />
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
}

export default function PlanItemRow({
  item,
  logicalDate,
  focusItemId,
  readOnly = false,
  busy = false,
  onStatus,
  onFocus,
  onCompleteOrigin
}: PlanItemRowProps): React.ReactNode {
  // 이번 화면에서 사용자가 '완료'로 바꾼 항목만 원본 완료 체크박스를 보여 준다
  const [justDone, setJustDone] = useState(false)
  const [originDone, setOriginDone] = useState(false)

  const finished = item.status === 'done' || item.status === 'dropped'
  const focused = focusItemId !== null && item.id === focusItemId
  const canCompleteOrigin =
    (item.source === 'todo' || item.source === 'task') && /^(todo|task):\d+$/.test(item.candidate_id)
  const dayCount = dayCountLabel(item.first_planned_date, logicalDate)
  const due = dueLabel(item.due_date, logicalDate)

  const handleStatus = (status: PlanItemStatus): void => {
    // 같은 상태를 다시 누르면 '예정'으로 되돌린다
    const next = item.status === status ? 'planned' : status
    setJustDone(next === 'done')
    if (next !== 'done') setOriginDone(false)
    onStatus(item.id, next)
  }

  const handleOrigin = async (checked: boolean): Promise<void> => {
    if (!checked || originDone) return
    const ok = await onCompleteOrigin(item)
    if (ok) setOriginDone(true)
  }

  return (
    <div
      id={`plan-item-${item.id}`}
      className={`px-4 py-3 border-b border-gray-100 last:border-b-0 ${
        finished ? 'bg-gray-50' : focused ? 'bg-blue-50/40' : ''
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="w-6 text-right text-xs font-semibold text-gray-400 tabular-nums shrink-0">
          {item.rank ?? '–'}
        </span>
        <SourceBadge source={item.source} />
        <span
          className={`flex-1 min-w-0 truncate text-sm ${
            finished ? 'text-gray-400 line-through' : 'text-gray-900'
          }`}
          title={item.title}
        >
          {item.title}
        </span>
        {focused && !finished ? (
          <Badge color="bg-blue-100 text-blue-700" size="xs" title="지금 빈 시간에 할 작업입니다">
            집중 중
          </Badge>
        ) : null}
        {dayCount ? (
          <span className="text-xs text-gray-500 shrink-0 tabular-nums">{dayCount}</span>
        ) : null}
        {due ? (
          <span className={`text-xs shrink-0 tabular-nums ${dueTone(item.due_date, logicalDate)}`}>
            {due}
          </span>
        ) : null}
        <ItemLink link={item.link} />
      </div>

      {item.status_note ? (
        <p className="ml-9 mt-1 text-xs text-gray-400">{item.status_note}</p>
      ) : null}

      {readOnly ? (
        <div className="ml-9 mt-2 text-xs text-gray-500">{STATUS_LABEL[item.status]}</div>
      ) : (
        <div className="ml-9 mt-2 flex flex-wrap items-center gap-1.5">
          {STATUS_BUTTONS.map((b) => (
            <button
              key={b.status}
              type="button"
              disabled={busy}
              onClick={() => handleStatus(b.status)}
              className={`px-2 py-0.5 text-xs rounded-full transition-colors disabled:opacity-50 ${
                item.status === b.status ? b.active : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {b.label}
            </button>
          ))}
          {isActiveItem(item) && !focused ? (
            <>
              <span className="mx-1 h-3 w-px bg-gray-200" />
              <button
                type="button"
                disabled={busy}
                onClick={() => onFocus(item.id)}
                className="px-2 py-0.5 text-xs text-blue-600 rounded-full hover:bg-blue-50 disabled:opacity-50"
                title="이 작업을 1순위로 올리고 남은 빈 시간에 배정합니다"
              >
                지금 집중
              </button>
            </>
          ) : null}
        </div>
      )}

      {!readOnly && item.status === 'done' && justDone && canCompleteOrigin ? (
        <label className="ml-9 mt-2 inline-flex items-center gap-1.5 text-xs text-gray-600">
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
