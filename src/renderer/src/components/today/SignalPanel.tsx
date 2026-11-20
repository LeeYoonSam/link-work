// 오늘 대시보드의 '지금 챙길 것' (docs/ASSISTANT.md §11.4).
// 신호는 규칙(todayModel)이 만든다. 이 컴포넌트는 그리기와 근거 이동만 한다. 닫기는 없다.
import type { SignalSeverity } from '../../types'
import type { SignalRef, TodaySignal } from './todayModel'
import { minutesUntil, visibleRefs } from './todayModel'
import { useState } from 'react'
import { Card, ChevronDownIcon } from '../ui'
import { CARD_HEAD, MORE_LINK, SEVERITY_STYLE } from './todayTokens'

/** severity 아이콘. 색과 함께 모양(◆ ▲ ●)으로도 구분한다 */
export function SeverityIcon({ severity, size = 16 }: { severity: SignalSeverity; size?: number }): React.ReactNode {
  const s = SEVERITY_STYLE[severity]
  return (
    <span
      role="img"
      aria-label={s.label}
      title={s.label}
      data-severity={severity}
      className={`inline-flex shrink-0 ${s.icon}`}
    >
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        {s.shape === 'diamond' ? (
          <>
            <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill="currentColor" />
            <path d="M8 4.8v4" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="11.2" r="0.9" fill="white" />
          </>
        ) : s.shape === 'triangle' ? (
          <>
            <path d="M8 1.8 15 14H1Z" fill="currentColor" strokeLinejoin="round" />
            <path d="M8 6v3.6" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="11.8" r="0.9" fill="white" />
          </>
        ) : (
          <circle cx="8" cy="8" r="4.5" fill="currentColor" />
        )}
      </svg>
    </span>
  )
}

const REF_CHIP: Record<SignalRef['type'], string> = {
  issue: 'font-mono bg-indigo-50 text-indigo-700 hover:bg-indigo-100',
  todo: 'bg-green-50 text-green-700 hover:bg-green-100',
  meeting: 'bg-purple-50 text-purple-700 hover:bg-purple-100',
  release: 'font-mono bg-slate-100 text-slate-700 hover:bg-slate-200'
}

const REF_KIND_LABEL: Record<SignalRef['type'], string> = {
  issue: '이슈',
  todo: '할 일',
  meeting: '일정',
  release: '릴리스'
}

/** 근거 칩. 누르면 해당 화면으로 간다 */
function RefChip({ item: r, onOpen }: { item: SignalRef; onOpen: (ref: SignalRef) => void }): React.ReactNode {
  return (
    <button
      type="button"
      data-ref-type={r.type}
      data-ref-id={r.id}
      title={`${REF_KIND_LABEL[r.type]} ${r.label} 열기`}
      aria-label={`${REF_KIND_LABEL[r.type]} ${r.label} 열기`}
      onClick={() => onOpen(r)}
      className={`inline-flex max-w-[12rem] items-center rounded px-1.5 py-0.5 text-[11px] transition-colors ${REF_CHIP[r.type]}`}
    >
      {/* 회의 신호는 문구에 이미 제목이 있어 칩은 이동 동작만 말한다 */}
      <span className="truncate">{r.type === 'meeting' ? '일정 보기' : r.label}</span>
    </button>
  )
}

/**
 * meeting_soon 신호의 'n분 뒤'. 화면이 now 로 붙인다 — 브리핑·해시에는 상대 시간을 넣지 않는다.
 * 시작 시각을 모르거나 이미 시작했으면 빈 문자열이다
 */
export function meetingSoonSuffix(
  signal: Pick<TodaySignal, 'kind' | 'refs'>,
  meetingStarts: Record<string, string>,
  now: Date
): string {
  if (signal.kind !== 'meeting_soon') return ''
  const ref = signal.refs.find((r) => r.type === 'meeting')
  const start = ref ? meetingStarts[ref.id] : undefined
  if (!start) return ''
  const min = minutesUntil(start, now)
  return min > 0 ? `${min}분 뒤` : ''
}

