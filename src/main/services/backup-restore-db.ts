// 선택 그룹 백업·복원의 DB 계층 (docs/DATA_BACKUP.md)
//
// - prepareBackupDb: 풀어 놓은 백업 DB 를 현재 스키마까지 올리고(applySchema), 이 앱이 모르는
//   테이블·컬럼이 있으면(더 새 앱의 백업) 거부한다. 라이브 DB 를 닫기 **전에** 부른다.
// - filterSnapshotGroups: 내보내기 사본(VACUUM INTO)에서 빼는 그룹의 행을 지우고, 빠진 부모
//   테이블의 (id, created_at) 를 linkwork_backup_refs 에 남긴다.
// - mergeBackupIntoLive: 선택 그룹의 테이블을 백업 내용으로 **교체**한다(병합 아님). 선택하지
//   않은 그룹의 행은 바꾸지 않는다. 한 트랜잭션이라 실패하면 라이브 DB 는 그대로 남는다.
//
// 공통 규칙
// - foreign_keys 는 끈다. 부모(projects 등)를 지울 때 CASCADE/SET NULL 이 다른 그룹으로
//   번지지 않게 하려는 것이다. 그룹을 넘는 참조는 "정체성 일치"(id 와 created_at 이 같음)
//   규칙으로 직접 정리한다(CROSS_GROUP_REFS).
// - 쓰기 PRAGMA 는 트랜잭션 밖에서 건다(트랜잭션 안에서는 무시된다).
// - 읽기 PRAGMA 는 prepare().all() 로 부른다. 테스트 shim(node:sqlite)의 pragma() 는 값을
//   돌려주지 않는다.
import Database from 'better-sqlite3'
import { applySchema } from '../db/schema'
import {
  BACKUP_GROUP_IDS,
  BACKUP_REFS_TABLE,
  BUNDLE_SETTING_KEYS,
  CREDENTIAL_BUNDLES,
  CROSS_GROUP_REFS,
  REF_PARENT_TABLES,
  classifySettingKey,
  groupOfTable,
  normalizeGroups,
  tablesForGroups,
  type BackupGroupId
} from './backup-groups'

/** better-sqlite3 와 테스트 shim(node:sqlite) 양쪽에 맞는 최소 인터페이스 (backup-service DatabaseLike 와 같은 모양) */
export interface SnapshotDbLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  exec(sql: string): unknown
}

export interface MergeResult {
  warnings: string[]
  /** 정체성이 일치하지 않아 끊은 참조 수. 키는 'X1'~'X4' */
  nulledRefs: Record<string, number>
}

export interface MergeOptions {
  /** 테스트 전용: COMMIT 직전에 불린다. 던지면 ROLLBACK 된다(M11). */
  beforeCommit?: (db: SnapshotDbLike) => void
}

// ── 공용 헬퍼 ──

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function listTables(db: SnapshotDbLike, schema = 'main'): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as { name: string }[]
  return rows.map((r) => r.name).filter((n) => n !== BACKUP_REFS_TABLE)
}

export function tableExists(db: SnapshotDbLike, table: string, schema = 'main'): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
      .all(table).length > 0
  )
}

function columnsOf(db: SnapshotDbLike, table: string, schema = 'main'): string[] {
  const rows = db.prepare(`PRAGMA ${schema}.table_info(${q(table)})`).all() as { name: string }[]
  return rows.map((r) => r.name)
}

function changesOf(result: unknown): number {
  const c = (result as { changes?: number | bigint } | undefined)?.changes
  return c == null ? 0 : Number(c)
}

/**
 * 백업 쪽(`bkSchema`)에 있는데 라이브 쪽(`liveSchema`)에 없는 테이블·컬럼을 돌려준다.
 * 'table' 또는 'table.column' 형식.
 */
function findUnknownSchema(
  bk: SnapshotDbLike,
  bkSchema: string,
  live: SnapshotDbLike,
  liveSchema: string
): string[] {
  const liveTables = new Set(listTables(live, liveSchema))
  const unknown: string[] = []
  for (const table of listTables(bk, bkSchema)) {
    if (!liveTables.has(table)) {
      unknown.push(table)
      continue
    }
    const liveCols = new Set(columnsOf(live, table, liveSchema))
    for (const col of columnsOf(bk, table, bkSchema)) {
      if (!liveCols.has(col)) unknown.push(`${table}.${col}`)
    }
  }
  return unknown
}

function unknownSchemaError(unknown: string[]): Error {
  return new Error(
    `이 백업은 더 새 버전의 앱에서 만들어졌습니다(이 앱이 모르는 항목: ${unknown.join(', ')}). ` +
      '앱을 업데이트한 뒤 복원하세요.'
  )
}

