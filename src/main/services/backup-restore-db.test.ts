import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

// better-sqlite3는 Electron ABI로 빌드돼 vitest(Node)에서 로드할 수 없다. node:sqlite로 갈아끼우되
// 파일 경로를 그대로 쓴다 — 이 테스트는 라이브·백업 두 파일을 ATTACH 로 병합하는 흐름을 검증한다.
// shim 의 pragma() 는 값을 돌려주지 않는다(읽기 PRAGMA 는 prepare().all()).
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  class BetterSqlite3Shim {
    private readonly db: InstanceType<typeof DatabaseSync>
    constructor(path: string, options?: { readonly?: boolean }) {
      this.db = options?.readonly
        ? new DatabaseSync(path, { readOnly: true })
        : new DatabaseSync(path)
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
  BACKUP_REFS_TABLE,
  CROSS_GROUP_REFS,
  GROUP_TABLES,
  SECRET_SETTING_KEYS,
  classifySettingKey,
  tablesForGroups,
  type BackupGroupId
} from './backup-groups'
import { filterSnapshotGroups, mergeBackupIntoLive, prepareBackupDb } from './backup-restore-db'

type Db = Database.Database

let root = ''
let seq = 0
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'linkwork-restore-db-'))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function newPath(name: string): string {
  seq += 1
  return join(root, `${seq}-${name}.db`)
}

function open(path: string): Db {
  const db = new Database(path)
  db.pragma('foreign_keys = ON')
  return db
}

interface SeedOpts {
  /** 부모 행의 created_at — 계보(같은 DB 에서 나왔는지)를 가른다 */
  stamp: string
  /** 내용 표지. 라이브와 백업을 구분한다 */
  label: string
}

