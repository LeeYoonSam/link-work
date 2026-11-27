// 오늘 대시보드의 '나에게 온 요청' 카드 (docs/ASSISTANT.md §11.6).
// Jira 할당·멘션 댓글과 Bitbucket 리뷰 요청을 한 목록으로 보인다. 행마다 [할 일로]·[처리함] 을 둔다.
// 둘 다 연결되지 않았으면 카드를 그리지 않는다(연결을 조르지 않는다).
import { useState } from 'react'
import type { InboxSourceStatus, RequestInboxItem, RequestInboxSnapshot, RequestKind } from '../../types'
import { Card } from '../ui'
import { CARD_COUNT, CARD_HEAD, ISSUE_KEY, MORE_LINK, ROW, ROW_TITLE } from './todayTokens'

/** 접힌 상태에서 보이는 행 수 */
export const INBOX_VISIBLE = 6

const KIND_LABEL: Record<RequestKind, string> = {
  assigned: '담당',
  mention: '멘션',
  review: '리뷰'
}

const KIND_CLS: Record<RequestKind, string> = {
  assigned: 'bg-blue-50 text-blue-700',
  mention: 'bg-amber-50 text-amber-800',
  review: 'bg-emerald-50 text-emerald-700'
}

/** '방금' · 'n분 전' · 'n시간 전' · 'n일 전'. 깨진 값이면 null */
export function relativeTime(iso: string | null, now: Date): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const min = Math.floor((now.getTime() - t) / 60_000)
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}시간 전`
  return `${Math.floor(h / 24)}일 전`
}

/** 카드를 그릴지. Jira·Bitbucket 둘 다 연결되지 않았으면 false */
export function inboxVisible(snapshot: RequestInboxSnapshot | null): boolean {
  if (!snapshot) return false
  return snapshot.jira.state !== 'not_connected' || snapshot.bitbucket.state !== 'not_connected'
}

/** 카드 아래 안내 줄. 오류와 워크스페이스 미지정만 말한다(줄마다 설정 > 연동 링크). 연결돼 있고 정상이면, 또 미연결이면 말하지 않는다 */
export function sourceNotes(snapshot: RequestInboxSnapshot): { text: string; tone: 'error' | 'hint' }[] {
  const notes: { text: string; tone: 'error' | 'hint' }[] = []
  const add = (name: string, s: InboxSourceStatus): void => {
    if (s.state === 'error') notes.push({ text: `${name}: ${s.error ?? '불러오지 못했어요'}`, tone: 'error' })
  }
  add('Jira', snapshot.jira)
  add('Bitbucket', snapshot.bitbucket)
  if (snapshot.bitbucket.state === 'no_workspace') {
    notes.push({ text: 'Bitbucket 워크스페이스를 정하면 리뷰 요청도 모아요.', tone: 'hint' })
  }
  return notes
}

function InboxRow({
  item,
  now,
  busy,
  onOpen,
  onToTodo,
  onDismiss
}: {
  item: RequestInboxItem
  now: Date
  busy: boolean
  onOpen: (id: string) => void
  onToTodo: (id: string) => void
  onDismiss: (id: string) => void
}): React.ReactNode {
  const when = relativeTime(item.requestedAt, now)
  const meta = [item.actor, when].filter(Boolean).join(' · ')
  return (
    <li data-request={item.id} className={ROW}>
      <span className={`mt-0.5 shrink-0 rounded px-1 text-[11px] font-medium ${KIND_CLS[item.kind]}`}>
        {KIND_LABEL[item.kind]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <button
            type="button"
            onClick={() => onOpen(item.id)}
            className={`${ISSUE_KEY} hover:bg-indigo-100`}
            title="원본 열기"
          >
            {item.ref}
          </button>
          <span className={`${ROW_TITLE} max-w-full flex-none basis-auto`}>{item.title}</span>
        </div>
        {item.excerpt ? (
          <p className="mt-0.5 line-clamp-2 break-words text-xs text-gray-500">“{item.excerpt}”</p>
        ) : null}
        {meta ? <p className="mt-0.5 text-[11px] text-gray-400 tabular-nums">{meta}</p> : null}
      </div>
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => onToTodo(item.id)}
          className="rounded-md bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-50"
        >
          할 일로
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDismiss(item.id)}
          className="rounded-md px-2 py-0.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-50"
          title="처리했어요. 다시 보이지 않아요"
        >
          처리함
        </button>
      </span>
    </li>
  )
}

export default function RequestInboxCard({
  snapshot,
  now,
  busyIds,
  error,
  onOpen,
  onToTodo,
  onDismiss,
  onOpenSettings
}: {
  snapshot: RequestInboxSnapshot | null
  now: Date
  busyIds: string[]
  /** 스토어 오류(동기화·처리 실패) */
  error: string | null
  onOpen: (id: string) => void
  onToTodo: (id: string) => void
  onDismiss: (id: string) => void
  onOpenSettings: () => void
}): React.ReactNode {
  const [expanded, setExpanded] = useState(false)
  if (!snapshot || !inboxVisible(snapshot)) return null
  const items = snapshot.items
  const shown = expanded ? items : items.slice(0, INBOX_VISIBLE)
  const hidden = items.length - shown.length
  const notes = sourceNotes(snapshot)

  return (
    <Card padding="none">
      <section id="today-inbox" aria-labelledby="today-inbox-title">
        <div className={CARD_HEAD}>
          <h3 id="today-inbox-title" className="text-sm font-semibold text-gray-700">
            나에게 온 요청
            {items.length > 0 ? <span className={CARD_COUNT}>{items.length}</span> : null}
          </h3>
        </div>

        {items.length === 0 ? (
          <p className="px-4 pb-3 text-sm text-gray-400">새로 온 요청이 없어요.</p>
        ) : (
          <ul className="pb-1">
            {shown.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                now={now}
                busy={busyIds.includes(item.id)}
                onOpen={onOpen}
                onToTodo={onToTodo}
                onDismiss={onDismiss}
              />
            ))}
          </ul>
        )}

        {hidden > 0 || expanded ? (
          <div className="border-t border-gray-100 px-4 py-2 text-right">
            <button type="button" onClick={() => setExpanded(!expanded)} className={MORE_LINK}>
              {expanded ? '접기' : `외 ${hidden}건 더 보기`}
            </button>
          </div>
        ) : null}

        {notes.length > 0 || error ? (
          <div className="space-y-0.5 px-4 pb-3 text-xs">
            {notes.map((n) => (
              <p key={n.text} className={`break-words ${n.tone === 'error' ? 'text-amber-700' : 'text-gray-400'}`}>
                {n.text}
                <button type="button" onClick={onOpenSettings} className={`ml-1 ${MORE_LINK}`}>
                  설정 →
                </button>
              </p>
            ))}
            {error ? <p className="break-words text-amber-700">{error}</p> : null}
          </div>
        ) : null}
      </section>
    </Card>
  )
}
