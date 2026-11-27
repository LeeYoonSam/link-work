import { ipcMain, BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getAiReadOnlyDatabase, getDatabase } from '../db/database'
import {
  runAiQuery,
  cancelAiQuery,
  isAiQueryRunning,
  canStartAiQuery,
  getAiProgress,
  findClaudeExecutable,
  getAiChatModelOptions,
  resolveAiApproval,
  setChatWriteMode,
  type AiApprovalOptions,
  type AiWriteMode
} from '../services/ai-agent'
import {
  removeChatAttachments,
  saveAttachments,
  validateAttachments,
  type AiAttachmentInput,
  type SavedAttachment
} from '../services/ai-attachments'
import { discardChatIfEmpty, purgeEmptyChats } from '../services/ai-chat-cleanup'
import { getAiChatModel, isAiChatModelChoice, setAiChatModel } from '../services/ai-model'
import {
  disconnectBitbucket,
  getBitbucketEmail,
  getBitbucketWorkspace,
  isBitbucketConnected,
  saveBitbucketCredentials,
  setBitbucketWorkspace
} from '../services/bitbucket'
import { markRequestInboxStale } from '../services/request-inbox'
import { disconnectNotion, isNotionConnected, saveNotionToken } from '../services/notion'
import {
  buildAiSuggestions,
  fallbackSuggestions,
  normalizeSuggestionVariant,
  type AiSuggestion
} from '../services/ai-suggestions'

const AI_WRITE_MODES: AiWriteMode[] = ['readonly', 'ask', 'auto', 'plan']

// 가드레일: 메시지 길이 상한 (과도한 입력으로 인한 토큰/리소스 낭비 방지)
const MAX_MESSAGE_LENGTH = 4000

// 가드레일: Bitbucket 연동 입력 길이 상한 (비정상 입력 차단)
const MAX_BITBUCKET_EMAIL_LENGTH = 254
const MAX_BITBUCKET_TOKEN_LENGTH = 1000