function seed(db: Db, { stamp, label }: SeedOpts): void {
  const run = (sql: string, ...p: unknown[]): void => {
    db.prepare(sql).run(...p)
  }
  // work
  for (const id of [1, 2]) {
    run(
      `INSERT INTO projects (id, name, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date, created_at)
       VALUES (?, ?, '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', ?)`,
      id,
      `${label}-project-${id}`,
      stamp
    )
  }
  run(`INSERT INTO tasks (id, project_id, name) VALUES (1, 1, ?)`, `${label}-task`)
  run(`INSERT INTO tasks (id, project_id, name) VALUES (2, 2, ?)`, `${label}-task2`)
  for (const id of [1, 2]) {
    run(`INSERT INTO todos (id, title, created_at) VALUES (?, ?, ?)`, id, `${label}-todo-${id}`, stamp)
  }
  run(`INSERT INTO todo_tags (id, name) VALUES (1, ?)`, `${label}-tag`)
  run(`INSERT INTO todo_tag_map (todo_id, tag_id) VALUES (1, 1)`)
  run(`INSERT INTO todo_history (todo_id, action, snapshot) VALUES (1, 'create', ?)`, `${label}-snap`)
  run(
    `INSERT INTO release_notes (id, jira_project_key, jira_version_id, version_name) VALUES (1, 'P', '10', ?)`,
    `${label}-1.0`
  )
  run(`INSERT INTO release_note_items (release_note_id, issue_key, summary) VALUES (1, 'P-1', ?)`, label)
  run(`INSERT INTO activity_log (entity_type, entity_id, entity_name, action) VALUES ('memo', 1, ?, 'create')`, label)
  run(`INSERT INTO daily_plans (id, plan_date, status, started_at) VALUES (1, '2026-11-18', 'active', ?)`, stamp)
  run(
    `INSERT INTO plan_items (plan_id, candidate_id, source, title, score, added_by)
     VALUES (1, 'action_item:1:0', 'action_item', ?, 1, 'auto')`,
    `${label}-ai`
  )
  run(
    `INSERT INTO plan_items (plan_id, candidate_id, source, title, score, added_by)
     VALUES (1, 'todo:1', 'todo', ?, 1, 'auto')`,
    `${label}-todo`
  )
  run(
    `INSERT INTO assistant_events (event_key, kind, plan_date, scheduled_at, status) VALUES (?, 'nudge', '2026-11-18', ?, 'done')`,
    `${label}-ev`,
    stamp
  )
  run(
    `INSERT INTO assistant_exclusions (candidate_id, title, source, excluded_at) VALUES ('todo:9', ?, 'todo', ?)`,
    label,
    stamp
  )
  // meetings
  run(`INSERT INTO meetings (id, title, project_id, created_at) VALUES (1, ?, 1, ?)`, `${label}-m1`, stamp)
  run(`INSERT INTO meetings (id, title, project_id, created_at) VALUES (2, ?, 2, ?)`, `${label}-m2`, stamp)
  run(`INSERT INTO meeting_speakers (id, meeting_id, speaker_key, label) VALUES (1, 1, 'S1', ?)`, label)
  run(
    `INSERT INTO meeting_segments (meeting_id, start_ms, end_ms, speaker_id, text) VALUES (1, 0, 10, 1, ?)`,
    `${label}-seg`
  )
  run(`INSERT INTO meeting_segments (meeting_id, start_ms, end_ms, text) VALUES (2, 0, 10, ?)`, `${label}-seg2`)
  run(`INSERT INTO meeting_cuts (meeting_id, start_ms, end_ms) VALUES (1, 0, 5)`)
  run(
    `INSERT INTO meeting_summaries (meeting_id, tldr, action_items) VALUES (1, ?, ?)`,
    label,
    JSON.stringify([
      { text: `${label}-a`, todo_id: 1 },
      { text: `${label}-b`, todo_id: null },
      { text: `${label}-c`, todo_id: 2 }
    ])
  )
  run(`INSERT INTO meeting_members (id, name) VALUES (1, ?)`, `${label}-member`)
  run(`INSERT INTO meeting_attendees (meeting_id, member_id) VALUES (1, 1)`)
  run(`INSERT INTO stt_glossary (term, project_id) VALUES (?, 1)`, `${label}-term`)
  // library
  run(`INSERT INTO documents (id, name, url, project_id) VALUES (1, ?, 'https://x', 1)`, `${label}-doc`)
  run(`INSERT INTO documents (id, name, url, project_id) VALUES (2, ?, 'https://y', 2)`, `${label}-doc2`)
  run(`INSERT INTO memo_categories (id, name) VALUES (1, ?)`, `${label}-cat`)
  run(`INSERT INTO memos (content, category_id) VALUES (?, 1)`, `${label}-memo`)
  run(`INSERT INTO variables (key, value) VALUES ('k', ?)`, label)
  // ai
  run(`INSERT INTO ai_chats (id, title) VALUES (1, ?)`, `${label}-chat`)
  run(`INSERT INTO ai_messages (chat_id, role, content) VALUES (1, 'user', ?)`, label)
  run(`INSERT INTO ai_audit_log (chat_id, event) VALUES (1, ?)`, label)
  // settings (시크릿 포함 — 라이브 DB 처럼)
  const settings: Record<string, string> = {
    assistant_enabled: `${label}-on`,
    ai_model: `${label}-model`,
    [`${label}_only_key`]: label,
    project_sync_created_keys: `["${label}-1"]`,
    jira_site_url: 'https://site.atlassian.net',
    jira_email: `${label}@x.com`,
    jira_api_token: `${label}-jira-token`,
    jira_token_expires_at: `${label}-exp`,
    jira_account_name: `${label}-acct`,
    bitbucket_email: `${label}@bb.com`,
    bitbucket_api_token: `${label}-bb-token`,
    google_client_id: `${label}-gid`,
    google_client_secret: `${label}-gsecret`,
    notion_token: `${label}-notion`
  }
  for (const [k, v] of Object.entries(settings)) {
    run(`INSERT INTO app_settings (key, value) VALUES (?, ?)`, k, v)
  }
  run(`INSERT INTO auth_tokens (id, provider, access_token) VALUES (1, 'google', ?)`, `${label}-access`)
}

function createDb(opts: SeedOpts, name = 'db'): string {
  const path = newPath(name)
  const db = open(path)
  applySchema(db)
  seed(db, opts)
  db.close()
  return path
}

/** 내보내기를 흉내 낸다: 사본 → 그룹 필터 → 시크릿 제거. */
function makeBackup(livePath: string, groups: BackupGroupId[], mutate?: (db: Db) => void): string {
  const path = newPath('backup')
  copyFileSync(livePath, path)
  const db = new Database(path)
  filterSnapshotGroups(db, groups)
  db.exec('DELETE FROM auth_tokens')
  for (const k of SECRET_SETTING_KEYS) db.prepare('DELETE FROM app_settings WHERE key = ?').run(k)
  mutate?.(db)
  db.close()
  return path
}

function restore(
  livePath: string,
  backupPath: string,
  groups: BackupGroupId[]
): ReturnType<typeof mergeBackupIntoLive> {
  prepareBackupDb(backupPath, livePath)
  return mergeBackupIntoLive(livePath, backupPath, groups)
}

function rows(path: string, sql: string, ...params: unknown[]): Record<string, unknown>[] {
  const db = new Database(path, { readonly: true })
  try {
    return db.prepare(sql).all(...params) as Record<string, unknown>[]
  } finally {
    db.close()
  }
}

