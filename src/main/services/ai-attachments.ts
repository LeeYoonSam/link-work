import { app } from 'electron'
import { mkdirSync, existsSync } from 'fs'
import { readdir, unlink, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'

// AI 대화 이미지 첨부 저장소 (userData/ai-attachments).
//
// [가드레일]
// - 허용 타입/크기/개수를 main에서 다시 검증한다 (renderer 검증은 UX용일 뿐).
// - 파일명은 main이 생성한다 (사용자 파일명은 meta에만 기록 — 경로 조작 차단).
// - AI의 Read 도구는 이 디렉토리 안의 파일만 허용된다 (ai-agent.ts canUseTool).

export const MAX_ATTACHMENTS_PER_MESSAGE = 4
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024 // 8MB (Claude 이미지 입력 상한 이내)

// Claude 비전이 지원하는 이미지 타입만 허용
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

export interface AiAttachmentInput {
  name: string
  type: string
  bytes: ArrayBuffer
}

export interface SavedAttachment {
  file: string // 저장 파일명 (linkwork-media://attachment/<file> 로 표시)
  path: string // 절대 경로 (AI Read 도구용)
  name: string // 원본 파일명 (표시용)
  type: string
}

export function aiAttachmentsDir(): string {
  return join(app.getPath('userData'), 'ai-attachments')
}

// Read 도구 게이트: 요청 경로가 첨부 디렉토리 안의 파일인지 검사
export function isPathInAttachmentsDir(filePath: string): boolean {
  const dir = resolve(aiAttachmentsDir())
  const target = resolve(filePath)
  return target.startsWith(dir + sep)
}

export function validateAttachments(attachments: AiAttachmentInput[]): string | null {
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return `이미지는 한 번에 최대 ${MAX_ATTACHMENTS_PER_MESSAGE}장까지 첨부할 수 있습니다.`
  }
  for (const att of attachments) {
    if (!MIME_EXTENSIONS[att.type]) {
      return `지원하지 않는 이미지 형식입니다: ${att.type} (PNG/JPEG/WebP/GIF만 가능)`
    }
    if (att.bytes.byteLength === 0) return '비어 있는 이미지 파일입니다.'
    if (att.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return `이미지가 너무 큽니다 (최대 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB): ${att.name}`
    }
  }
  return null
}

export async function saveAttachments(
  chatId: number,
  attachments: AiAttachmentInput[]
): Promise<SavedAttachment[]> {
  const dir = aiAttachmentsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const saved: SavedAttachment[] = []
  const stamp = Date.now()
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]
    const ext = MIME_EXTENSIONS[att.type]
    const file = `${chatId}-${stamp}-${i}.${ext}`
    const path = join(dir, file)
    await writeFile(path, Buffer.from(att.bytes))
    saved.push({ file, path, name: att.name, type: att.type })
  }
  return saved
}

// 채팅 삭제 시 해당 채팅의 첨부 파일 정리 (파일명 접두어 = "<chatId>-")
export async function removeChatAttachments(chatId: number): Promise<void> {
  const dir = aiAttachmentsDir()
  if (!existsSync(dir)) return
  try {
    const files = await readdir(dir)
    const prefix = `${chatId}-`
    await Promise.all(
      files.filter((f) => f.startsWith(prefix)).map((f) => unlink(join(dir, f)).catch(() => {}))
    )
  } catch {
    // 정리 실패는 치명적이지 않다 (고아 파일이 남을 뿐)
  }
}
