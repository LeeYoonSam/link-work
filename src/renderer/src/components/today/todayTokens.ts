// 오늘 화면 전용 시각 상수 (docs/ASSISTANT.md 부록 M.4).
// 공용 ui/tokens.ts 는 다른 화면도 쓴다. 그래서 오늘 화면의 정렬·강조 규칙은 이 파일에만 둔다.

// 할 일 행은 2열이다. 1열 제목·메타, 2열 버튼이다.
// 순위 숫자 열은 두지 않는다. 이유: 집중 항목이 맨 위로 올라가 숫자와 순서가 어긋났다 (부록 M.9)
export const TASK_ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 items-start'

// 회의 행은 캘린더 일정 행과 같은 배치다 (부록 M.10).
// 1열 오른쪽 정렬 시각, 2열 세로 막대, 3열 제목·메모·장소, 4열 버튼이다
export const MEETING_ROW_GRID = 'grid grid-cols-[6.5rem_0.125rem_minmax(0,1fr)_auto] gap-x-3 items-stretch'

// 회의 행 세로 막대. 진행 중이거나 다음 회의 1건만 보라다. 나머지는 회색이다
export const MEETING_BAR = 'w-0.5 rounded-full bg-gray-200'
export const MEETING_BAR_NEXT = 'w-0.5 rounded-full bg-purple-400'

// 행 바깥 여백. 왼쪽 막대 3px 를 항상 그려 막대 유무와 무관하게 x 좌표가 같다
export const ROW_BOX = 'px-5 py-3 border-b border-gray-100 last:border-b-0 border-l-[3px]'

// 강조는 아래 5가지만 쓴다. 다른 강조를 더하지 않는다. 이유: 강조가 늘면 강조가 묻힌다
export const EMPHASIS = {
  // 1. 지금 하는 작업. 채도 높은 파랑은 이 1곳만 쓴다
  focusRow: 'border-l-blue-600 bg-blue-50',
  focusTitle: 'font-semibold',
  // 2. 마감 오늘·지남·긴급. 빨강은 이 뜻 1가지만 가진다
  urgentText: 'text-red-600 font-medium',
  // 3. 진행 중이거나 다음 회의 1건. 임박(15분 이내)은 보라 굵은 글자다. 빨강을 쓰지 않는다
  nextMeetingRow: 'border-l-purple-400',
  soonMeetingText: 'text-purple-700 font-semibold',
  // 4. 후보 카드의 제안 건수
  suggestionCount: 'bg-amber-100 text-amber-700',
  // 5. 끝난 것·지난 것은 흐리게 한다. 강조가 아니다
  dimmed: 'opacity-60'
} as const

// 막대가 없는 행. ROW_BOX 와 함께 쓴다
export const NO_BAR = 'border-l-transparent'

// 시각 글자. 작은 고정폭 숫자다. 줄바꿈하지 않는다
export const TIME_TEXT = 'text-sm text-gray-500 tabular-nums whitespace-nowrap'

// 2열 글자. 제목은 base, 메타는 sm 2단계만 쓴다
export const TITLE_TEXT = 'min-w-0 break-words text-base text-gray-900'
export const META_TEXT = 'mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-500 tabular-nums'

// 카드 안 구역 머리. 카드 제목보다 한 단계 작다
export const SUBSECTION_TITLE = 'px-5 pt-4 pb-2 text-sm font-semibold text-gray-600'

// 출처 배지의 중립색. 출처는 판단 신호가 아니다. 액션아이템·임시만 연한 색을 남긴다
export const NEUTRAL_BADGE = 'bg-gray-100 text-gray-600'

// 요약 타일 색. 타일마다 뜻에 맞는 색 1개를 쓴다. 강조 색 체계와 같은 뜻이다 (부록 M.9)
// 남은 할 일은 작업(파랑), 완료는 초록, 다음 회의는 보라, 집중 가능 시간은 청록이다
export interface TileTone {
  box: string // 카드 배경·테두리
  label: string // 라벨 글자
  value: string // 값 글자
}
export const TILE_TONE: Record<'remaining' | 'done' | 'meeting' | 'free', TileTone> = {
  remaining: { box: 'bg-blue-50 border-blue-200', label: 'text-blue-700', value: 'text-blue-900' },
  done: { box: 'bg-green-50 border-green-200', label: 'text-green-700', value: 'text-green-900' },
  meeting: { box: 'bg-purple-50 border-purple-200', label: 'text-purple-700', value: 'text-purple-900' },
  free: { box: 'bg-teal-50 border-teal-200', label: 'text-teal-700', value: 'text-teal-900' }
}
