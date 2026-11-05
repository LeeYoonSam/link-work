import { useEffect } from 'react'
import { useMeetingNotesStore } from '../../stores/meetingNotesStore'
import { useFocusRequest, useFocusStore } from '../../stores/focusStore'
import { FOCUS_RING_CLASS, focusDomId, useFlash, useFocusScroll } from '../../hooks/useFocusFlash'
import type { MeetingNoteItem } from '../../types'
import { EmptyState } from '../ui'

export function monthLabel(startedAt: string): string {
  const [y, m] = startedAt.slice(0, 7).split('-')
  return `${y}년 ${Number(m)}월`
}

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min}분`
  return `${Math.floor(min / 60)}시간 ${min % 60}분`
}

// started_at DESC로 온 목록을 순서를 유지한 채 월별로 묶는다
function groupByMonth(items: MeetingNoteItem[]): { label: string; items: MeetingNoteItem[] }[] {
  const groups: { label: string; items: MeetingNoteItem[] }[] = []
  for (const item of items) {
    const label = monthLabel(item.started_at)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}

// 목록의 한 행. highlighted 는 앱 내 링크로 찾아온 행을 잠시 강조한다
export function MeetingNoteRow({
  note: n,
  selected,
  highlighted = false,
  onSelect
}: {
  note: MeetingNoteItem
  selected: boolean
  highlighted?: boolean
  onSelect: (id: number) => void
}): React.ReactNode {
  const scrollRef = useFocusScroll<HTMLButtonElement>(highlighted)
  return (
    <button
      ref={scrollRef}
      id={focusDomId('note', n.id)}
      type="button"
      onClick={() => onSelect(n.id)}
      className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors ${
        selected ? 'bg-blue-50' : 'hover:bg-gray-50'
      } ${highlighted ? FOCUS_RING_CLASS : ''}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex-1 min-w-0 truncate text-sm font-medium text-gray-800">
          {n.title}
        </span>
        {n.kind === 'interview' && (
          <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-purple-50 text-purple-600">
            면접
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-gray-400">
        {n.started_at.slice(0, 10)} · {formatDuration(n.duration_ms)}
        {n.project_name && ` · ${n.project_name}`}
      </div>
      {n.tldr && <p className="mt-1 text-xs text-gray-600 line-clamp-2">{n.tldr}</p>}
      {(n.decision_count > 0 || n.action_item_count > 0) && (
        <div className="mt-1.5 flex gap-1.5 text-[10px]">
          {n.decision_count > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
              결정 {n.decision_count}
            </span>
          )}
          {n.action_item_count > 0 && (
            <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">
              액션 {n.action_item_count}
              {n.open_action_count > 0 && ` (미반영 ${n.open_action_count})`}
            </span>
          )}
        </div>
      )}
    </button>
  )
}

export default function MeetingNoteList(): React.ReactNode {
  const { items, loading, selectedId, select } = useMeetingNotesStore()
  const request = useFocusRequest('note')
  const [flashId, flash] = useFlash<number>()

  // 앱 내 링크(linkwork://note/{id})로 온 요청을 소비한다.
  // 필터 초기화와 상세 열기는 openInternalLink 가 맡는다. 이 목록은 행 강조와 스크롤만 맡는다
  useEffect(() => {
    if (!request) return
    // 목록이 아직 안 왔으면 기다린다. 끝내 없으면 TTL 이 요청을 지운다
    if (!items.some((n) => n.id === request.id)) return
    flash(request.id)
    useFocusStore.getState().consume(request.nonce)
  }, [request, items, flash])

  if (!loading && items.length === 0) {
    return (
      <EmptyState>
        <p>요약 완료된 회의가 없습니다</p>
        <p className="mt-1 text-xs">녹음 메뉴에서 녹음 후 AI 요약을 생성하세요</p>
      </EmptyState>
    )
  }

  return (
    <div>
      {groupByMonth(items).map((g) => (
        <section key={g.label}>
          <h3 className="sticky top-0 z-10 px-4 py-1.5 text-[11px] font-semibold text-gray-500 bg-gray-50 border-b border-gray-100">
            {g.label}
          </h3>
          {g.items.map((n) => (
            <MeetingNoteRow
              key={n.id}
              note={n}
              selected={selectedId === n.id}
              highlighted={flashId === n.id}
              onSelect={select}
            />
          ))}
        </section>
      ))}
    </div>
  )
}
