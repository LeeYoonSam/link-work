// 한글 등 IME 조합 중의 Enter 를 걸러 낸다.
// macOS 한글 입력에서 조합 중 Enter 를 누르면 keydown 이 두 번 온다: 조합 확정(isComposing=true, keyCode 229)과
// 그 뒤의 실제 Enter. 두 번 모두 처리하면 추가·저장이 두 번 일어난다(구성원·용어집 중복 추가 버그).

export interface EnterLikeEvent {
  key: string
  keyCode?: number
  nativeEvent?: { isComposing?: boolean }
}

/** 조합이 끝난 실제 Enter 인가. 조합 확정용 keydown 은 false */
export function isCommitEnter(e: EnterLikeEvent): boolean {
  if (e.key !== 'Enter') return false
  if (e.nativeEvent?.isComposing) return false
  return e.keyCode !== 229
}
