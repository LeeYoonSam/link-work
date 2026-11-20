import { useEffect, useState } from 'react'
import type { CalendarListEntry } from '../../../types'
import { useCalendarStore } from '../../../stores/calendarStore'

// Google 카드의 "가져올 캘린더". 체크하는 즉시 저장한다. 최소 1개는 남긴다.
// 기본 캘린더는 id 'primary' 로 오고 저장도 'primary' 로 한다(docs/SETTINGS.md).
// 목록 조회가 실패하면(권한 부족 403 등) 다시 로그인 안내를 보이고 저장된 선택을 바꾸지 않는다.

export const CALENDAR_PICKER_HINT = '릴리스·QA 일정은 선택한 캘린더의 종일 일정 제목에서 자동으로 찾습니다.'
export const CALENDAR_PICKER_OWN_ONLY =
  '기본 캘린더가 아닌 캘린더의 일정은 화면에만 보이고 회의 알림·회의 전 브리핑은 만들지 않습니다.'
export const CALENDAR_LIST_FAILED =
  '캘린더 목록을 불러오지 못했습니다. 카드의 [Google 로그인]으로 다시 로그인해 주세요. 그동안은 저장된 선택(처음이면 기본 캘린더)으로 가져옵니다.'
const CALENDAR_MIN_ONE = '캘린더를 1개 이상 골라야 합니다.'

/**
 * 체크 변경 후의 선택. 목록에 없는 옛 id 는 버리고 목록 순서로 돌려준다.
 * 결과가 비면 null(거절)이다.
 */
export function toggleCalendarSelection(
  selected: string[],
  available: string[],
  id: string,
  checked: boolean
): string[] | null {
  const set = new Set(selected.filter((s) => available.includes(s)))
  if (checked) set.add(id)
  else set.delete(id)
  const next = available.filter((a) => set.has(a))
  return next.length > 0 ? next : null
}

export interface CalendarPickerViewProps {
  calendars: CalendarListEntry[]
  selectedIds: string[]
  loading: boolean
  saving: boolean
  listFailed: boolean
  error: string
  onToggle: (id: string, checked: boolean) => void
}

export function CalendarPickerView({
  calendars,
  selectedIds,
  loading,
  saving,
  listFailed,
  error,
  onToggle
}: CalendarPickerViewProps): React.ReactNode {
  const checkedVisible = calendars.filter((c) => selectedIds.includes(c.id)).length
  return (
    <div className="border border-gray-200 rounded-lg p-3">
      <p className="text-xs font-medium text-gray-700 mb-1">가져올 캘린더</p>
      <p className="text-[11px] text-gray-500">{CALENDAR_PICKER_HINT}</p>
      <p className="text-[11px] text-gray-500 mb-2">{CALENDAR_PICKER_OWN_ONLY}</p>
      {loading ? <p className="text-[11px] text-gray-500">캘린더 목록 불러오는 중…</p> : null}
      {listFailed ? <p className="text-[11px] text-amber-700">{CALENDAR_LIST_FAILED}</p> : null}
      {!loading && !listFailed ? (
        <ul className="space-y-1">
          {calendars.map((c) => {
            const checked = selectedIds.includes(c.id)
            // 마지막 1개는 끌 수 없다
            const locked = checked && checkedVisible <= 1
            return (
              <li key={c.id}>
                <label className="flex items-center gap-2 text-xs text-gray-800">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={saving || locked}
                    onChange={(e) => onToggle(c.id, e.target.checked)}
                    aria-label={c.summary}
                  />
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ backgroundColor: c.color ?? '#9ca3af' }}
                    aria-hidden="true"
                  />
                  <span className="truncate">{c.summary}</span>
                  {c.primary ? (
                    <span className="px-1.5 py-0.5 rounded bg-gray-100 text-[10px] text-gray-600">기본</span>
                  ) : null}
                </label>
              </li>
            )
          })}
        </ul>
      ) : null}
      {saving ? <p className="mt-1 text-[11px] text-gray-500">저장 중…</p> : null}
      {error ? <p className="mt-1 text-[11px] text-red-600 break-all">{error}</p> : null}
    </div>
  )
}

export default function CalendarPicker({ connected }: { connected: boolean }): React.ReactNode {
  const [calendars, setCalendars] = useState<CalendarListEntry[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [listFailed, setListFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!connected) return
    let alive = true
    setLoading(true)
    setListFailed(false)
    setError('')
    window.api.calendar
      .listCalendars()
      .then((r) => {
        if (!alive) return
        if (r.success) {
          setCalendars(r.calendars)
          setSelectedIds(r.selectedIds)
        } else {
          setListFailed(true)
          setError(r.error)
        }
      })
      .catch((e: unknown) => {
        if (!alive) return
        setListFailed(true)
        setError(e instanceof Error ? e.message : '')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [connected])

  if (!connected) return null

  const handleToggle = async (id: string, checked: boolean): Promise<void> => {
    const next = toggleCalendarSelection(
      selectedIds,
      calendars.map((c) => c.id),
      id,
      checked
    )
    if (!next) {
      setError(CALENDAR_MIN_ONE)
      return
    }
    const previous = selectedIds
    setSelectedIds(next)
    setSaving(true)
    setError('')
    try {
      const r = await window.api.calendar.setSelectedCalendars(next)
      if (r.success) {
        setSelectedIds(r.selectedIds)
        // 캘린더 화면의 이번 주 일정을 새 선택으로 다시 받는다
        void useCalendarStore
          .getState()
          .refreshEvents()
          .catch(() => {})
      } else {
        setSelectedIds(previous)
        setError(r.error || '선택을 저장하지 못했습니다')
      }
    } catch (e) {
      setSelectedIds(previous)
      setError(e instanceof Error ? e.message : '선택을 저장하지 못했습니다')
    } finally {
      setSaving(false)
    }
  }

  return (
    <CalendarPickerView
      calendars={calendars}
      selectedIds={selectedIds}
      loading={loading}
      saving={saving}
      listFailed={listFailed}
      error={listFailed ? '' : error}
      onToggle={(id, c) => void handleToggle(id, c)}
    />
  )
}
