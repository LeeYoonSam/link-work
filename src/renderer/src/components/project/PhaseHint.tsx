import { getPhaseHint, type PhaseFields } from '../../utils/projectPhase'

// 다음 단계까지 남은 일수에 따른 D-day 강조색.
// 파스텔 배지와 균형이 맞도록 소프트 톤(500). 임박(≤3일)만 레드로 강조하고,
// 그 외는 차분한 회색으로 둔다. 앰버 단계는 deploy_pending 배지(앰버)와 겹쳐 제외.
function ddayColor(daysLeft: number): string {
  if (daysLeft <= 3) return 'text-red-500'
  return 'text-gray-400'
}

interface Props {
  project: PhaseFields
  today?: string
  // 텍스트 크기 등 래퍼 클래스 override (기본 text-xs). 트레이는 text-[11px] 사용.
  className?: string
}

// 현재 상태 기준 한 줄 보조 정보.
// - development / qa: 'N/M일차' (차분한 회색 — 진행 중)
// - qa_pending / deploy_pending / scheduled: '다음단계 D-N' (라벨 회색 + D-day 긴급도 색)
export default function PhaseHint({ project, today, className }: Props): React.ReactNode {
  const hint = getPhaseHint(project, today)
  if (!hint) return null

  const base = `whitespace-nowrap tabular-nums ${className ?? 'text-xs'}`

  if (hint.kind === 'day') {
    return <span className={`${base} font-medium text-gray-500`}>{hint.text}</span>
  }

  return (
    <span className={base}>
      <span className="text-gray-400">{hint.label} </span>
      <span className={`font-semibold ${ddayColor(hint.daysLeft)}`}>{hint.dday}</span>
    </span>
  )
}
