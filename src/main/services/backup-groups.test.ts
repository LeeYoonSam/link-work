import { describe, expect, it, vi } from 'vitest'

// better-sqlite3는 Electron ABI로 빌드돼 vitest(Node)에서 로드할 수 없다. node:sqlite로 갈아끼운다.
// applySchema 가 쓰는 범위(exec·prepare·pragma)만 흉내 낸다.
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  class BetterSqlite3Shim {
    private readonly db: InstanceType<typeof DatabaseSync>
    constructor(path: string) {
      this.db = new DatabaseSync(path)
    }
    pragma(statement: string): void {
      this.db.exec(`PRAGMA ${statement}`)
    }
    exec(sql: string): void {
      this.db.exec(sql)
    }
    prepare(sql: string): unknown {
      return this.db.prepare(sql)
    }
    close(): void {
      this.db.close()
    }
  }
  return { default: BetterSqlite3Shim }
})

import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import {
  BACKUP_GROUP_IDS,
  CREDENTIAL_BUNDLES,
  CROSS_GROUP_REFS,
  GROUP_TABLES,
  NON_GROUP_TABLES,
  SECRET_SETTING_KEYS,
  classifySettingKey,
  groupOfTable,
  isBackupGroupId,
  normalizeGroups
} from './backup-groups'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  applySchema(db)
  return db
}

function userTables(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((r) => r.name)
}

describe('backup-groups', () => {
  it('G1 sqlite_master 의 모든 테이블이 정확히 한 그룹 또는 백업 제외에 속한다', () => {
    const db = freshDb()
    const tables = userTables(db)
    expect(tables.length).toBeGreaterThan(20)
    for (const t of tables) {
      const owners = BACKUP_GROUP_IDS.filter((g) => GROUP_TABLES[g].includes(t))
      const nonGroup = NON_GROUP_TABLES.includes(t) ? 1 : 0
      expect({ table: t, count: owners.length + nonGroup }).toEqual({ table: t, count: 1 })
    }
    // 반대 방향: 그룹에 적힌 테이블이 실제로 존재한다(오타 방지)
    const declared = [...BACKUP_GROUP_IDS.flatMap((g) => GROUP_TABLES[g]), ...NON_GROUP_TABLES]
    for (const t of declared) expect(tables).toContain(t)
    expect(new Set(declared).size).toBe(declared.length)
    db.close()
  })

  it('G2 그룹을 넘는 선언된 FOREIGN KEY 는 모두 CROSS_GROUP_REFS 에 있다', () => {
    const db = freshDb()
    const crossing: string[] = []
    for (const t of userTables(db)) {
      const fks = db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as {
        table: string
        from: string
      }[]
      for (const fk of fks) {
        const childGroup = groupOfTable(t)
        const parentGroup = groupOfTable(fk.table)
        // 백업 제외 테이블은 FK 를 갖거나 받지 않는다
        expect(childGroup, `${t} 는 그룹이 있어야 FK 를 가질 수 있다`).not.toBeNull()
        expect(parentGroup, `${fk.table} 는 그룹이 있어야 FK 를 받을 수 있다`).not.toBeNull()
        if (childGroup !== parentGroup) crossing.push(`${t}.${fk.from}->${fk.table}`)
      }
    }
    expect(crossing.length).toBeGreaterThan(0)
    const declared = CROSS_GROUP_REFS.filter((r) => r.kind === 'fk').map(
      (r) => `${r.childTable}.${r.childColumn}->${r.parentTable}`
    )
    for (const c of crossing) expect(declared).toContain(c)
    // 선언된 fk 참조도 실제 FK 와 일치한다
    for (const d of declared) expect(crossing).toContain(d)
    // 그룹 정보가 실제 테이블 그룹과 맞다
    for (const r of CROSS_GROUP_REFS) {
      expect(groupOfTable(r.childTable)).toBe(r.childGroup)
      expect(groupOfTable(r.parentTable)).toBe(r.parentGroup)
    }
    db.close()
  })

  it('G3 설정 키 분류: 시크릿 4개는 secret, project_sync_created_keys 는 work, assistant_* 와 미지의 키는 settings', () => {
    expect(SECRET_SETTING_KEYS).toHaveLength(4)
    for (const k of ['notion_token', 'jira_api_token', 'google_client_secret', 'bitbucket_api_token']) {
      expect(classifySettingKey(k)).toBe('secret')
    }
    expect(classifySettingKey('project_sync_created_keys')).toBe('work')
    for (const k of [
      'assistant_enabled',
      'assistant_morning_sync_time',
      'ai_model',
      'ai_model_labels',
      'google_client_id',
      'jira_site_url',
      'jira_email',
      'jira_token_expires_at',
      'jira_account_name',
      'bitbucket_email',
      'some_future_unknown_key'
    ]) {
      expect(classifySettingKey(k)).toBe('settings')
    }
    // 연동 묶음의 자격 키 중 시크릿은 SECRET_SETTING_KEYS 와 일치한다
    const bundleSecrets = CREDENTIAL_BUNDLES.flatMap((b) => b.credentialKeys).filter(
      (k) => classifySettingKey(k) === 'secret'
    )
    expect([...bundleSecrets].sort()).toEqual([...SECRET_SETTING_KEYS].sort())
  })

  it('G4 normalizeGroups: 중복·순서·빈 배열·모르는 id', () => {
    expect(normalizeGroups(['settings', 'work', 'work', 'ai'])).toEqual(['work', 'ai', 'settings'])
    expect(normalizeGroups(['library'])).toEqual(['library'])
    expect(normalizeGroups([...BACKUP_GROUP_IDS].reverse())).toEqual([...BACKUP_GROUP_IDS])
    expect(normalizeGroups([])).toBeNull()
    expect(normalizeGroups(['work', 'nope'])).toBeNull()
    expect(normalizeGroups(['work', 1])).toBeNull()
    expect(normalizeGroups('work')).toBeNull()
    expect(normalizeGroups(undefined)).toBeNull()
    expect(normalizeGroups(null)).toBeNull()
    expect(isBackupGroupId('meetings')).toBe(true)
    expect(isBackupGroupId('Meetings')).toBe(false)
  })
})
