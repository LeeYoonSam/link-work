import { useState } from 'react'
import type { DailyPlan } from '../../types'
import { Badge, Card, button } from '../ui'
import { hhmmOf, longDateLabel } from './PlanItemRow'

const textareaClass =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none'

interface DayHeaderProps {
  logicalDate: string
  plan: DailyPlan | null
  busy: boolean
  // 어제 메모 입력을 보여 줄 날짜. 없으면 null
  wrapupPromptDate: string | null
  onStartDay: () => void
  onRefresh: () => void
  onCloseDay: (note?: string) => void
  onReopenDay: () => void
  onSaveWrapup: (note: string, date: string) => void
  onSkipWrapup: (date: string) => void
  // 카드 아래쪽에 구분선과 함께 그린다. 하루 브리핑 요약이 온다 (2차 개편 V1)
  children?: React.ReactNode
}

// 헤더는 페이지 제목을 겸한다. 날짜는 화면에서 여기 1번만 보인다 (부록 J.8)
function DateTitle({ date }: { date: string }): React.ReactNode {
  return <h2 className="text-xl font-bold text-gray-900">{longDateLabel(date)}</h2>
}

// 퇴근을 잊은 날 다음에 보여 주는 어제 메모 입력 칸. 입력은 선택이다
function WrapupPrompt({
  date,
  busy,
  onSave,
  onSkip
}: {
  date: string
  busy: boolean
  onSave: (note: string, date: string) => void
  onSkip: (date: string) => void
}): React.ReactNode {
  const [note, setNote] = useState('')
  return (
    <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
      <p className="text-sm text-amber-800 mb-2">어제 메모가 없어요. 한 줄 남길까요?</p>
      <p className="text-sm text-amber-700 mb-2">{longDateLabel(date)} 퇴근 메모로 저장해요.</p>
      <textarea
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="어제 어디까지 했는지 한 줄"
        className={`${textareaClass} bg-white`}
      />
      <div className="flex justify-end gap-2 mt-2">
        <button
          type="button"
          onClick={() => onSkip(date)}
          className={`px-3 py-1.5 text-sm ${button.subtle}`}
        >
          건너뛰기
        </button>
        <button
          type="button"
          disabled={busy || note.trim() === ''}
          onClick={() => onSave(note, date)}
          className={`px-3 py-1.5 text-sm ${button.primary} disabled:opacity-50`}
        >
          저장
        </button>
      </div>
    </div>
  )
}

export default function DayHeader({
  logicalDate,
  plan,
  busy,
  wrapupPromptDate,
  onStartDay,
  onRefresh,
  onCloseDay,
  onReopenDay,
  onSaveWrapup,
  onSkipWrapup,
  children
}: DayHeaderProps): React.ReactNode {
  const [closing, setClosing] = useState(false)
  const [closeNote, setCloseNote] = useState('')

  const wrapup = wrapupPromptDate ? (
    <WrapupPrompt
      date={wrapupPromptDate}
      busy={busy}
      onSave={onSaveWrapup}
      onSkip={onSkipWrapup}
    />
  ) : null

  const footer = children ? <div className="mt-4 pt-4 border-t border-gray-100">{children}</div> : null

  if (!plan) {
    return (
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div>
            <DateTitle date={logicalDate} />
            <p className="text-sm text-gray-700 mt-1">아직 하루를 시작하지 않았어요</p>
            <p className="text-sm text-gray-500 mt-1">
              하루를 시작하면 비서가 일정과 할 일을 모아 오늘 계획을 만들어요.
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onStartDay}
            className={`shrink-0 px-5 py-2.5 text-sm font-medium ${button.primary} disabled:opacity-50`}
          >
            {busy ? '계획 만드는 중…' : '하루 시작'}
          </button>
        </div>
        {wrapup}
        {footer}
      </Card>
    )
  }

  if (plan.status === 'closed') {
    return (
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <DateTitle date={plan.plan_date} />
              <Badge color="bg-gray-100 text-gray-600">오늘 마감</Badge>
            </div>
            {plan.closed_at || plan.closed_by === 'auto' ? (
              <p className="text-sm text-gray-500 mt-1 tabular-nums">
                {plan.closed_at ? `${hhmmOf(plan.closed_at)} 퇴근` : ''}
                {plan.closed_by === 'auto' ? ' · 자동 닫기' : ''}
              </p>
            ) : null}
            <p className="text-sm text-gray-700 mt-2 whitespace-pre-line break-words">
              {plan.wrapup_note ? plan.wrapup_note : '퇴근 메모 없음'}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={onReopenDay}
            className={`shrink-0 px-4 py-2 text-sm ${button.subtle} disabled:opacity-50`}
          >
            다시 열기
          </button>
        </div>
        {wrapup}
        {footer}
      </Card>
    )
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <DateTitle date={plan.plan_date} />
            <Badge color="bg-green-100 text-green-700">근무 중</Badge>
          </div>
          <p className="text-sm text-gray-700 mt-1">
            {hhmmOf(plan.started_at)} 시작
            <span className="text-sm text-gray-500 ml-2 tabular-nums">
              마지막 최신화 {plan.last_refresh_at ? hhmmOf(plan.last_refresh_at) : '없음'}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={busy}
            onClick={onRefresh}
            className={`px-3 py-2 text-sm ${button.subtle} disabled:opacity-50`}
          >
            {busy ? '처리 중…' : '새로고침'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setClosing(true)}
            className={`px-3 py-2 text-sm ${button.dark} disabled:opacity-50`}
          >
            퇴근
          </button>
        </div>
      </div>

      {closing ? (
        <div className="mt-4 border border-gray-200 rounded-lg p-3">
          <textarea
            rows={3}
            value={closeNote}
            onChange={(e) => setCloseNote(e.target.value)}
            placeholder="퇴근 메모 1~3줄. 다음 출근 때 이어서 볼 내용을 적어 주세요."
            className={textareaClass}
          />
          <div className="flex justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={() => {
                setClosing(false)
                setCloseNote('')
              }}
              className={`px-3 py-1.5 text-sm ${button.subtle}`}
            >
              취소
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onCloseDay(closeNote)
                setClosing(false)
                setCloseNote('')
              }}
              className={`px-3 py-1.5 text-sm ${button.dark} disabled:opacity-50`}
            >
              퇴근하기
            </button>
          </div>
        </div>
      ) : null}

      {wrapup}
      {footer}
    </Card>
  )
}
