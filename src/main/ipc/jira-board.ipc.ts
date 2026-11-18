import { ipcMain, shell } from 'electron'
import {
  cachedJiraBoard,
  fetchJiraBoard,
  isKnownJiraBoardLink,
  summarizeJiraEpic,
  type JiraBoardSyncMode
} from '../services/jira-board'
import { resolveOpenTarget } from '../utils/open-target'

const SYNC_MODES: readonly JiraBoardSyncMode[] = ['auto', 'incremental', 'full']
const BAD_MODE_MESSAGE = '잘못된 동기화 방식입니다.'
const UNKNOWN_LINK_MESSAGE = '보드에 없는 링크라 열 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.'

/**
 * 보드 링크를 기본 브라우저로 연다. 렌더러가 보낸 값은 믿지 않는다:
 * http(s)이고 저장된 스냅샷의 어떤 이슈 links 에 든 URL 일 때만 열고, 마지막으로 open-target 검사를 거친다.
 */
export async function openJiraBoardLink(url: unknown): Promise<{ success: true } | { success: false; error: string }> {
  const target = resolveOpenTarget(url, 'link')
  if (!target.ok) return { success: false, error: target.error }
  if (target.kind !== 'external' || !/^https?:\/\//i.test(target.target)) {
    return { success: false, error: 'http(s) 링크만 열 수 있습니다.' }
  }
  if (!isKnownJiraBoardLink(url)) return { success: false, error: UNKNOWN_LINK_MESSAGE }
  try {
    await shell.openExternal(target.target)
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Jira가 얽힌 채널이라 throw하지 않고 { success, error }로 감싼다(서비스가 감싼다).
// renderer 값은 신뢰하지 않는다. mode는 목록에 있는 값만 받고, 이슈 키는 서비스가 정규식으로 검증한다.
export function registerJiraBoardIpc(): void {
  // DB 저장본만 읽는다. Jira를 부르지 않는다. 화면이 열리자마자 보이는 용도다
  ipcMain.handle('jiraBoard:cached', () => cachedJiraBoard())

  ipcMain.handle('jiraBoard:fetch', (_event, mode: unknown) => {
    if (mode === undefined) return fetchJiraBoard('auto')
    if (typeof mode !== 'string' || !(SYNC_MODES as readonly string[]).includes(mode)) {
      return { success: false, error: BAD_MODE_MESSAGE }
    }
    return fetchJiraBoard(mode as JiraBoardSyncMode)
  })

  ipcMain.handle('jiraBoard:openLink', (_event, url: unknown) => openJiraBoardLink(url))

  // 사용자가 버튼을 눌렀을 때만 부른다. 자동 생성하지 않는다
  ipcMain.handle('jiraBoard:summarizeEpic', (_event, epicKey: unknown) => summarizeJiraEpic(epicKey))
}