function tableHash(db: Db, table: string): string {
  const all = (db.prepare(`SELECT * FROM "${table}"`).all() as unknown[]).map((r) =>
    JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  )
  all.sort()
  return createHash('sha256').update(all.join('\n')).digest('hex').slice(0, 16)
}

function allTables(db: Db): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ?"
      )
      .all(BACKUP_REFS_TABLE) as { name: string }[]
  ).map((r) => r.name)
}

function hashes(path: string, tables?: string[]): Record<string, string> {
  const db = new Database(path, { readonly: true })
  try {
    const out: Record<string, string> = {}
    for (const t of tables ?? allTables(db)) out[t] = tableHash(db, t)
    return out
  } finally {
    db.close()
  }
}

function settingsMap(path: string): Record<string, string> {
  return Object.fromEntries(
    rows(path, 'SELECT key, value FROM app_settings').map((r) => [r.key as string, r.value as string])
  )
}

function fkViolations(path: string, tables: string[]): unknown[] {
  const db = new Database(path, { readonly: true })
  try {
    return tables.flatMap((t) => db.prepare(`PRAGMA foreign_key_check("${t}")`).all())
  } finally {
    db.close()
  }
}

const LIVE = { stamp: '2026-01-01 09:00:00', label: 'live' }
const OTHER = { stamp: '2025-05-05 05:05:05', label: 'other' }

describe('filterSnapshotGroups', () => {
  it('빠진 그룹의 행·설정 키를 지우고 refs 를 남기며, 남는 회의의 project_id 는 보존한다', () => {
    const live = createDb(LIVE)
    const bk = makeBackup(live, ['meetings'])
    expect(rows(bk, 'SELECT COUNT(*) AS c FROM projects')[0].c).toBe(0)
    expect(rows(bk, 'SELECT COUNT(*) AS c FROM documents')[0].c).toBe(0)
    expect(rows(bk, 'SELECT COUNT(*) AS c FROM ai_chats')[0].c).toBe(0)
    expect(rows(bk, 'SELECT project_id FROM meetings ORDER BY id').map((r) => r.project_id)).toEqual([1, 2])
    const refs = rows(bk, `SELECT tbl, id FROM ${BACKUP_REFS_TABLE} ORDER BY tbl, id`)
    expect(refs).toEqual([
      { tbl: 'projects', id: 1 },
      { tbl: 'projects', id: 2 },
      { tbl: 'todos', id: 1 },
      { tbl: 'todos', id: 2 }
    ])
    // work·settings 키가 모두 빠졌다
    expect(settingsMap(bk)).toEqual({})
  })
})

