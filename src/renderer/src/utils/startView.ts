// 앱 첫 화면 판정 (docs/ASSISTANT.md 부록 C.1, A24).
// 순수 함수다. 브라우저 전역·React·스토어를 쓰지 않는다.

export type StartView = 'today' | 'projects' | 'calendar'

export const START_VIEWS: readonly StartView[] = ['today', 'projects', 'calendar']

const START_VIEW_SET: ReadonlySet<string> = new Set(START_VIEWS)

// 설정값을 첫 화면으로 바꾼다. 알려진 값은 그대로 쓴다.
// 예전 값 auto·dashboard 와 모르는 값은 today 다. 이유: 홈을 today 1개로 합쳤다.
// 저장된 설정 행은 다시 쓰지 않는다. 읽을 때 정규화해 백업 복원도 같은 규칙을 따른다
export function resolveStartView(setting: unknown): StartView {
  if (typeof setting === 'string' && START_VIEW_SET.has(setting)) return setting as StartView
  return 'today'
}
