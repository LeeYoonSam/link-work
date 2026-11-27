import { ipcMain, shell } from 'electron'
import {
  cachedRequestInbox,
  convertRequestToTodo,
  dismissRequest,
  requestUrl,
  syncRequestInbox
} from '../services/request-inbox'
import { resolveOpenTarget } from '../utils/open-target'

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err)
}

// 나에게 온 요청 (docs/ASSISTANT.md §11.6). 원본(Jira·Bitbucket)은 읽기만 한다.
// 네트워크가 얽힌 채널이라 throw 하지 않고 { success, error } 로 감싼다. renderer 값은 믿지 않는다:
// id 는 문자열 길이만 보고 DB 에서 찾는다. 열 주소는 renderer 가 보내지 않고 저장된 행에서 꺼낸다.
export function registerRequestInboxIpc(): void {
  // DB 저장본만 읽는다. 원본을 부르지 않는다
  ipcMain.handle('inbox:cached', () => {
    try {
      return { success: true, snapshot: cachedRequestInbox() }
    } catch (err) {
      return { success: false, error: errorText(err) }
    }
  })

  // 마지막 동기화 10분(force 면 30초) 안의 재호출은 저장본을 돌려준다
  ipcMain.handle('inbox:sync', async (_event, force: unknown) => {
    try {
      return { success: true, snapshot: await syncRequestInbox(force === true) }
    } catch (err) {
      return { success: false, error: errorText(err) }
    }
  })

  // dueDate: 'YYYY-MM-DD' 또는 null
  ipcMain.handle('inbox:toTodo', (_event, id: unknown, dueDate: unknown) => {
    try {
      return convertRequestToTodo(id, dueDate ?? null)
    } catch (err) {
      return { success: false, error: errorText(err) }
    }
  })

  ipcMain.handle('inbox:dismiss', (_event, id: unknown) => {
    try {
      return dismissRequest(id)
    } catch (err) {
      return { success: false, error: errorText(err) }
    }
  })

  ipcMain.handle('inbox:open', async (_event, id: unknown) => {
    const url = requestUrl(id)
    if (!url) return { success: false, error: '열 수 없는 요청입니다. 새로고침한 뒤 다시 시도해 주세요.' }
    const target = resolveOpenTarget(url, 'link')
    if (!target.ok) return { success: false, error: target.error }
    if (target.kind !== 'external') return { success: false, error: 'https 링크만 열 수 있습니다.' }
    try {
      await shell.openExternal(target.target)
      return { success: true }
    } catch (err) {
      return { success: false, error: errorText(err) }
    }
  })
}
