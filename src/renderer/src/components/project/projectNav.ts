// 프로젝트 페이지 탭 사이의 이동(티켓 ↔ 릴리스 ↔ 문서). 스토어는 읽기·기존 액션 호출만 한다.
import { useNavigationStore } from '../../stores/navigationStore'
import { useJiraBoardStore } from '../../stores/jiraBoardStore'
import { useReleaseNoteStore } from '../../stores/releaseNoteStore'
import { useFocusStore } from '../../stores/focusStore'

/**
 * fixVersion 칩 → 릴리스 탭. 릴리스 목록의 jira_version_id 로 대응 릴리스를 찾아 기존 release 포커스 흐름을 쓴다.
 * 목록에 없으면 릴리스 탭만 연다. 탭을 먼저 열고 포커스를 뒤에 건다 — 릴리스 화면은 요청을 구독하므로 늦게 와도 받는다.
 */
export async function openReleaseForVersion(versionId: string): Promise<void> {
  useNavigationStore.getState().openProjectsTab('releases')
  const rs = useReleaseNoteStore.getState()
  if (!rs.allLoaded) {
    try {
      await rs.fetchAllReleaseNotes()
    } catch {
      return
    }
  }
  const note = useReleaseNoteStore.getState().allNotes.find((n) => n.jira_version_id === versionId)
  if (note) useFocusStore.getState().requestFocus({ entity: 'release', id: note.id })
}

/** 티켓 탭에서 그 이슈를 선택·펼친다. 보드에 없으면 아무것도 하지 않고 false */
export function revealInTickets(key: string): boolean {
  if (!useJiraBoardStore.getState().revealIssue(key)) return false
  useNavigationStore.getState().openProjectsTab('tickets')
  return true
}

/** 문서 탭을 그 검색어로 연다(에픽 키면 그 에픽 그룹 전체가 나온다) */
export function openDocsFor(query: string): void {
  useJiraBoardStore.getState().setDocsFilter({ query, kinds: [], sources: [] })
  useNavigationStore.getState().openProjectsTab('docs')
}

/** 저장된 링크를 기본 브라우저로 연다. 실패 문구를 돌려준다(성공이면 null) */
export async function openBoardLink(url: string): Promise<string | null> {
  try {
    const res = await window.api.jiraBoard.openLink(url)
    return res.success ? null : res.error
  } catch (e) {
    return e instanceof Error ? e.message : '링크를 열지 못했어요'
  }
}