export function registerAiIpc(): void {
  const db = getDatabase()

  // 앱 시작 시 메시지 없는 대화를 지운다. 시작 시점에는 진행 중인 응답이 없다.
  try {
    const purged = purgeEmptyChats(db)
    if (purged.length > 0) {
      console.log(`[ai] 메시지 없는 빈 대화 ${purged.length}개를 정리했습니다.`)
      for (const id of purged) void removeChatAttachments(id)
    }
  } catch (err) {
    console.warn('[ai] 빈 대화 정리 실패:', err)
  }

  // ai:send 가 첨부 저장을 기다리는 동안(사용자 메시지 INSERT 전)의 채팅 id.
  // 이 사이에 ai:chatDiscardIfEmpty 가 와도 대화를 지우지 않게 한다.
  const sendingChats = new Set<number>()

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

  // 빈 화면 추천 질문 8개. 읽기 전용 커넥션만 쓰고 네트워크는 부르지 않는다 (AI_GUARDRAILS.md 6.1절)
  ipcMain.handle('ai:suggestions', (_event, variant?: unknown): AiSuggestion[] => {
    const v = normalizeSuggestionVariant(variant)
    try {
      return buildAiSuggestions(getAiReadOnlyDatabase(), { now: new Date(), variant: v })
    } catch (err) {
      console.warn('[ai:suggestions] 추천 질문 생성 실패, 일반 질문으로 대신함:', err)
      return fallbackSuggestions(v)
    }
  })

  ipcMain.handle('ai:chatCreate', () => {
    // 새 채팅의 기본 모드는 자동 쓰기다. 컬럼 DEFAULT 는 바꾸지 않아 기존 채팅 값은 그대로다.
    const result = db.prepare("INSERT INTO ai_chats (title, write_mode) VALUES ('새 대화', 'auto')").run()
    return { id: result.lastInsertRowid }
  })

  ipcMain.handle('ai:chatDelete', (_event, id: number) => {
    cancelAiQuery(id)
    db.prepare('DELETE FROM ai_chats WHERE id = ?').run(id)
    void removeChatAttachments(id)
    return { success: true }
  })

  // 메시지 없는 대화를 지운다. 렌더러가 빈 대화를 떠날 때 부른다.
  // 응답 생성 중이거나 전송 처리 중인 대화는 지우지 않는다.
  ipcMain.handle('ai:chatDiscardIfEmpty', (_event, id: unknown) => {
    const deleted = discardChatIfEmpty(
      db,
      id,
      (chatId) => isAiQueryRunning(chatId) || sendingChats.has(chatId)
    )
    if (deleted) void removeChatAttachments(id as number)
    return { deleted }
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

  ipcMain.handle(
    'ai:send',
    async (event, chatId: number, text: string, attachments?: AiAttachmentInput[]) => {
      const trimmed = (text ?? '').trim()
      const atts = Array.isArray(attachments) ? attachments : []
      if (!trimmed && atts.length === 0) return { started: false, error: '메시지가 비어 있습니다.' }
      if (trimmed.length > MAX_MESSAGE_LENGTH) {
        return {
          started: false,
          error: `메시지가 너무 깁니다. ${MAX_MESSAGE_LENGTH.toLocaleString()}자 이내로 입력해 주세요.`
        }
      }
      // 가드레일: 첨부 개수/크기/타입은 main에서 재검증한다
      const attachmentError = validateAttachments(atts)
      if (attachmentError) return { started: false, error: attachmentError }
      if (isAiQueryRunning(chatId)) return { started: false, error: '이미 응답을 생성 중입니다.' }
      if (!canStartAiQuery()) {
        return { started: false, error: '동시에 진행할 수 있는 대화 수를 초과했습니다. 잠시 후 다시 시도해 주세요.' }
      }

      const chat = db.prepare('SELECT id FROM ai_chats WHERE id = ?').get(chatId)
      if (!chat) return { started: false, error: '존재하지 않는 대화입니다.' }

      let saved: SavedAttachment[] = []
      if (atts.length > 0) {
        sendingChats.add(chatId)
        try {
          saved = await saveAttachments(chatId, atts)
        } catch {
          sendingChats.delete(chatId)
          return { started: false, error: '이미지 파일 저장에 실패했습니다.' }
        }
      }

      // meta에는 표시용 정보만 남긴다 (절대 경로는 renderer에 불필요)
      const meta =
        saved.length > 0
          ? JSON.stringify({
              attachments: saved.map(({ file, name, type }) => ({ file, name, type }))
            })
          : null
      try {
        db.prepare(
          "INSERT INTO ai_messages (chat_id, role, content, meta) VALUES (?, 'user', ?, ?)"
        ).run(chatId, trimmed, meta)
      } finally {
        sendingChats.delete(chatId)
      }

      // 첫 사용자 메시지면 대화 제목으로 자동 설정
      const userCount = (
        db
          .prepare("SELECT COUNT(*) AS c FROM ai_messages WHERE chat_id = ? AND role = 'user'")
          .get(chatId) as { c: number }
      ).c
      if (userCount === 1) {
        const base = trimmed || '(이미지 첨부)'
        const autoTitle = base.length > 30 ? `${base.slice(0, 30)}…` : base
        db.prepare('UPDATE ai_chats SET title = ? WHERE id = ?').run(autoTitle, chatId)
      }
      db.prepare("UPDATE ai_chats SET updated_at = datetime('now', 'localtime') WHERE id = ?").run(
        chatId
      )

      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return { started: false, error: '윈도우를 찾을 수 없습니다.' }

      // 첨부 이미지는 저장 경로를 프롬프트에 명시해 AI가 Read 도구로 읽게 한다
      // (Read는 첨부 디렉토리 안의 파일만 허용 — ai-agent.ts canUseTool)
      let prompt = trimmed
      if (saved.length > 0) {
        const fileList = saved.map((s) => `- ${s.name}: ${s.path}`).join('\n')
        prompt = `${trimmed ? `${trimmed}\n\n` : ''}[첨부 이미지]\n${fileList}\n(위 이미지 파일을 Read 도구로 읽어 내용을 확인한 뒤 답하세요)`
      }

      void runAiQuery(chatId, prompt, win)
      return { started: true }
    }
  )

  ipcMain.handle('ai:cancel', (_event, chatId: number) => {
    return { success: cancelAiQuery(chatId) }
  })

  // 쓰기 도구·웹 읽기·계획 승인 카드의 승인/거절 응답 (가드레일: HITL)
  // options.mode 는 계획 승인 뒤 실행 모드다. 허용 값은 auto, ask 이고 그 외는 무시한다.
  ipcMain.handle(
    'ai:approve',
    (_event, requestId: string, approved: boolean, options?: unknown) => {
      if (typeof requestId !== 'string') return { success: false }
      const rawMode = (options as { mode?: unknown } | null | undefined)?.mode
      const approvalOptions: AiApprovalOptions =
        rawMode === 'auto' || rawMode === 'ask' ? { mode: rawMode } : {}
      return { success: resolveAiApproval(requestId, approved === true, approvalOptions) }
    }
  )

  // 채팅별 데이터 작성 모드 변경 (조회는 ai:chatList의 write_mode 컬럼으로)
  ipcMain.handle('ai:setChatWriteMode', (_event, chatId: number, mode: AiWriteMode) => {
    if (typeof chatId !== 'number' || !AI_WRITE_MODES.includes(mode)) {
      return { success: false }
    }
    return { success: setChatWriteMode(chatId, mode) }
  })

  // AI 대화 모델 (앱 전역 설정 — 진행 중인 쿼리에는 영향 없고 다음 쿼리부터 적용)
  ipcMain.handle('ai:getModel', () => {
    return getAiChatModel()
  })

  ipcMain.handle('ai:setModel', (_event, model: unknown) => {
    if (!isAiChatModelChoice(model)) {
      return { success: false, model: getAiChatModel() }
    }
    setAiChatModel(model)
    return { success: true, model }
  })

  // 모델 선택지와 표시 라벨. 라벨 캐시가 비면 CLI 탐침을 1회 띄운다 (최대 20초).
  ipcMain.handle('ai:getModelOptions', () => {
    return getAiChatModelOptions()
  })

  ipcMain.handle('ai:progress', (_event, chatId: number) => {
    return getAiProgress(chatId)
  })

  // ── Notion 연동 (AI 조회 도구 get_notion_page 용) ──

  ipcMain.handle('ai:notionStatus', () => {
    return { connected: isNotionConnected() }
  })

  // 토큰을 Notion API로 검증한 뒤 저장 (safeStorage 암호화 — services/notion.ts)
  ipcMain.handle('ai:notionSaveToken', async (_event, token: string) => {
    if (typeof token !== 'string' || !token.trim()) {
      return { success: false, error: '토큰을 입력해 주세요.' }
    }
    try {
      const { workspace } = await saveNotionToken(token)
      return { success: true, workspace }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        error: /401|유효하지/.test(message)
          ? '토큰이 유효하지 않습니다. Notion 통합(integration)의 Internal Integration Secret을 확인해 주세요.'
          : message
      }
    }
  })

  ipcMain.handle('ai:notionDisconnect', () => {
    disconnectNotion()
    return { success: true }
  })

  // ── Bitbucket 연동 (AI 조회 도구 read_bitbucket 용) ──

  ipcMain.handle('ai:bitbucketStatus', () => {
    return { connected: isBitbucketConnected(), email: getBitbucketEmail(), workspace: getBitbucketWorkspace() }
  })

  // 나에게 온 요청이 리뷰 요청을 찾을 워크스페이스(docs/ASSISTANT.md §11.6). 빈 값이면 지운다
  ipcMain.handle('ai:bitbucketSetWorkspace', (_event, workspace: unknown) => {
    if (typeof workspace === 'string' && workspace.length > 200) {
      return { success: false, error: '워크스페이스 이름이 너무 깁니다.' }
    }
    try {
      const saved = setBitbucketWorkspace(workspace)
      // 다음 오늘 화면 갱신이 자동 동기화 간격과 무관하게 리뷰 요청을 다시 읽게 한다
      markRequestInboxStale()
      return { success: true, workspace: saved }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 이메일과 API token 을 Bitbucket API 로 검증한 뒤 저장한다 (services/bitbucket.ts)
  ipcMain.handle('ai:bitbucketSaveToken', async (_event, email: unknown, token: unknown) => {
    const trimmedEmail = typeof email === 'string' ? email.trim() : ''
    const trimmedToken = typeof token === 'string' ? token.trim() : ''
    if (!trimmedEmail) return { success: false, error: 'Atlassian 계정 이메일을 입력해 주세요.' }
    if (!trimmedToken) return { success: false, error: 'API token을 입력해 주세요.' }
    if (trimmedEmail.length > MAX_BITBUCKET_EMAIL_LENGTH) {
      return { success: false, error: '이메일이 너무 깁니다.' }
    }
    if (trimmedToken.length > MAX_BITBUCKET_TOKEN_LENGTH) {
      return { success: false, error: 'API token이 너무 깁니다.' }
    }
    try {
      const { account } = await saveBitbucketCredentials(trimmedEmail, trimmedToken)
      return { success: true, account }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('ai:bitbucketDisconnect', () => {
    disconnectBitbucket()
    return { success: true }
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
