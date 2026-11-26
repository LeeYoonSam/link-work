import { useEffect, useMemo, useState } from 'react'
import { useRecognitionAidsStore } from '../../stores/recognitionAidsStore'
import type { RematchMeetingPlan, RematchOptions } from '../../types'

// 등록된 목소리로 지난 회의의 이름 없는 화자를 다시 찾는 확인 창.
// 열리면 미리보기(저장 안 함)를 보여 주고, [적용]을 누를 때만 저장한다.
// 목소리 표본은 새로 만들지 않는다(동의 없는 프로필 금지).

interface Props {
  open: boolean
  opts: RematchOptions
  onClose: () => void
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'plan'; plan: RematchMeetingPlan[] }
  | { kind: 'applying'; plan: RematchMeetingPlan[] }
  | { kind: 'done'; meetings: number }

// 적용 결과 문구를 보여 준 뒤 닫기까지의 시간
const DONE_CLOSE_MS = 1500

export const REMATCH_NOTICE =
  '자동 지정은 이름까지 붙이고, 제안은 화자 탭에서 확인을 기다립니다. 목소리 표본은 새로 만들지 않습니다. 이미 만든 요약의 화자 이름은 요약을 다시 만들면 반영됩니다.'

/** 미리보기 계획의 요약 숫자 */
export function summarizeRematchPlan(plan: RematchMeetingPlan[]): {
  meetings: number
  speakers: number
  auto: number
  suggested: number
} {
  const all = plan.flatMap((m) => m.speakers)
  return {
    meetings: plan.length,
    speakers: all.length,
    auto: all.filter((s) => s.source === 'auto').length,
    suggested: all.filter((s) => s.source === 'suggested').length
  }
}

export default function RematchDialog({ open, opts, onClose }: Props): React.ReactNode {
  const { previewRematch, applyRematch } = useRecognitionAidsStore()
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  // opts 는 호출측이 렌더마다 새 객체로 넘길 수 있어 내용으로 비교한다
  const optsKey = JSON.stringify(opts)
  const stableOpts = useMemo(() => JSON.parse(optsKey) as RematchOptions, [optsKey])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPhase({ kind: 'loading' })
    void previewRematch(stableOpts).then((plan) => {
      if (cancelled) return
      setPhase(
        plan === null
          ? { kind: 'error', message: '지난 회의를 찾지 못했습니다.' }
          : { kind: 'plan', plan: plan.filter((m) => m.speakers.length > 0) }
      )
    })
    return () => {
      cancelled = true
    }
  }, [open, stableOpts, previewRematch])

  // 적용 문구를 잠깐 보여 준 뒤 닫는다
  useEffect(() => {
    if (phase.kind !== 'done') return
    const t = setTimeout(onClose, DONE_CLOSE_MS)
    return () => clearTimeout(t)
  }, [phase, onClose])

  if (!open) return null

  const handleApply = async (plan: RematchMeetingPlan[]): Promise<void> => {
    setPhase({ kind: 'applying', plan })
    const result = await applyRematch(stableOpts)
    if (result === null) {
      setPhase({ kind: 'error', message: '적용하지 못했습니다.' })
      return
    }
    setPhase({ kind: 'done', meetings: result.meetings })
  }

  const busy = phase.kind === 'applying'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="등록된 목소리로 지난 회의 다시 찾기"
        className="bg-white rounded-xl shadow-xl p-5 w-[26rem] max-w-[calc(100vw-2rem)] max-h-[80vh] flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-semibold text-gray-800">등록된 목소리로 다시 찾기</p>

        {phase.kind === 'loading' && (
          <p className="text-sm text-gray-500 py-4 text-center">지난 회의를 찾는 중…</p>
        )}

        {phase.kind === 'error' && <p className="text-sm text-red-500">{phase.message}</p>}

        {phase.kind === 'done' && (
          <p className="text-sm text-gray-700">회의 {phase.meetings}건에 적용했습니다.</p>
        )}

        {(phase.kind === 'plan' || phase.kind === 'applying') &&
          (phase.plan.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">새로 찾은 화자가 없습니다.</p>
          ) : (
            <PlanView plan={phase.plan} />
          ))}

        <div className="flex gap-2 justify-end pt-1">
          {(phase.kind === 'plan' || phase.kind === 'applying') && phase.plan.length > 0 ? (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors disabled:opacity-50"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => void handleApply(phase.plan)}
                disabled={busy}
                className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {busy ? '적용 중…' : '적용'}
              </button>
            </>
          ) : (
            phase.kind !== 'done' && (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
              >
                닫기
              </button>
            )
          )}
        </div>
      </div>
    </div>
  )
}

function PlanView({ plan }: { plan: RematchMeetingPlan[] }): React.ReactNode {
  const sum = summarizeRematchPlan(plan)
  return (
    <>
      <p className="text-sm text-gray-700">
        회의 {sum.meetings}건에서 화자 {sum.speakers}명을 찾았습니다 (자동 지정 {sum.auto} · 제안{' '}
        {sum.suggested})
      </p>
      <ul className="flex-1 min-h-0 overflow-y-auto space-y-2 border-y border-gray-100 py-2">
        {plan.map((m) => (
          <li key={m.meeting_id} className="space-y-0.5">
            <p className="text-xs font-medium text-gray-700 truncate">
              {m.started_at.slice(0, 10)} {m.title}
            </p>
            {m.speakers.map((s) => (
              <p key={s.speaker_id} className="text-[11px] text-gray-500 pl-2">
                {s.speaker_label} → {s.member_name} · {s.source === 'auto' ? '자동 지정' : '제안'}{' '}
                {Math.round(s.score * 100)}%
              </p>
            ))}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-gray-400 leading-relaxed">{REMATCH_NOTICE}</p>
    </>
  )
}
