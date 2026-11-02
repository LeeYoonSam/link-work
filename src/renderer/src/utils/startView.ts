// 앱 첫 화면 판정 (docs/ASSISTANT.md 부록 C.1, A24).
// 순수 함수다. 브라우저 전역·React·스토어를 쓰지 않는다.

export type StartViewSetting = 'auto' | 'dashboard' | 'today'
export type StartPlanStatus = 'none' | 'active' | 'closed'
export type StartView = 'dashboard' | 'today'

export interface StartViewInput {
  startView: StartViewSetting
  enabled: boolean
  planStatus: StartPlanStatus
  // 논리 날짜 'YYYY-MM-DD'. 날짜 경계 전의 새벽은 전날이다
  logicalDate: string
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/

// 'YYYY-MM-DD' 를 로컬 날짜로 읽어 요일(0=일 … 6=토)을 돌려준다.
// new Date('YYYY-MM-DD') 는 UTC 로 읽혀 하루 밀릴 수 있어 쓰지 않는다.
export function weekdayOf(logicalDate: string): number | null {
  const m = YMD.exec(logicalDate)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const date = new Date(y, mo - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return date.getDay()
}

export function resolveStartView(input: StartViewInput): StartView {
  if (input.startView === 'dashboard') return 'dashboard'
  if (input.startView === 'today') return 'today'
  if (!input.enabled) return 'dashboard'
  if (input.planStatus === 'active') return 'today'
  if (input.planStatus === 'closed') return 'dashboard'
  const wd = weekdayOf(input.logicalDate)
  if (wd === null) return 'dashboard'
  return wd >= 1 && wd <= 5 ? 'today' : 'dashboard'
}
