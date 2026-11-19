// 오늘 대시보드 전용 시각 상수 (docs/ASSISTANT.md 부록 O).
// 공용 ui/tokens.ts 는 다른 화면도 쓴다. 그래서 대시보드의 위계·강조 규칙은 이 파일에만 둔다.
//
// 정보 위계: 헤드라인(lg) > 신호(sm medium) > 카드 제목(sm semibold) > 행(sm) > 메타(xs).
// 색 뜻: 빨강 = 지금 막는 위험·마감 지남, 앰버 = 주의, 파랑 = 정보·지금, 보라 = 회의, 초록 = 완료.
// 색만으로 뜻을 전하지 않는다. severity 는 아이콘 모양(◆ ▲ ●)과 글자 라벨도 함께 쓴다.
import type { SignalSeverity } from '../../types'

export interface SeverityStyle {
  // 보조기술·툴팁용 라벨
  label: string
  // 모양. 색을 못 봐도 구분된다
  shape: 'diamond' | 'triangle' | 'circle'
  // 아이콘 색
  icon: string
  // 신호 행 배경·왼쪽 막대
  row: string
}

export const SEVERITY_STYLE: Record<SignalSeverity, SeverityStyle> = {
  critical: { label: '긴급', shape: 'diamond', icon: 'text-red-600', row: 'bg-red-50/70 border-l-red-500' },
  warn: { label: '주의', shape: 'triangle', icon: 'text-amber-500', row: 'bg-amber-50/60 border-l-amber-400' },
  info: { label: '참고', shape: 'circle', icon: 'text-blue-500', row: 'bg-white border-l-blue-300' }
}

// 카드 머리. 제목 왼쪽, 메타·링크 오른쪽. 좁으면 줄바꿈한다
export const CARD_HEAD = 'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 pt-4 pb-2'
// 카드 제목 옆 건수
export const CARD_COUNT = 'ml-1.5 text-xs font-normal text-gray-400 tabular-nums'

// 행. 좁은 창에서도 가로 스크롤이 없도록 min-w-0 과 break-words 를 쓴다
export const ROW = 'flex items-start gap-2 px-4 py-2 min-w-0'
// 한글은 낱말 단위로 줄바꿈하고(break-keep), 마지막 줄에 한 글자만 남지 않게 한다(text-pretty).
// 띄어쓰기 없는 긴 낱말은 overflow-wrap:anywhere 로 넘친다
export const ROW_TITLE = 'min-w-0 flex-1 break-keep text-pretty [overflow-wrap:anywhere] text-sm text-gray-800'
export const ROW_META = 'text-xs text-gray-500 tabular-nums whitespace-nowrap'

// 카드 아래 '외 n건 →' 링크
export const MORE_LINK =
  'inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline'

// 신호에 올라간 항목 표식. 강조는 이 표식 1가지만 쓴다 (부록 O)
export const SIGNALED_MARK = 'inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500'

// 마감 글자
export const DUE_OVERDUE = 'text-red-600 font-medium'
export const DUE_TODAY = 'text-amber-700 font-medium'

// 지난 것은 흐리게. 강조가 아니다
export const DIMMED = 'opacity-55'

// 이슈 키 칩. 프로젝트 화면 taskTag.issue 와 같은 톤이다
export const ISSUE_KEY = 'shrink-0 rounded px-1 text-[11px] font-mono bg-indigo-50 text-indigo-600'
