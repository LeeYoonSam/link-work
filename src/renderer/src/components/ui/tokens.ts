// LinkWork 디자인 시스템 토큰 — Soft Status Pills 스타일
// 원칙: 파스텔 배경(50~100) + 톤다운 텍스트(600~700) 뱃지, 도트/바 상태 표현,
// 단일 파란 액센트(오늘/현재), 화이트 카드 + gray-200 보더, 마이크로 라벨은 uppercase tracking.

export interface StatusStyle {
  label: string
  badge: string // 파스텔 필 뱃지
  dot: string // 상태 도트
}

// 프로젝트 상태
export const projectStatus: Record<string, StatusStyle> = {
  scheduled: { label: 'Scheduled', badge: 'bg-slate-100 text-slate-700', dot: 'bg-slate-400' },
  development: { label: 'Development', badge: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
  qa_pending: {
    label: 'QA Pending',
    badge: 'bg-teal-100 text-teal-700',
    dot: 'bg-teal-500'
  },
  qa: { label: 'QA', badge: 'bg-orange-100 text-orange-700', dot: 'bg-orange-500' },
  deploy_pending: {
    label: 'Deploy Pending',
    badge: 'bg-amber-100 text-amber-700',
    dot: 'bg-amber-500'
  },
  deploy: { label: 'Deploy', badge: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
  completed: { label: 'Completed', badge: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500' },
  cancelled: { label: 'Cancelled', badge: 'bg-gray-100 text-gray-600', dot: 'bg-gray-400' }
}

// 태스크 상태 (ScheduleTimeline의 바/도트 문법 포함)
export const taskStatus: Record<string, StatusStyle & { bar: string }> = {
  pending: {
    label: 'Pending',
    badge: 'bg-gray-100 text-gray-600',
    dot: 'bg-white border-2 border-gray-300',
    bar: 'bg-gray-100 border border-dashed border-gray-300'
  },
  in_progress: {
    label: 'In Progress',
    badge: 'bg-yellow-100 text-yellow-700',
    dot: 'bg-yellow-400 border border-yellow-500',
    bar: 'bg-yellow-100 border border-yellow-300'
  },
  done: {
    label: 'Done',
    badge: 'bg-green-100 text-green-700',
    dot: 'bg-green-500 border border-green-600',
    bar: 'bg-green-200/80 border border-green-300'
  }
}

// TODO 우선순위
export const todoPriority: Record<string, StatusStyle> = {
  high: { label: '높음', badge: 'bg-red-50 text-red-600', dot: 'bg-red-500' },
  medium: { label: '중간', badge: 'bg-blue-50 text-blue-600', dot: 'bg-blue-500' },
  low: { label: '낮음', badge: 'bg-gray-50 text-gray-500', dot: 'bg-gray-400' }
}

// 프로젝트 페이즈 (타임라인 밴드/날짜 마커)
export const phase = {
  dev: { band: 'bg-purple-100/80 text-purple-600', text: 'text-purple-600' },
  qa: { band: 'bg-orange-100 text-orange-600', text: 'text-orange-500', tint: 'bg-orange-50/80' },
  deploy: { marker: 'bg-red-500', text: 'text-red-600' },
  today: { accent: 'bg-blue-600', line: 'bg-blue-500/70', text: 'text-blue-600' }
}

// 기간 경과율 단계 (대시보드 진행 바)
export const urgency = {
  early: { bar: 'bg-green-500', text: 'text-green-700', label: 'Early' },
  mid: { bar: 'bg-blue-500', text: 'text-blue-700', label: 'Mid' },
  late: { bar: 'bg-red-500', text: 'text-red-700', label: 'Late' }
}

// 타이포그래피
export const typo = {
  pageTitle: 'text-lg font-semibold text-gray-900',
  cardTitle: 'text-sm font-semibold text-gray-700',
  microLabel: 'text-[11px] font-medium text-gray-400 uppercase tracking-wide',
  meta: 'text-xs text-gray-500',
  metaFaint: 'text-xs text-gray-400'
}

// 서피스
export const surface = {
  card: 'bg-white border border-gray-200 rounded-lg',
  cardHover: 'hover:shadow-md transition-shadow cursor-pointer',
  subtle: 'bg-gray-50 rounded-md'
}

// 버튼
export const button = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700 transition-colors rounded-md',
  dark: 'bg-gray-900 text-white hover:bg-gray-800 transition-colors rounded-md',
  subtle: 'bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors rounded-md',
  danger: 'bg-red-50 text-red-600 hover:bg-red-100 transition-colors rounded-md',
  ghost: 'text-gray-400 hover:text-gray-600 transition-colors'
}