// ── 복원 준비 ──

/**
 * 풀어 놓은 백업 DB 사본을 현재 스키마까지 올리고, 이 앱이 모르는 테이블·컬럼이 있으면 throw 한다.
 * 백업 사본은 임시 파일이라 쓰기로 열고, 라이브 DB 는 readonly 로 연다.
 */
export function prepareBackupDb(backupDbPath: string, liveDbPath: string): void {
  const bk = new Database(backupDbPath)
  try {
    applySchema(bk)
    const live = new Database(liveDbPath, { readonly: true })
    try {
      const unknown = findUnknownSchema(bk, 'main', live, 'main')
      if (unknown.length > 0) throw unknownSchemaError(unknown)
    } finally {
      live.close()
    }
  } finally {
    bk.close()
  }
}

// ── 내보내기 필터 ──

/**
 * 내보내기 사본에서 `groups` 에 없는 그룹의 행과 app_settings 키를 지운다(스키마는 남긴다).
 * 빠진 부모 테이블(projects·todos·meetings)의 (id, created_at) 는 linkwork_backup_refs 에 남겨
 * 복원 때 정체성 판정에 쓴다.
 *
 * 먼저 foreign_keys 를 끈다. 켠 채로 projects 를 지우면 사본 안의 meetings.project_id 가
 * SET NULL 로 지워진다. 그래서 트랜잭션 밖에서 불러야 한다. 라이브 DB 에 절대 쓰지 말 것.
 */
export function filterSnapshotGroups(copy: SnapshotDbLike, groups: BackupGroupId[]): void {
  copy.exec('PRAGMA foreign_keys = OFF')
  const selected = normalizeGroups(groups)
  if (!selected) throw new Error('백업할 항목을 하나 이상 골라야 합니다.')
  const excluded = BACKUP_GROUP_IDS.filter((g) => !selected.includes(g))
  if (excluded.length === 0) return

  const refParents = REF_PARENT_TABLES.filter((t) => {
    const g = groupOfTable(t)
    return g !== null && excluded.includes(g) && tableExists(copy, t)
  })
  if (refParents.length > 0) {
    copy.exec(`CREATE TABLE IF NOT EXISTS ${BACKUP_REFS_TABLE} (
      tbl TEXT NOT NULL,
      id INTEGER NOT NULL,
      created_at TEXT,
      PRIMARY KEY (tbl, id)
    )`)
    for (const t of refParents) {
      copy
        .prepare(
          `INSERT OR REPLACE INTO ${BACKUP_REFS_TABLE} (tbl, id, created_at) SELECT ?, id, created_at FROM ${q(t)}`
        )
        .run(t)
    }
  }

  for (const t of tablesForGroups(excluded)) {
    if (tableExists(copy, t)) copy.exec(`DELETE FROM ${q(t)}`)
  }

  if (tableExists(copy, 'app_settings')) {
    const keys = copy.prepare('SELECT key FROM app_settings').all() as { key: string }[]
    const del = copy.prepare('DELETE FROM app_settings WHERE key = ?')
    for (const { key } of keys) {
      const cls = classifySettingKey(key)
      if ((cls === 'work' || cls === 'settings') && excluded.includes(cls)) del.run(key)
    }
  }
}

// ── 복원 병합 ──

interface SettingRow {
  key: string
  value: string
  updated_at: string | null
}

/**
 * 라이브 DB(`liveDbPath`)의 선택 그룹을 백업(`backupDbPath`, prepareBackupDb 를 거친 사본)
 * 내용으로 교체한다. 라이브 DB 연결을 모두 닫은 뒤 부른다. 실패하면 ROLLBACK 하고 throw 한다.
 */
export function mergeBackupIntoLive(
  liveDbPath: string,
  backupDbPath: string,
  groups: BackupGroupId[],
  opts?: MergeOptions
): MergeResult {
  const selected = normalizeGroups(groups)
  if (!selected) throw new Error('복원할 항목을 하나 이상 골라야 합니다.')

  const db = new Database(liveDbPath) as unknown as SnapshotDbLike & { close(): void }
  const warnings: string[] = []
  const nulledRefs: Record<string, number> = { X1: 0, X2: 0, X3: 0, X4: 0 }
  let attached = false
  try {
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare('ATTACH DATABASE ? AS bk').run(backupDbPath)
    attached = true

    // 더 새 앱의 백업이면 아무것도 바꾸기 전에 거부한다(prepareBackupDb 와 같은 검사의 이중 방어)
    const unknown = findUnknownSchema(db, 'bk', db, 'main')
    if (unknown.length > 0) throw unknownSchemaError(unknown)

    db.exec('BEGIN IMMEDIATE')
    try {
      runMerge(db, selected, warnings, nulledRefs)
      opts?.beforeCommit?.(db)
      db.exec('COMMIT')
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // SQLite 가 이미 자동 롤백한 경우
      }
      throw e
    }
  } finally {
    if (attached) {
      try {
        db.exec('DETACH DATABASE bk')
      } catch {
        // 닫으면서 함께 풀린다
      }
    }
    db.close()
  }
  return { warnings, nulledRefs }
}

