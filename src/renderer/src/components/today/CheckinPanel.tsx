import { useState } from 'react'
import type { AssistantEvent, CheckinPayload, CheckinStatus, PlanItem } from '../../types'
import { Card, SectionTitle, button } from '../ui'
import CommandInput from './CommandInput'
import { hhmmOf } from './PlanItemRow'

// 작업 경계 체크인 패널 (docs/ASSISTANT.md 부록 H.8.1).
// 알림 클릭과 패널 버튼은 같은 respondCheckin 을 부른다 (A43).

export interface PendingCheckin {
  event: AssistantEvent
  item: PlanItem
  payload: CheckinPayload
}

const NOTE_MAX = 500

type RespondFn = (
  eventId: number,
  status: CheckinStatus | null,
  note?: string
) => Promise<boolean> | void

// 응답을 보낸다. 메모는 완료·진행 중·미룸에만 보낸다. 넘기기는 status null 이다.
// 응답이 성공했을 때만 메모를 비운다. 실패하면 사용자가 다시 누를 수 있게 메모를 둔다
export async function submitCheckin(
  onRespond: RespondFn,
  eventId: number,
  status: CheckinStatus | null,
  note: string,
  clearNote: () => void
): Promise<void> {
  const trimmed = note.trim()
  const ok = await onRespond(eventId, status, status !== null && trimmed ? trimmed : undefined)
  if (ok === true) clearNote()
}

// 체크인 이벤트의 payload 를 읽는다. 모양이 틀리면 null 이다
export function parseCheckinPayload(payload: string | null): CheckinPayload | null {
  if (!payload) return null
  try {
    const p = JSON.parse(payload) as Partial<CheckinPayload> | null
    if (!p || typeof p !== 'object') return null
    if (typeof p.itemId !== 'number' || !Number.isInteger(p.itemId)) return null
    if (typeof p.blockStart !== 'string' || typeof p.blockEnd !== 'string') return null
    return {
      itemId: p.itemId,
      candidateId: typeof p.candidateId === 'string' ? p.candidateId : '',
      itemTitle: typeof p.itemTitle === 'string' ? p.itemTitle : '',
      blockStart: p.blockStart,
      blockEnd: p.blockEnd,
      title: typeof p.title === 'string' ? p.title : '',
      body: typeof p.body === 'string' ? p.body : ''
    }
  } catch {
    return null
  }
}

const isOpenStatus = (s: PlanItem['status']): boolean => s === 'planned' || s === 'in_progress'

// 응답을 기다리는 체크인 1건을 고른다 (부록 H.8.1).
// 응답 없는 checkin 행 중 항목이 아직 활성인 행만 남기고, fired_at 이 가장 늦은 1건을 돌려준다
export function pendingCheckin(events: AssistantEvent[], items: PlanItem[]): PendingCheckin | null {
  let best: PendingCheckin | null = null
  for (const event of events) {
    if (event.kind !== 'checkin' || event.response !== null) continue
    const payload = parseCheckinPayload(event.payload)
    if (!payload) continue
    const item = items.find((i) => i.id === payload.itemId)
    if (!item || !isOpenStatus(item.status)) continue
    const at = event.fired_at ?? ''
    if (!best || at > (best.event.fired_at ?? '')) best = { event, item, payload }
  }
  return best
}

const ANSWERS: Array<{ status: CheckinStatus; label: string }> = [
  { status: 'done', label: '완료' },
  { status: 'in_progress', label: '진행 중' },
  { status: 'deferred', label: '미룸' }
]

const inputClass =
  'flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400'

export default function CheckinPanel({
  pending,
  busy,
  readOnly,
  onRespond,
  onApplied
}: {
  pending: PendingCheckin
  busy: boolean
  readOnly: boolean
  // 성공 여부를 돌려주면, 성공했을 때만 메모를 비운다
  onRespond: RespondFn
  // CommandInput.onApplied
  onApplied: () => void
}): React.ReactNode {
  const [note, setNote] = useState('')
  const { event, item, payload } = pending
  const firedAt = hhmmOf(event.fired_at ?? event.scheduled_at)

  const respond = (status: CheckinStatus | null): void => {
    void submitCheckin(onRespond, event.id, status, note, () => setNote(''))
  }

  return (
    <div id="today-checkin">
      <Card padding="sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-blue-500" />
            <SectionTitle>{firedAt ? `체크인 · ${firedAt}` : '체크인'}</SectionTitle>
          </div>
          {readOnly ? <span className="text-[11px] text-gray-500">오늘 마감</span> : null}
        </div>
        <p className="mt-2 text-sm text-gray-800">
          <span className="tabular-nums text-gray-500">
            {payload.blockStart}–{payload.blockEnd}
          </span>{' '}
          <span className="font-medium">{item.title}</span>
        </p>
        <p className="mt-0.5 text-xs text-gray-600">어떻게 됐나요?</p>

        {readOnly ? null : (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {ANSWERS.map((a) => (
                <button
                  key={a.status}
                  type="button"
                  disabled={busy}
                  onClick={() => respond(a.status)}
                  className={`px-2.5 py-1 text-xs ${a.status === 'done' ? button.primary : button.subtle} disabled:opacity-50`}
                >
                  {a.label}
                </button>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={() => respond(null)}
                className={`px-2.5 py-1 text-xs ${button.ghost} disabled:opacity-50`}
              >
                넘기기
              </button>
            </div>
            <div className="mt-2 flex">
              <input
                type="text"
                value={note}
                maxLength={NOTE_MAX}
                disabled={busy}
                placeholder="한 줄 메모 (선택)"
                onChange={(e) => setNote(e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="mt-3 pt-3 border-t border-gray-100">
              <CommandInput scopeItemId={item.id} onApplied={onApplied} />
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
