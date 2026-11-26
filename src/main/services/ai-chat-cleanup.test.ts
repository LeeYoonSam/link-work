import { beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3 → node:sqlite 교체. 이유는 assistant-store.test.ts 상단 주석과 같다.
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  class BetterSqlite3Shim {
    private readonly db: InstanceType<typeof DatabaseSync>
    constructor() {
      this.db = new DatabaseSync(':memory:')
    }
    exec(sql: string): void {
      this.db.exec(sql)
    }
    prepare(sql: string): unknown {
      return this.db.prepare(sql)
    }
  }
  return { default: BetterSqlite3Shim }
})

import Database from 'better-sqlite3'
import { discardChatIfEmpty, isValidChatId, purgeEmptyChats } from './ai-chat-cleanup'

// schema.ts 의 ai_chats·ai_messages 정의를 옮겼다.
const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE ai_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '새 대화',
    session_id TEXT,
    write_mode TEXT NOT NULL DEFAULT 'ask',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE TABLE ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    meta TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (chat_id) REFERENCES ai_chats(id) ON DELETE CASCADE
  );
`

let db: Database.Database

function createChat(): number {
  return Number(db.prepare("INSERT INTO ai_chats (title) VALUES ('새 대화')").run().lastInsertRowid)
}
function addMessage(chatId: number): void {
  db.prepare("INSERT INTO ai_messages (chat_id, role, content) VALUES (?, 'user', '안녕')").run(chatId)
}
function chatIds(): number[] {
  return (db.prepare('SELECT id FROM ai_chats ORDER BY id').all() as { id: number }[]).map((r) =>
    Number(r.id)
  )
}
const notBusy = (): boolean => false

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(SCHEMA)
})

describe('discardChatIfEmpty', () => {
  it('메시지가 없는 대화를 지운다', () => {
    const id = createChat()
    expect(discardChatIfEmpty(db, id, notBusy)).toBe(true)
    expect(chatIds()).toEqual([])
  })

  it('메시지가 있는 대화는 남긴다', () => {
    const id = createChat()
    addMessage(id)
    expect(discardChatIfEmpty(db, id, notBusy)).toBe(false)
    expect(chatIds()).toEqual([id])
  })

  it('응답 생성 중인 대화는 메시지가 없어도 남긴다', () => {
    const id = createChat()
    const isBusy = vi.fn((chatId: number) => chatId === id)
    expect(discardChatIfEmpty(db, id, isBusy)).toBe(false)
    expect(isBusy).toHaveBeenCalledWith(id)
    expect(chatIds()).toEqual([id])
  })

  it('다른 대화는 건드리지 않는다', () => {
    const a = createChat()
    const b = createChat()
    expect(discardChatIfEmpty(db, a, notBusy)).toBe(true)
    expect(chatIds()).toEqual([b])
  })

  it('잘못된 id 는 아무것도 지우지 않는다', () => {
    const id = createChat()
    for (const bad of [0, -1, 1.5, NaN, '1', null, undefined, {}]) {
      expect(discardChatIfEmpty(db, bad, notBusy)).toBe(false)
    }
    expect(chatIds()).toEqual([id])
  })

  it('없는 대화면 false', () => {
    expect(discardChatIfEmpty(db, 999, notBusy)).toBe(false)
  })
})

describe('isValidChatId', () => {
  it('양의 정수만 받는다', () => {
    expect(isValidChatId(3)).toBe(true)
    expect(isValidChatId(0)).toBe(false)
    expect(isValidChatId(2.5)).toBe(false)
    expect(isValidChatId('3')).toBe(false)
  })
})

describe('purgeEmptyChats', () => {
  it('메시지 없는 대화만 지우고 지운 id 를 돌려준다', () => {
    const empty1 = createChat()
    const kept = createChat()
    addMessage(kept)
    const empty2 = createChat()
    expect(purgeEmptyChats(db).sort((x, y) => x - y)).toEqual([empty1, empty2])
    expect(chatIds()).toEqual([kept])
    expect((db.prepare('SELECT COUNT(*) AS c FROM ai_messages').get() as { c: number }).c).toBe(1)
  })

  it('빈 대화가 없으면 빈 배열', () => {
    addMessage(createChat())
    expect(purgeEmptyChats(db)).toEqual([])
  })
})