function runMerge(
  db: SnapshotDbLike,
  selected: BackupGroupId[],
  warnings: string[],
  nulledRefs: Record<string, number>
): void {
  // a. 정체성 판정용 (id, created_at). side='pre' 는 교체 전 라이브, side='bk' 는 백업 쪽
  db.exec(`DROP TABLE IF EXISTS temp._restore_ids`)
  db.exec(`CREATE TEMP TABLE _restore_ids (
    side TEXT NOT NULL, tbl TEXT NOT NULL, id INTEGER NOT NULL, created_at TEXT,
    PRIMARY KEY (side, tbl, id)
  )`)
  for (const t of REF_PARENT_TABLES) {
    if (tableExists(db, t, 'main')) {
      db.prepare(
        `INSERT OR REPLACE INTO temp._restore_ids SELECT 'pre', ?, id, created_at FROM main.${q(t)}`
      ).run(t)
    }
    if (tableExists(db, t, 'bk')) {
      db.prepare(
        `INSERT OR REPLACE INTO temp._restore_ids SELECT 'bk', ?, id, created_at FROM bk.${q(t)}`
      ).run(t)
    }
  }
  if (tableExists(db, BACKUP_REFS_TABLE, 'bk')) {
    db.exec(
      `INSERT OR IGNORE INTO temp._restore_ids SELECT 'bk', tbl, id, created_at FROM bk.${BACKUP_REFS_TABLE}`
    )
  }

  // b. 선택 그룹의 테이블 교체 + c. sqlite_sequence = max(라이브, 백업, max(id))
  const tables = tablesForGroups(selected)
  for (const t of tables) {
    if (!tableExists(db, t, 'bk')) throw new Error(`백업에 ${t} 테이블이 없습니다.`)
    if (!tableExists(db, t, 'main')) throw new Error(`현재 데이터베이스에 ${t} 테이블이 없습니다.`)
    const autoinc = isAutoincrement(db, t)
    const liveSeq = autoinc ? readSeq(db, 'main', t) : 0
    const bkSeq = autoinc ? readSeq(db, 'bk', t) : 0

    const bkCols = new Set(columnsOf(db, t, 'bk'))
    const cols = columnsOf(db, t, 'main').filter((c) => bkCols.has(c))
    const colList = cols.map(q).join(', ')
    db.exec(`DELETE FROM main.${q(t)}`)
    if (cols.length > 0) {
      db.exec(`INSERT INTO main.${q(t)} (${colList}) SELECT ${colList} FROM bk.${q(t)}`)
    }

    if (autoinc) {
      const maxRows = db.prepare(`SELECT MAX(rowid) AS m FROM main.${q(t)}`).all() as {
        m: number | bigint | null
      }[]
      const maxId = Number(maxRows[0]?.m ?? 0)
      const seq = Math.max(liveSeq, bkSeq, maxId)
      const updated = changesOf(
        db.prepare('UPDATE main.sqlite_sequence SET seq = ? WHERE name = ?').run(seq, t)
      )
      if (updated === 0 && seq > 0) {
        db.prepare('INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)').run(t, seq)
      }
    }
  }

  // app_settings (키 단위) + 연동 묶음
  mergeSettings(db, selected, warnings)

  // d. 그룹 간 참조 정리 (X1~X5)
  cleanCrossGroupRefs(db, selected, warnings, nulledRefs)

  // e. 선택 그룹과 X1~X3 자식 테이블의 FK 위반 검사
  const checkTables = new Set(tables)
  for (const ref of CROSS_GROUP_REFS) {
    if (ref.kind !== 'fk') continue
    if (selected.includes(ref.childGroup) || selected.includes(ref.parentGroup)) {
      checkTables.add(ref.childTable)
    }
  }
  const violations: string[] = []
  for (const t of checkTables) {
    const rows = db.prepare(`PRAGMA main.foreign_key_check(${q(t)})`).all() as {
      table: string
      rowid: number
      parent: string
    }[]
    for (const r of rows) violations.push(`${r.table}#${r.rowid}→${r.parent}`)
  }
  if (violations.length > 0) {
    throw new Error(
      `복원 결과에 참조 오류가 ${violations.length}건 있어 되돌렸습니다: ${violations.slice(0, 5).join(', ')}`
    )
  }
  db.exec('DROP TABLE IF EXISTS temp._restore_ids')
}