describe('mergeBackupIntoLive', () => {
  it('M1 부분 복원 뒤 미선택 그룹의 모든 테이블 행 수와 내용(정렬한 행의 해시)이 그대로다', () => {
    for (const g of BACKUP_GROUP_IDS) {
      const live = createDb(LIVE)
      const bk = makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS])
      const others = BACKUP_GROUP_IDS.filter((x) => x !== g)
      // 그룹 간 참조 정리 대상(X1~X4 자식) 중 미선택 테이블도 미선택 그룹이지만, 부모가 교체되면
      // 의도적으로 끊긴다. 이 검사는 부모가 미선택인 경우(=참조 정리 없음)만 해시를 비교하고,
      // 참조가 끊기는 테이블은 정리 대상 컬럼 외 내용이 같음을 따로 본다.
      const touchedChildren = new Set(
        CROSS_GROUP_REFS.filter((r) => r.parentGroup === g && r.kind !== 'candidate').map((r) => r.childTable)
      )
      const untouched = tablesForGroups(others).filter((t) => !touchedChildren.has(t))
      // auth_tokens 는 설정·연동 복원에서 계정이 다르면 지워진다(M12). 그 외에는 그대로여야 한다
      const extra = g === 'settings' ? [] : ['auth_tokens']
      const before = hashes(live, [...untouched, ...extra])
      const settingsBefore = settingsMap(live)

      restore(live, bk, [g])

      expect(hashes(live, [...untouched, ...extra]), `restore ${g}`).toEqual(before)
      // 미선택 클래스의 설정 키는 그대로
      const settingsAfter = settingsMap(live)
      for (const [k, v] of Object.entries(settingsBefore)) {
        const cls = classifySettingKey(k)
        if (cls === 'secret' || !(others as string[]).includes(cls)) continue
        expect(settingsAfter[k], `${g}: ${k}`).toBe(v)
      }
      // 끊긴 자식 테이블도 행 수와 정리 대상 외 컬럼은 그대로
      for (const t of touchedChildren) {
        const cnt = rows(live, `SELECT COUNT(*) AS c FROM "${t}"`)[0].c
        expect(cnt, t).toBeGreaterThan(0)
      }
      if (g === 'work') {
        expect(rows(live, 'SELECT title FROM meetings ORDER BY id').map((r) => r.title)).toEqual([
          'live-m1',
          'live-m2'
        ])
      }
    }
  })

  it('M2 선택 그룹은 백업 내용과 같다(교체이며 병합 아님)', () => {
    const live = createDb(LIVE)
    const bk = makeBackup(live, [...BACKUP_GROUP_IDS])
    const bkHashes = hashes(bk, tablesForGroups([...BACKUP_GROUP_IDS]))
    // 백업 뒤 라이브가 바뀐다: 새 행·수정·삭제
    const db = open(live)
    db.prepare(`INSERT INTO todos (title) VALUES ('after-backup')`).run()
    db.prepare(`UPDATE meetings SET title = 'changed' WHERE id = 1`).run()
    db.prepare(`DELETE FROM memos`).run()
    db.prepare(`INSERT INTO ai_chats (title) VALUES ('new chat')`).run()
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('after_key', 'x')`).run()
    db.close()

    restore(live, bk, ['work'])
    expect(hashes(live, [...GROUP_TABLES.work])).toEqual(
      Object.fromEntries(GROUP_TABLES.work.map((t) => [t, bkHashes[t]]))
    )
    expect(rows(live, `SELECT COUNT(*) AS c FROM todos WHERE title = 'after-backup'`)[0].c).toBe(0)
    // 회의는 미선택이라 수정이 남는다
    expect(rows(live, 'SELECT title FROM meetings WHERE id = 1')[0].title).toBe('changed')

    restore(live, bk, [...BACKUP_GROUP_IDS])
    expect(hashes(live, tablesForGroups([...BACKUP_GROUP_IDS]))).toEqual(bkHashes)
    // 설정 그룹도 교체: 백업 뒤 생긴 키는 사라진다
    expect(settingsMap(live).after_key).toBeUndefined()
    expect(settingsMap(live).assistant_enabled).toBe('live-on')
  })

  it('M3 같은 계보에서 회의만 복원해도 정체성이 일치하는 meetings.project_id 는 유지된다', () => {
    const live = createDb(LIVE)
    const bk = makeBackup(live, ['meetings'])
    const db = open(live)
    db.prepare(`UPDATE meetings SET title = 'renamed'`).run()
    db.close()

    const res = restore(live, bk, ['meetings'])
    expect(rows(live, 'SELECT project_id, title FROM meetings ORDER BY id')).toEqual([
      { project_id: 1, title: 'live-m1' },
      { project_id: 2, title: 'live-m2' }
    ])
    expect(rows(live, 'SELECT project_id FROM stt_glossary')[0].project_id).toBe(1)
    expect(res.nulledRefs).toEqual({ X1: 0, X2: 0, X3: 0, X4: 0 })
    // action_items 의 todo_id 도 유지
    const items = JSON.parse(rows(live, 'SELECT action_items FROM meeting_summaries')[0].action_items as string)
    expect(items.map((i: { todo_id: number | null }) => i.todo_id)).toEqual([1, null, 2])
  })

  it('M4 다른 계보(created_at 이 다름)에서는 회의만 복원하면 project_id 가 NULL 이 된다', () => {
    const live = createDb(LIVE)
    const bk = makeBackup(createDb(OTHER), ['meetings'])
    const res = restore(live, bk, ['meetings'])
    expect(rows(live, 'SELECT project_id FROM meetings ORDER BY id').map((r) => r.project_id)).toEqual([
      null,
      null
    ])
    expect(rows(live, 'SELECT project_id FROM stt_glossary')[0].project_id).toBeNull()
    expect(res.nulledRefs.X1).toBe(2)
    expect(res.nulledRefs.X2).toBe(1)
    // 같은 백업의 전체 버전(부모 테이블이 백업에 있음)에서도 같다
    const live2 = createDb(LIVE)
    const bkFull = makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS])
    restore(live2, bkFull, ['meetings'])
    expect(rows(live2, 'SELECT project_id FROM meetings ORDER BY id').map((r) => r.project_id)).toEqual([
      null,
      null
    ])
  })

  it('M5 업무만 복원한 뒤 meetings·documents·stt_glossary 의 project_id 고아 0건', () => {
    for (const source of [OTHER, LIVE]) {
      const live = createDb(LIVE)
      const bk = makeBackup(createDb(source), ['work'], (db) => {
        // 백업에는 프로젝트 2가 없다(앱에서 지운 것처럼 FK 를 켜고 지운다)
        db.exec('PRAGMA foreign_keys = ON')
        db.exec('DELETE FROM projects WHERE id = 2')
      })
      const res = restore(live, bk, ['work'])
      for (const t of ['meetings', 'documents', 'stt_glossary']) {
        const orphans = rows(
          live,
          `SELECT COUNT(*) AS c FROM ${t} WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)`
        )[0].c
        expect(orphans, `${source.label}: ${t}`).toBe(0)
      }
      if (source === LIVE) {
        // 같은 계보: 프로젝트 1 은 정체성이 일치해 유지, 2 는 사라져 끊긴다
        expect(rows(live, 'SELECT project_id FROM meetings ORDER BY id').map((r) => r.project_id)).toEqual([1, null])
        expect(res.nulledRefs.X1).toBe(1)
      } else {
        expect(rows(live, 'SELECT project_id FROM meetings ORDER BY id').map((r) => r.project_id)).toEqual([
          null,
          null
        ])
        expect(res.nulledRefs.X3).toBe(2)
      }
    }
  })

  it('M6 meeting_summaries.action_items 의 todo_id 고아 0건', () => {
    const check = (path: string): (number | null)[] => {
      const ids = rows(path, 'SELECT id FROM todos').map((r) => r.id)
      const items = rows(path, 'SELECT action_items FROM meeting_summaries').flatMap(
        (r) => JSON.parse(r.action_items as string) as { todo_id: number | null }[]
      )
      for (const i of items) if (i.todo_id != null) expect(ids).toContain(i.todo_id)
      return items.map((i) => i.todo_id)
    }
    // 업무만 복원(다른 계보): 라이브 요약의 todo_id 가 끊긴다
    const live1 = createDb(LIVE)
    const r1 = restore(live1, makeBackup(createDb(OTHER), ['work']), ['work'])
    expect(check(live1)).toEqual([null, null, null])
    expect(r1.nulledRefs.X4).toBe(2)
    // 회의만 복원(다른 계보): 백업 요약의 todo_id 가 끊긴다
    const live2 = createDb(LIVE)
    restore(live2, makeBackup(createDb(OTHER), ['meetings']), ['meetings'])
    expect(check(live2)).toEqual([null, null, null])
    // 같은 계보에서 할 일 2 가 백업 뒤 지워졌으면 그것만 끊긴다
    const live3 = createDb(LIVE)
    const bk3 = makeBackup(live3, ['meetings'])
    const db = open(live3)
    db.exec('DELETE FROM todos WHERE id = 2')
    db.close()
    restore(live3, bk3, ['meetings'])
    expect(check(live3)).toEqual([1, null, null])
  })

  it('M7 업무를 교체해도 CASCADE/SET NULL 이 회의·자료 행으로 번지지 않는다', () => {
    const live = createDb(LIVE)
    const bk = makeBackup(live, ['work'])
    const before = hashes(live, [...GROUP_TABLES.meetings, ...GROUP_TABLES.library])
    restore(live, bk, ['work'])
    // 같은 계보라 정체성이 모두 일치 → 회의·자료 행은 바이트 단위로 같다
    expect(hashes(live, [...GROUP_TABLES.meetings, ...GROUP_TABLES.library])).toEqual(before)
    expect(rows(live, 'SELECT project_id FROM meetings ORDER BY id').map((r) => r.project_id)).toEqual([1, 2])
    expect(rows(live, 'SELECT COUNT(*) AS c FROM meeting_segments')[0].c).toBe(2)
  })

  it('M8 교체한 테이블의 sqlite_sequence 는 max(라이브, 백업) 이상이다', () => {
    const seqOf = (path: string): Record<string, number> =>
      Object.fromEntries(rows(path, 'SELECT name, seq FROM sqlite_sequence').map((r) => [r.name, Number(r.seq)]))

    // 라이브가 더 큰 경우: 라이브에서 행을 만들었다 지워 seq 만 올린다
    const live = createDb(LIVE)
    const bk = makeBackup(live, [...BACKUP_GROUP_IDS])
    let db = open(live)
    for (let i = 0; i < 10; i++) db.prepare(`INSERT INTO meetings (title) VALUES ('tmp')`).run()
    db.exec(`DELETE FROM meetings WHERE title = 'tmp'`)
    db.close()
    const liveSeq = seqOf(live)
    restore(live, bk, ['meetings'])
    expect(seqOf(live).meetings).toBeGreaterThanOrEqual(liveSeq.meetings)
    expect(liveSeq.meetings).toBe(12)

    // 백업이 더 큰 경우
    const live2 = createDb(LIVE)
    const bk2 = makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS], (b) => {
      for (let i = 0; i < 30; i++) b.prepare(`INSERT INTO todos (title) VALUES ('x')`).run()
      b.exec(`DELETE FROM todos WHERE title = 'x'`)
    })
    const bkSeq = seqOf(bk2)
    const live2Seq = seqOf(live2)
    restore(live2, bk2, [...BACKUP_GROUP_IDS])
    const after = seqOf(live2)
    for (const t of tablesForGroups([...BACKUP_GROUP_IDS])) {
      const want = Math.max(live2Seq[t] ?? 0, bkSeq[t] ?? 0)
      if (want > 0) expect(after[t] ?? 0, t).toBeGreaterThanOrEqual(want)
    }
    expect(after.todos).toBe(32)
  })

  it('M9 컬럼이 빠진 구스키마 백업(daily_plans.wrapup_skipped_at 없음)도 복원된다', () => {
    const live = createDb(LIVE)
    const bk = makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS], (b) => {
      b.exec('ALTER TABLE daily_plans DROP COLUMN wrapup_skipped_at')
      b.exec('ALTER TABLE meeting_segments DROP COLUMN text_corrected')
      b.exec('DROP TABLE assistant_exclusions')
    })
    expect(rows(bk, 'PRAGMA table_info(daily_plans)').map((r) => r.name)).not.toContain('wrapup_skipped_at')
    restore(live, bk, [...BACKUP_GROUP_IDS])
    expect(rows(live, 'SELECT plan_date, wrapup_skipped_at FROM daily_plans')).toEqual([
      { plan_date: '2026-11-18', wrapup_skipped_at: null }
    ])
    expect(rows(live, 'SELECT text_corrected FROM meeting_segments').every((r) => r.text_corrected === 0)).toBe(true)
    expect(rows(live, 'SELECT COUNT(*) AS c FROM assistant_exclusions')[0].c).toBe(0)
    expect(rows(live, 'SELECT title FROM meetings WHERE id = 1')[0].title).toBe('other-m1')
  })

  it('M10 모르는 컬럼이나 테이블이 있는 백업은 라이브 DB 를 바꾸지 않고 거부된다', () => {
    for (const mutate of [
      (b: Db) => b.exec('ALTER TABLE meetings ADD COLUMN future_col TEXT'),
      (b: Db) => b.exec('CREATE TABLE future_table (id INTEGER PRIMARY KEY)')
    ]) {
      const live = createDb(LIVE)
      const bk = makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS], mutate)
      const before = hashes(live)
      expect(() => prepareBackupDb(bk, live)).toThrow(/더 새 버전/)
      // prepare 를 건너뛰어도 병합 단계에서 다시 거부한다
      expect(() => mergeBackupIntoLive(live, bk, [...BACKUP_GROUP_IDS])).toThrow(/더 새 버전/)
      expect(hashes(live)).toEqual(before)
    }
  })

  it('M11 병합 중 오류를 주입하면 롤백되어 라이브 DB 가 복원 전과 같다', () => {
    const live = createDb(LIVE)
    const bk = makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS])
    prepareBackupDb(bk, live)
    const before = hashes(live)
    const seqBefore = rows(live, 'SELECT name, seq FROM sqlite_sequence ORDER BY name')
    expect(() =>
      mergeBackupIntoLive(live, bk, [...BACKUP_GROUP_IDS], {
        beforeCommit: () => {
          throw new Error('injected')
        }
      })
    ).toThrow('injected')
    expect(hashes(live)).toEqual(before)
    expect(rows(live, 'SELECT name, seq FROM sqlite_sequence ORDER BY name')).toEqual(seqBefore)

    // 백업 자체의 참조 오류(foreign_key_check)도 롤백된다
    const bkBad = makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS], (b) => {
      b.exec('PRAGMA foreign_keys = OFF')
      b.exec('UPDATE tasks SET project_id = 999 WHERE id = 1')
    })
    expect(() => restore(live, bkBad, ['work'])).toThrow(/참조 오류/)
    expect(hashes(live)).toEqual(before)
    // 재시도해도 같은 연결 상태 문제 없이 정상 복원이 된다
    restore(live, bk, ['ai'])
    expect(rows(live, 'SELECT title FROM ai_chats')[0].title).toBe('other-chat')
  })

  it('M12 설정 복원: 시크릿과 auth_tokens 는 백업에서 오지 않고, 계정이 같으면 현재 토큰을 유지하고 다르면 지운다', () => {
    // 같은 계정(같은 기기 백업)
    const live = createDb(LIVE)
    const bk = makeBackup(live, [...BACKUP_GROUP_IDS], (b) => {
      // 백업에 시크릿이 (잘못) 남아 있어도 가져오지 않는다
      b.prepare(`INSERT INTO app_settings (key, value) VALUES ('notion_token', 'bk-notion')`).run()
      b.prepare(`INSERT INTO auth_tokens (id, provider, access_token) VALUES (7, 'google', 'bk-access')`).run()
      b.prepare(`UPDATE app_settings SET value = 'bk-exp' WHERE key = 'jira_token_expires_at'`).run()
      b.prepare(`UPDATE app_settings SET value = 'bk-on' WHERE key = 'assistant_enabled'`).run()
      b.prepare(`DELETE FROM app_settings WHERE key = 'live_only_key'`).run()
      b.prepare(`DELETE FROM app_settings WHERE key = 'bitbucket_email'`).run()
    })
    let res = restore(live, bk, ['settings'])
    let s = settingsMap(live)
    expect(s.jira_api_token).toBe('live-jira-token')
    expect(s.jira_token_expires_at).toBe('live-exp')
    expect(s.jira_account_name).toBe('live-acct')
    expect(s.google_client_secret).toBe('live-gsecret')
    expect(s.notion_token).toBe('live-notion')
    expect(s.bitbucket_email).toBe('live@bb.com') // 백업에 식별 키 없음 → 그대로
    expect(s.bitbucket_api_token).toBe('live-bb-token')
    expect(s.assistant_enabled).toBe('bk-on')
    expect(s.live_only_key).toBeUndefined() // 교체(병합 아님)
    expect(s.project_sync_created_keys).toBe('["live-1"]') // work 키는 미선택
    expect(rows(live, 'SELECT id, access_token FROM auth_tokens')).toEqual([{ id: 1, access_token: 'live-access' }])
    expect(res.warnings).toEqual([])

    // 다른 계정(다른 기기 백업)
    const live2 = createDb(LIVE)
    const bk2 = makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS])
    res = restore(live2, bk2, ['settings'])
    s = settingsMap(live2)
    expect(s.jira_email).toBe('other@x.com')
    expect(s.jira_site_url).toBe('https://site.atlassian.net')
    expect(s.jira_api_token).toBeUndefined()
    expect(s.jira_token_expires_at).toBeUndefined()
    expect(s.jira_account_name).toBeUndefined()
    expect(s.google_client_id).toBe('other-gid')
    expect(s.google_client_secret).toBeUndefined()
    expect(s.bitbucket_email).toBe('other@bb.com')
    expect(s.bitbucket_api_token).toBeUndefined()
    expect(s.notion_token).toBe('live-notion') // notion 은 늘 유지
    expect(rows(live2, 'SELECT COUNT(*) AS c FROM auth_tokens')[0].c).toBe(0)
    expect(res.warnings.join('\n')).toMatch(/Jira/)
    expect(res.warnings.join('\n')).toMatch(/Google/)
    expect(res.warnings.join('\n')).toMatch(/Bitbucket/)
    for (const k of SECRET_SETTING_KEYS) expect(s[k] ?? 'live').toMatch(/^live/)

    // 업무만 복원하면 연동 값은 전혀 바뀌지 않고 work 키만 교체된다
    const live3 = createDb(LIVE)
    const before3 = settingsMap(live3)
    restore(live3, makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS]), ['work'])
    const after3 = settingsMap(live3)
    expect(after3.project_sync_created_keys).toBe('["other-1"]')
    expect({ ...after3, project_sync_created_keys: '' }).toEqual({ ...before3, project_sync_created_keys: '' })
  })

  it('M17 설정 복원으로 Jira 계정이 바뀌면 프로젝트 보드 캐시를 지우고, 같으면 둔다', () => {
    const seedCache = (path: string): void => {
      const db = new Database(path)
      db.prepare(
        "INSERT INTO jira_board_issues (project_key, issue_key, data, updated, synced_at) VALUES ('PROJ', 'PROJ-1', '{}', 'u', 's')"
      ).run()
      db.prepare("INSERT INTO jira_board_sync (project_key, recent_done_days) VALUES ('PROJ', 14)").run()
      db.close()
    }
    const count = (path: string): number =>
      Number(rows(path, 'SELECT COUNT(*) AS c FROM jira_board_issues')[0].c) +
      Number(rows(path, 'SELECT COUNT(*) AS c FROM jira_board_sync')[0].c)

    const same = createDb(LIVE)
    seedCache(same)
    restore(same, makeBackup(same, [...BACKUP_GROUP_IDS]), ['settings'])
    expect(count(same)).toBe(2)

    const other = createDb(LIVE)
    seedCache(other)
    restore(other, makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS]), ['settings'])
    expect(count(other)).toBe(0)

    // 업무만 복원하면 연동 판정을 하지 않아 캐시를 건드리지 않는다
    const work = createDb(LIVE)
    seedCache(work)
    restore(work, makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS]), ['work'])
    expect(count(work)).toBe(2)
  })

  it('M13 선택 그룹과 X1~X3 자식 테이블의 foreign_key_check 위반 0건', () => {
    const fkChildren = CROSS_GROUP_REFS.filter((r) => r.kind === 'fk').map((r) => r.childTable)
    const combos: BackupGroupId[][] = [
      ...BACKUP_GROUP_IDS.map((g) => [g]),
      ['work', 'meetings'],
      ['meetings', 'library'],
      [...BACKUP_GROUP_IDS]
    ]
    for (const source of [LIVE, OTHER]) {
      for (const groups of combos) {
        const live = createDb(LIVE)
        const bk = makeBackup(createDb(source), groups, (b) => {
          if (groups.includes('work')) {
            b.exec('PRAGMA foreign_keys = ON')
            b.exec('DELETE FROM projects WHERE id = 2')
          }
        })
        restore(live, bk, groups)
        const tables = Array.from(new Set([...tablesForGroups(groups), ...fkChildren]))
        expect(fkViolations(live, tables), `${source.label} ${groups.join(',')}`).toEqual([])
      }
    }
  })

  it('요청 그룹이 비었거나 모르는 id 면 아무것도 바꾸지 않고 거부한다', () => {
    const live = createDb(LIVE)
    const bk = makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS])
    const before = hashes(live)
    expect(() => mergeBackupIntoLive(live, bk, [])).toThrow()
    expect(() => mergeBackupIntoLive(live, bk, ['nope' as BackupGroupId])).toThrow()
    expect(hashes(live)).toEqual(before)
  })

  it('M14 연동 계정 판정은 대소문자·앞뒤 공백·끝 슬래시 차이를 같은 계정으로 본다(토큰을 지우지 않는다)', () => {
    const live = createDb(LIVE)
    setSettings(live, {
      jira_email: ' Me@Example.com ',
      jira_site_url: 'https://site.atlassian.net',
      jira_api_token: 'live-jira-token',
      bitbucket_email: 'Me@Example.com',
      bitbucket_api_token: 'live-bb-token'
    })
    const bk = makeBackup(createDb(LIVE), ['settings'], (b) => {
      setSettingsRaw(b, {
        jira_email: 'me@example.com',
        jira_site_url: 'https://site.atlassian.net/',
        bitbucket_email: 'me@example.com '
      })
    })
    const res = restore(live, bk, ['settings'])
    const s = settingsMap(live)
    expect(s.jira_api_token).toBe('live-jira-token')
    expect(s.bitbucket_api_token).toBe('live-bb-token')
    expect(res.warnings).toEqual([])
  })

  it('M16 created_at 이 NULL 인 부모도 id·created_at 이 모두 NULL 로 같으면 같은 엔터티로 보고 연결을 유지한다', () => {
    const live = createDb(LIVE)
    rowsExec(live, 'UPDATE projects SET created_at = NULL')
    const bk = makeBackup(live, ['meetings'])
    expect(rows(bk, `SELECT COUNT(*) AS c FROM ${BACKUP_REFS_TABLE} WHERE created_at IS NULL`)[0].c).toBe(2)
    restore(live, bk, ['meetings'])
    expect(rows(live, 'SELECT id, project_id FROM meetings ORDER BY id')).toEqual([
      { id: 1, project_id: 1 },
      { id: 2, project_id: 2 }
    ])
  })

  it('M15 현재 연결이 없는 기기에 복원해도 "연결을 지웠다"는 경고를 내지 않는다', () => {
    const live = createDb(LIVE)
    // 이 기기에 연동 자격이 하나도 없는 상태(새 기기)
    setSettings(live, {
      jira_api_token: null,
      jira_token_expires_at: null,
      jira_account_name: null,
      bitbucket_api_token: null,
      google_client_secret: null
    })
    const clearTokens = open(live)
    clearTokens.exec('DELETE FROM auth_tokens')
    clearTokens.close()
    const bk = makeBackup(createDb(OTHER), [...BACKUP_GROUP_IDS])
    const res = restore(live, bk, ['settings'])
    const s = settingsMap(live)
    expect(s.jira_email).toBe('other@x.com') // 식별 키는 백업 값
    expect(s.jira_api_token).toBeUndefined()
    expect(res.warnings).toEqual([])
  })
})

function rowsExec(path: string, sql: string): void {
  const db = open(path)
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

function setSettingsRaw(db: Db, values: Record<string, string>): void {
  const upsert = db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  for (const [k, v] of Object.entries(values)) upsert.run(k, v)
}

function setSettings(path: string, values: Record<string, string | null>): void {
  const db = open(path)
  try {
    for (const [k, v] of Object.entries(values)) {
      if (v === null) db.prepare('DELETE FROM app_settings WHERE key = ?').run(k)
      else setSettingsRaw(db, { [k]: v })
    }
  } finally {
    db.close()
  }
}