/** 신호 행 1개. 보이는 신호와 펼친 숨은 신호가 같은 모양을 쓴다 */
function SignalRow({
  signal: s,
  now,
  meetingStarts,
  onOpenRef
}: {
  signal: TodaySignal
  now: Date
  meetingStarts: Record<string, string>
  onOpenRef: (ref: SignalRef) => void
}): React.ReactNode {
  const style = SEVERITY_STYLE[s.severity]
  const suffix = meetingSoonSuffix(s, meetingStarts, now)
  // 칩 상한은 모델 규칙이다(배포 ref 는 늘 남고 나머지는 4개까지)
  const { refs: shown, moreCount: rest } = visibleRefs(s)
  return (
    <li
      data-signal={s.id}
      data-severity={s.severity}
      className={`mx-2 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border-l-[3px] px-3 py-2 ${style.row}`}
    >
      <SeverityIcon severity={s.severity} />
      <span className="min-w-0 flex-1 basis-48 break-keep text-sm font-medium text-gray-900 [overflow-wrap:anywhere]">
        {s.text}
        {suffix ? <span className="ml-1.5 font-semibold text-purple-700 tabular-nums">· {suffix}</span> : null}
      </span>
      {shown.length > 0 ? (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {shown.map((r) => (
            <RefChip key={`${r.type}:${r.id}`} item={r} onOpen={onOpenRef} />
          ))}
          {rest > 0 ? <span className="text-[11px] text-gray-500 tabular-nums">외 {rest}</span> : null}
        </span>
      ) : null}
    </li>
  )
}

export default function SignalPanel({
  signals,
  hiddenSignals,
  hiddenCount,
  summaryLine,
  now,
  meetingStarts,
  onOpenRef,
  defaultExpanded = false
}: {
  signals: TodaySignal[]
  // 상한(3) 밖으로 밀린 신호. '외 n건' 을 누르면 같은 모양으로 펼친다
  hiddenSignals: TodaySignal[]
  hiddenCount: number
  summaryLine: string
  now: Date
  // 일정 id → 시작 ISO. meeting_soon 의 'n분 뒤' 에 쓴다
  meetingStarts: Record<string, string>
  onOpenRef: (ref: SignalRef) => void
  // 테스트가 펼친 상태를 그릴 때 쓴다
  defaultExpanded?: boolean
}): React.ReactNode {
  const [expanded, setExpanded] = useState(defaultExpanded)
  // 숨은 신호 목록이 아직 없으면(옛 모델) 건수만 글자로 보인다
  const canExpand = hiddenSignals.length > 0
  const rowProps = { now, meetingStarts, onOpenRef }
  return (
    <Card padding="none" className="overflow-hidden">
      <section id="today-signals" aria-labelledby="today-signals-title">
        <div className={CARD_HEAD}>
          <h3 id="today-signals-title" className="text-sm font-semibold text-gray-700">
            지금 챙길 것
          </h3>
          {hiddenCount > 0 && canExpand ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls="today-signals-hidden"
              onClick={() => setExpanded((v) => !v)}
              className={`${MORE_LINK} tabular-nums`}
            >
              {expanded ? '접기' : `외 ${hiddenCount}건`}
              <ChevronDownIcon size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          ) : hiddenCount > 0 ? (
            <span className="text-xs text-gray-400 tabular-nums">외 {hiddenCount}건</span>
          ) : null}
        </div>
        {signals.length === 0 ? (
          <p data-testid="signal-summary" className="px-4 pb-4 text-sm text-gray-600 tabular-nums break-words">
            {summaryLine || '오늘 따로 챙길 일이 없어요.'}
          </p>
        ) : (
          <ul className="pb-2">
            {signals.map((s) => (
              <SignalRow key={s.id} signal={s} {...rowProps} />
            ))}
          </ul>
        )}
        {canExpand && expanded ? (
          <ul id="today-signals-hidden" aria-label="더 챙길 것" className="mx-4 mb-0 border-t border-dashed border-gray-200 pt-2 pb-2 [&>li]:mx-0">
            {hiddenSignals.map((s) => (
              <SignalRow key={s.id} signal={s} {...rowProps} />
            ))}
          </ul>
        ) : null}
      </section>
    </Card>
  )
}