function isAutoincrement(db: SnapshotDbLike, table: string): boolean {
  const rows = db
    .prepare(`SELECT sql FROM main.sqlite_master WHERE type = 'table' AND name = ?`)
    .all(table) as { sql: string | null }[]
  return /AUTOINCREMENT/i.test(rows[0]?.sql ?? '')
}

function readSeq(db: SnapshotDbLike, schema: string, table: string): number {
  if (!tableExists(db, 'sqlite_sequence', schema)) return 0
  const rows = db
    .prepare(`SELECT seq FROM ${schema}.sqlite_sequence WHERE name = ?`)
    .all(table) as { seq: number | bigint }[]
  return Number(rows[0]?.seq ?? 0)
}

function readSettings(db: SnapshotDbLike, schema: string): SettingRow[] {
  if (!tableExists(db, 'app_settings', schema)) return []
  return db
    .prepare(`SELECT key, value, updated_at FROM ${schema}.app_settings`)
    .all() as SettingRow[]
}

function mergeSettings(db: SnapshotDbLike, selected: BackupGroupId[], warnings: string[]): void {
  const bkRows = readSettings(db, 'bk')
  const liveRows = readSettings(db, 'main')
  const bkMap = new Map(bkRows.map((r) => [r.key, r]))
  const liveMap = new Map(liveRows.map((r) => [r.key, r]))

  const del = db.prepare('DELETE FROM main.app_settings WHERE key = ?')
  const upsert = db.prepare(
    `INSERT INTO main.app_settings (key, value, updated_at)
     VALUES (?, ?, COALESCE(?, datetime('now')))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
  const bundleKeys = new Set(BUNDLE_SETTING_KEYS)

  // 일반 키: 그룹에 속한 키를 백업 내용으로 교체한다. 시크릿은 백업에서 절대 가져오지 않는다.
  const replaceClass = (cls: 'work' | 'settings'): void => {
    for (const r of liveRows) {
      if (classifySettingKey(r.key) === cls && !bundleKeys.has(r.key)) del.run(r.key)
    }
    for (const r of bkRows) {
      if (classifySettingKey(r.key) === cls && !bundleKeys.has(r.key)) {
        upsert.run(r.key, r.value, r.updated_at)
      }
    }
  }
  if (selected.includes('work')) replaceClass('work')
  if (!selected.includes('settings')) return
  replaceClass('settings')

  // 연동 묶음: 식별 키로 계정이 같은지 판정한다
  for (const bundle of CREDENTIAL_BUNDLES) {
    if (bundle.identityKeys.length === 0) continue // notion: 늘 현재 값 유지
    const bkId = bundle.identityKeys.map((k) => normalizeIdentity(bkMap.get(k)?.value))
    if (bkId.every((v) => v === null)) continue // 백업에 식별 키 없음 → 현재 값 그대로
    const liveId = bundle.identityKeys.map((k) => normalizeIdentity(liveMap.get(k)?.value))
    const same = bkId.every((v, i) => v === liveId[i])

    for (const k of bundle.identityKeys) {
      const r = bkMap.get(k)
      if (r) upsert.run(r.key, r.value, r.updated_at)
      else del.run(k)
    }
    if (same) continue // 자격은 현재 값 유지

    // 지우는 자격이 실제로 있었을 때만 "다시 연결" 경고를 낸다(새 기기는 잃을 연결이 없다)
    const hadCredential =
      bundle.credentialKeys.some((k) => liveMap.has(k)) ||
      bundle.credentialTables.some((t) => tableHasRows(db, t))
    for (const k of bundle.credentialKeys) del.run(k)
    for (const t of bundle.credentialTables) {
      if (tableExists(db, t, 'main')) db.exec(`DELETE FROM main.${q(t)}`)
    }
    if (hadCredential) {
      warnings.push(`${bundle.label} 연동 계정이 백업과 달라 현재 연결을 지웠습니다. 다시 연결하세요.`)
    }
  }
}

/**
 * 계정 식별 값 비교용 정규화. 이메일·사이트 주소는 대소문자·앞뒤 공백·끝 슬래시 차이로
 * 다른 계정이 되지 않는다. 값이 없으면 null.
 */
function normalizeIdentity(value: string | null | undefined): string | null {
  if (value == null) return null
  const v = value.trim().toLowerCase().replace(/\/+$/, '')
  return v === '' ? null : v
}

function tableHasRows(db: SnapshotDbLike, table: string): boolean {
  if (!tableExists(db, table, 'main')) return false
  const rows = db.prepare(`SELECT 1 AS x FROM main.${q(table)} LIMIT 1`).all()
  return rows.length > 0
}

/**
 * 그룹 간 참조를 정체성 규칙으로 정리한다. 자식과 부모 중 한쪽만 교체됐을 때만 할 일이 있다.
 * - 자식이 복원되고 부모가 라이브면: 백업 쪽 부모 정체성(bk 테이블 또는 refs) 과 라이브를 비교
 * - 자식이 라이브고 부모가 복원되면: 교체 전 부모 정체성(pre) 과 지금(=백업) 을 비교
 */
function cleanCrossGroupRefs(
  db: SnapshotDbLike,
  selected: BackupGroupId[],
  warnings: string[],
  nulledRefs: Record<string, number>
): void {
  for (const ref of CROSS_GROUP_REFS) {
    const childSel = selected.includes(ref.childGroup)
    const parentSel = selected.includes(ref.parentGroup)
    if (childSel === parentSel) continue
    if (!tableExists(db, ref.childTable, 'main') || !tableExists(db, ref.parentTable, 'main')) continue
    const side = childSel ? 'bk' : 'pre'
    const matchSql = `EXISTS (
      SELECT 1 FROM temp._restore_ids o
      JOIN main.${q(ref.parentTable)} p ON p.id = o.id AND p.created_at IS o.created_at
      WHERE o.side = '${side}' AND o.tbl = '${ref.parentTable}' AND o.id = ?
    )`
    const matchStmt = db.prepare(`SELECT ${matchSql} AS ok`)
    const matches = (id: number): boolean => {
      const rows = matchStmt.all(id) as { ok: number | bigint }[]
      return Number(rows[0]?.ok ?? 0) === 1
    }

    if (ref.kind === 'fk') {
      const col = q(ref.childColumn)
      const res = db
        .prepare(
          `UPDATE main.${q(ref.childTable)} SET ${col} = NULL
           WHERE ${col} IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM temp._restore_ids o
             JOIN main.${q(ref.parentTable)} p ON p.id = o.id AND p.created_at IS o.created_at
             WHERE o.side = ? AND o.tbl = ? AND o.id = main.${q(ref.childTable)}.${col}
           )`
        )
        .run(side, ref.parentTable)
      nulledRefs[ref.id] = (nulledRefs[ref.id] ?? 0) + changesOf(res)
    } else if (ref.kind === 'json-todo') {
      const rows = db
        .prepare(
          `SELECT id, ${q(ref.childColumn)} AS v FROM main.${q(ref.childTable)} WHERE ${q(ref.childColumn)} IS NOT NULL`
        )
        .all() as { id: number; v: string }[]
      const update = db.prepare(
        `UPDATE main.${q(ref.childTable)} SET ${q(ref.childColumn)} = ? WHERE id = ?`
      )
      for (const row of rows) {
        let items: unknown
        try {
          items = JSON.parse(row.v)
        } catch {
          continue
        }
        if (!Array.isArray(items)) continue
        let changed = 0
        const next = items.map((item) => {
          if (!item || typeof item !== 'object') return item
          const todoId = (item as { todo_id?: unknown }).todo_id
          if (todoId == null) return item
          if (typeof todoId === 'number' && matches(todoId)) return item
          changed += 1
          return { ...(item as object), todo_id: null }
        })
        if (changed > 0) {
          update.run(JSON.stringify(next), row.id)
          nulledRefs[ref.id] = (nulledRefs[ref.id] ?? 0) + changed
        }
      }
    } else {
      // candidate: 값은 바꾸지 않고 활성 계획에서 맞지 않는 건수만 센다
      if (!tableExists(db, 'daily_plans', 'main')) continue
      const rows = db
        .prepare(
          `SELECT pi.candidate_id AS c FROM main.plan_items pi
           JOIN main.daily_plans dp ON dp.id = pi.plan_id
           WHERE dp.status = 'active' AND pi.candidate_id LIKE 'action_item:%'`
        )
        .all() as { c: string }[]
      let mismatched = 0
      for (const { c } of rows) {
        const id = Number(c.split(':')[1])
        if (!Number.isInteger(id) || !matches(id)) mismatched += 1
      }
      if (mismatched > 0) {
        warnings.push(
          `오늘 계획의 회의 액션아이템 ${mismatched}건이 현재 회의와 맞지 않습니다. 해당 항목은 회의로 이동하지 못할 수 있습니다.`
        )
      }
    }
  }
}
