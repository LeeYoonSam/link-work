import { ipcMain, BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getDatabase } from '../db/database'
import {
  runAiQuery,
  cancelAiQuery,
  isAiQueryRunning,
  canStartAiQuery,
  getAiProgress,
  findClaudeExecutable,
  resolveAiApproval,
  isAiWriteEnabled,
  setAiWriteEnabled
} from '../services/ai-agent'

// 가드레일: 메시지 길이 상한 (과도한 입력으로 인한 토큰/리소스 낭비 방지)
const MAX_MESSAGE_LENGTH = 4000

export function registerAiIpc(): void {
  const db = getDatabase()

  ipcMain.handle('ai:chatList', () => {
    return db
      .prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM ai_messages m WHERE m.chat_id = c.id) AS message_count,
                (SELECT content FROM ai_messages m WHERE m.chat_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message
         FROM ai_chats c
         ORDER BY c.updated_at DESC`
      )
      .all()
  })

  ipcMain.handle('ai:chatCreate', () => {
    const result = db.prepare("INSERT INTO ai_chats (title) VALUES ('새 대화')").run()
    return { id: result.lastInsertRowid }
  })

  ipcMain.handle('ai:chatDelete', (_event, id: number) => {
    cancelAiQuery(id)
    db.prepare('DELETE FROM ai_chats WHERE id = ?').run(id)
    return { success: true }
  })

  ipcMain.handle('ai:chatRename', (_event, id: number, title: string) => {
    const trimmed = (title ?? '').trim()
    if (!trimmed) return { success: false }
    db.prepare(
      "UPDATE ai_chats SET title = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
    ).run(trimmed, id)
    return { success: true }
  })

  ipcMain.handle('ai:messages', (_event, chatId: number) => {
    return db.prepare('SELECT * FROM ai_messages WHERE chat_id = ? ORDER BY id ASC').all(chatId)
  })

  ipcMain.handle('ai:send', (event, chatId: number, text: string) => {
    const trimmed = (text ?? '').trim()
    if (!trimmed) return { started: false, error: '메시지가 비어 있습니다.' }
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      return {
        started: false,
        error: `메시지가 너무 깁니다. ${MAX_MESSAGE_LENGTH.toLocaleString()}자 이내로 입력해 주세요.`
      }
    }
    if (isAiQueryRunning(chatId)) return { started: false, error: '이미 응답을 생성 중입니다.' }
    if (!canStartAiQuery()) {
      return { started: false, error: '동시에 진행할 수 있는 대화 수를 초과했습니다. 잠시 후 다시 시도해 주세요.' }
    }

    const chat = db.prepare('SELECT id FROM ai_chats WHERE id = ?').get(chatId)
    if (!chat) return { started: false, error: '존재하지 않는 대화입니다.' }

    db.prepare("INSERT INTO ai_messages (chat_id, role, content) VALUES (?, 'user', ?)").run(
      chatId,
      trimmed
    )

    // 첫 사용자 메시지면 대화 제목으로 자동 설정
    const userCount = (
      db
        .prepare("SELECT COUNT(*) AS c FROM ai_messages WHERE chat_id = ? AND role = 'user'")
        .get(chatId) as { c: number }
    ).c
    if (userCount === 1) {
      const autoTitle = trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed
      db.prepare('UPDATE ai_chats SET title = ? WHERE id = ?').run(autoTitle, chatId)
    }
    db.prepare("UPDATE ai_chats SET updated_at = datetime('now', 'localtime') WHERE id = ?").run(
      chatId
    )

    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { started: false, error: '윈도우를 찾을 수 없습니다.' }

    void runAiQuery(chatId, trimmed, win)
    return { started: true }
  })

  ipcMain.handle('ai:cancel', (_event, chatId: number) => {
    return { success: cancelAiQuery(chatId) }
  })

  // 쓰기 도구 승인 카드의 승인/거절 응답 (가드레일: HITL)
  ipcMain.handle('ai:approve', (_event, requestId: string, approved: boolean) => {
    if (typeof requestId !== 'string') return { success: false }
    return { success: resolveAiApproval(requestId, approved === true) }
  })

  ipcMain.handle('ai:getWriteEnabled', () => {
    return { enabled: isAiWriteEnabled() }
  })

  ipcMain.handle('ai:setWriteEnabled', (_event, enabled: boolean) => {
    setAiWriteEnabled(enabled === true)
    return { enabled: isAiWriteEnabled() }
  })

  ipcMain.handle('ai:progress', (_event, chatId: number) => {
    return getAiProgress(chatId)
  })

  ipcMain.handle('ai:status', () => {
    // AI 대화 사용 가능 여부 사전 점검 (메뉴 진입 시 안내용).
    // 정확한 인증 검증은 전송 시점의 실제 오류로 보완된다 (toFriendlyError).
    try {
      const binary = findClaudeExecutable()
      const configPath = join(homedir(), '.claude.json')
      const configExists = existsSync(configPath)

      if (!binary && !configExists) {
        return {
          available: false,
          error:
            'Claude Code가 설치되어 있지 않습니다. AI 대화 기능을 사용하려면 Claude Code를 설치하고 로그인해야 합니다.'
        }
      }
      if (!configExists) {
        return {
          available: false,
          error:
            'Claude Code에 로그인되어 있지 않습니다. 터미널에서 `claude`를 실행해 로그인한 뒤 다시 확인해 주세요.'
        }
      }

      // 로그인 휴리스틱: 구독 OAuth 계정 정보 확인.
      // API 키는 과금 방지를 위해 앱이 차단하므로 사용 가능 근거로 보지 않는다.
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
        const hasOauth = Boolean(config.oauthAccount)
        if (!hasOauth) {
          return {
            available: true,
            warning:
              '구독 계정 로그인을 확인할 수 없습니다. 이 앱은 과금 방지를 위해 API 키 인증을 사용하지 않으므로, 터미널에서 `claude`를 실행해 구독 계정으로 로그인해 주세요.'
          }
        }
      } catch {
        // 설정 파일 파싱 실패 시 판단 보류 — 전송 시점 오류로 안내
      }
      return { available: true }
    } catch {
      // 상태 점검 실패가 기능 진입 자체를 막지 않도록 통과시킨다
      return { available: true }
    }
  })
}
