import { DatabaseSync } from 'node:sqlite'
import type Database from 'better-sqlite3'
import { JIRA_BOARD_SCHEMA } from '../../../db/schema'

// 프로젝트 보드 캐시 테이블만 가진 인메모리 DB.
// better-sqlite3 는 Electron ABI 로 빌드돼 vitest 의 Node 에서 못 읽는다. node:sqlite 로 쓰는 만큼만 흉내 낸다.
export function memoryBoardDb(): Database.Database {
  const raw = new DatabaseSync(':memory:')
  raw.exec(JIRA_BOARD_SCHEMA)
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
