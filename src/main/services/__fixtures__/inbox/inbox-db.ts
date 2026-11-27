import { DatabaseSync } from 'node:sqlite'
import type Database from 'better-sqlite3'
import { REQUEST_INBOX_SCHEMA } from '../../../db/schema'

// 나에게 온 요청 테이블과 할 일 테이블(할 일로 바꾸기)만 가진 인메모리 DB.
// better-sqlite3 는 Electron ABI 로 빌드돼 vitest 의 Node 에서 못 읽는다. node:sqlite 로 쓰는 만큼만 흉내 낸다.
export function memoryInboxDb(): Database.Database {
  const raw = new DatabaseSync(':memory:')
  raw.exec(REQUEST_INBOX_SCHEMA)
  raw.exec(`
    CREATE TABLE todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'medium',
      due_date TEXT, due_reminder INTEGER NOT NULL DEFAULT 0, is_completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT, notes TEXT, source_link TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE todo_tag_map (todo_id INTEGER NOT NULL, tag_id INTEGER NOT NULL);
    CREATE TABLE todo_history (id INTEGER PRIMARY KEY AUTOINCREMENT, todo_id INTEGER, action TEXT, snapshot TEXT);
  `)
  const shim = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction:
      <T>(fn: () => T) =>
      (): T => {
        raw.exec('BEGIN')
        try {
          const out = fn()
          raw.exec('COMMIT')
          return out
        } catch (err) {
          raw.exec('ROLLBACK')
          throw err
        }
      }
  }
  return shim as unknown as Database.Database
}
