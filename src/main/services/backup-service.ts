// 앱 데이터 백업 · 복원 (docs/DATA_BACKUP.md)
//
// [형식] 백업 한 벌은 **단일 .zip 파일**이다. 내부 구조는 그대로 폴더 모양이다:
//   manifest.json      마지막 엔트리 — 존재 = 완전한 백업
//   linkwork.db        VACUUM INTO 스냅샷에서 시크릿을 지우고 VACUUM한 사본
//   recordings/<name>  녹음 원본 (.wav는 비압축 저장 — PCM 압축은 느리기만 하다)
//   ai-attachments/<name>
//
// [설계]
// - DB 스냅샷은 라이브 핸들에서 `VACUUM INTO`로 뜬다. WAL이 켜져 있어도 일관된 사본이
//   나오므로 앱을 멈추지 않아도 된다(파일 복사는 -wal이 남아 위험).
// - **기기 종속 시크릿은 사본에서 지운다.** safeStorage(macOS 키체인)로 암호화된 값은
//   다른 기기에서 복호화되지 않아 옮겨봐야 쓸모가 없고, 남겨두면 유출 표면만 넓어진다.
//   지운 뒤 VACUUM으로 free page까지 스크럽한다.
// - 쓰기·읽기 모두 **스트리밍**이다(yazl/yauzl). 녹음이 2GB를 넘으므로 zip 전체를
//   메모리에 올리는 방식은 쓸 수 없다.
// - 복원은 zip을 os.tmpdir에 푼 뒤 폴더 기반 복원 로직(restoreFromFolder)을 태운다.
//   폴더 층을 남겨 둔 덕에 복원 로직을 zip 없이도 테스트할 수 있다.
//
// [테스트 가능성]
// 이 모듈은 electron과 db/database를 **정적으로 import하지 않는다**. 둘 다 상단에서
// electron을 끌어오는 바람에 vitest(Node)에서 로드가 깨지기 때문이다. 기본값이 필요한
// 순간에만 동적 import로 가져오고, 테스트는 paths/sourceDb를 주입해 electron 없이 돈다.
import Database from 'better-sqlite3'
import { createWriteStream, existsSync, type Dirent } from 'fs'
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, statfs } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve, sep } from 'path'
import { PassThrough } from 'stream'
import { pipeline } from 'stream/promises'
import * as yauzl from 'yauzl'
import { ZipFile } from 'yazl'
import {
  BACKUP_GROUP_IDS,
  GROUP_FILE_DIRS,
  GROUP_TABLES,
  SECRET_SETTING_KEYS,
  SECRET_TABLES,
  CACHE_TABLES,
  classifySettingKey,
  normalizeGroups,
  type BackupFileDir,
  type BackupGroupId
} from './backup-groups'
import { applySchema } from '../db/schema'
import {
  filterSnapshotGroups,
  mergeBackupIntoLive,
  prepareBackupDb,
  tableExists
} from './backup-restore-db'

/**
 * 형식 v2: manifest.groups가 생겼다(선택 백업). v1은 언제나 전체 백업이었다.
 * **그룹을 추가할 때는 이 값을 반드시 올린다** — 구버전 앱이 모르는 그룹을 조용히 버리지 않도록.
 */
export const BACKUP_FORMAT_VERSION = 2
const BACKUP_FILE_PREFIX = 'LinkWork-backup-'
const BACKUP_FILE_EXTENSION = '.zip'
export const MANIFEST_ENTRY = 'manifest.json'
export const DB_FILE = 'linkwork.db'

type FileDir = BackupFileDir

/** userData 바로 아래에서 통째로 옮기는 폴더. models/는 첫 실행 시 다시 받으므로 제외. */
const FILE_GROUPS: ReadonlyArray<{ dir: FileDir; key: 'recordings' | 'attachments' }> = [
  { dir: 'recordings', key: 'recordings' },
  { dir: 'ai-attachments', key: 'attachments' }
]

/** 그룹 목록이 담는 파일 폴더(중복 없이) */
function fileDirsForGroups(groups: readonly BackupGroupId[]): FileDir[] {
  const dirs = new Set<FileDir>()
  for (const g of groups) for (const d of GROUP_FILE_DIRS[g]) dirs.add(d)
  return FILE_GROUPS.map((f) => f.dir).filter((d) => dirs.has(d))
}

function isAllGroups(groups: readonly BackupGroupId[]): boolean {
  return BACKUP_GROUP_IDS.every((g) => groups.includes(g))
}

/**
 * IPC 인자로 들어온 그룹 목록을 검증한다. 렌더러 값은 믿지 않는다.
 * 실패하면 사용자에게 보여 줄 문장을 돌려준다.
 */
export function parseGroupsArg(
  v: unknown
): { ok: true; groups: BackupGroupId[] } | { ok: false; error: string } {
  const groups = normalizeGroups(v)
  if (!groups) {
    return { ok: false, error: '백업할 항목을 하나 이상 올바르게 선택하세요.' }
  }
  return { ok: true, groups }
}

/**
 * 이미 압축돼 있거나(이미지) 압축해도 이득이 없는(WAV PCM) 확장자는 그대로 저장한다.
 * 2GB 녹음을 deflate에 태우면 몇 분이 더 걸리는데 줄어드는 양은 거의 없다.
 */
const STORED_EXTENSIONS = ['.wav', '.ogg', '.webm', '.mp3', '.m4a', '.png', '.jpg', '.jpeg', '.gif', '.webp']

interface BackupManifest {
  format: 'linkwork-backup'
  formatVersion: number
  appVersion: string
  createdAt: string
  platform: string
  /** 이 백업에 든 그룹(고정 순서, 중복 없음, 1개 이상). v1 manifest는 전체로 정규화한다. */
  groups: BackupGroupId[]
  /** 그룹 필터 뒤의 행 수 — 빠진 그룹의 테이블은 0 */
  db: { bytes: number; tables: Record<string, number> }
  files: {
    recordings: { count: number; bytes: number }
    attachments: { count: number; bytes: number }
  }
  /** 실제로 제거된 항목 — 'auth_tokens' | 'app_settings:notion_token' 형식 */
  excluded: string[]
}

export interface BackupProgress {
  phase: 'db' | 'files' | 'done' | 'error'
  /** 0~1 */
  progress: number
  message?: string
}

/** 테스트 주입용. 기본값은 electron app.getPath('userData'). */
export interface BackupPaths {
  userDataDir: string
  dbPath: string
}

interface BackupSummary {
  /** 백업 .zip 파일의 전체 경로 */
  path: string
  manifest: BackupManifest
  warnings: string[]
}

/**
 * stripSecrets가 요구하는 최소 인터페이스.
 * better-sqlite3와 테스트용 node:sqlite shim 양쪽에 구조적으로 맞는다.
 */
export interface DatabaseLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
  exec(sql: string): unknown
}

interface FileCopyPlanEntry {
  src: string
  /** 백업 안에서의 상대 경로 (예: 'recordings/12.wav') */
  rel: string
  bytes: number
}

interface ExportOptions {
  paths?: BackupPaths
  onProgress?: (p: BackupProgress) => void
  /** 라이브 DB 핸들. 생략하면 db/database의 getDatabase()를 동적으로 가져온다(테스트 주입용). */
  sourceDb?: DatabaseLike
  /** manifest.appVersion. 생략하면 electron app.getVersion()(테스트 주입용). */
  appVersion?: string
  /** 담을 그룹. 생략하면 전체. 빈 배열이나 모르는 id는 거부한다. */
  groups?: readonly BackupGroupId[]
}

/** 백업 화면에 그룹별로 보여 주는 현재 건수와 파일 용량 */
interface BackupGroupStat {
  id: BackupGroupId
  /**
   * 그룹 테이블별 행 수. settings 그룹은 테이블이 없어서 `app_settings` 하나로,
   * settings로 분류되는 키 수를 담는다(시크릿·work 키 제외).
   */
  tables: Record<string, number>
  files: { count: number; bytes: number }
}

interface ImportResult {
  restoredDbBackupPath: string
  /** 실제로 복원한 그룹 */
  groups: BackupGroupId[]
  /** 복원은 됐지만 사용자가 알아야 할 것(연동 재연결, 끊긴 계획 항목 등) */
  warnings: string[]
}

interface ImportOptions {
  /** 복원할 그룹. 생략하면 백업에 든 그룹 전부. manifest.groups의 부분집합이어야 한다. */
  groups?: readonly BackupGroupId[]
  paths?: BackupPaths
  onProgress?: (p: BackupProgress) => void
  /** DB 파일을 덮어쓰기 전에 열려 있는 핸들을 닫는다 (= db/database의 closeDatabase). */
  closeDb: () => void
  /**
   * DB 핸들을 닫은 직후 호출된다. 이 시점 이후로는 실패하더라도 **앱을 재시작해야**
   * 정상 상태로 돌아온다(닫힌 핸들로는 어떤 DB 접근도 되지 않는다).
   */
  onDbClosed?: () => void
  /** 현재 DB의 .bak 사본을 만든 직후, 그 경로와 함께 호출된다 (사용자 안내용). */
  onRollbackPointCreated?: (bakPath: string) => void
}

// ── 순수 함수 ──

/** 'YYYYMMDD-HHmmss' (로컬 시각) */
function backupStamp(now: Date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  )
}

/** 저장 다이얼로그의 기본 파일명 */
export function defaultBackupFileName(now: Date = new Date()): string {
  return `${BACKUP_FILE_PREFIX}${backupStamp(now)}${BACKUP_FILE_EXTENSION}`
}

export function buildManifest(input: {
  appVersion: string
  dbBytes: number
  tables: Record<string, number>
  files: BackupManifest['files']
  excluded: string[]
  /** 생략하면 전체 */
  groups?: readonly BackupGroupId[]
  createdAt?: string
  platform?: string
}): BackupManifest {
  return {
    format: 'linkwork-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: input.appVersion,
    createdAt: input.createdAt ?? new Date().toISOString(),
    platform: input.platform ?? process.platform,
    groups: normalizeGroups(input.groups ?? BACKUP_GROUP_IDS) ?? [...BACKUP_GROUP_IDS],
    db: { bytes: input.dbBytes, tables: input.tables },
    files: input.files,
    excluded: input.excluded
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isCountBytes(v: unknown): v is { count: number; bytes: number } {
  return isRecord(v) && typeof v.count === 'number' && typeof v.bytes === 'number'
}

/**
 * manifest.json이 이 앱이 만든 것이고 이 버전이 읽을 수 있는지 확인한다.
 * 상위 formatVersion은 **거부**한다 — 모르는 형식을 억지로 복원하면 조용히 데이터가 빈다.
 */
export function validateManifest(
  raw: unknown
): { ok: true; manifest: BackupManifest } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'manifest.json의 내용이 객체가 아닙니다.' }
  if (raw.format !== 'linkwork-backup') {
    return { ok: false, reason: 'LinkWork 백업 파일이 아닙니다 (format 불일치).' }
  }
  if (typeof raw.formatVersion !== 'number' || !Number.isFinite(raw.formatVersion)) {
    return { ok: false, reason: 'formatVersion이 없거나 숫자가 아닙니다.' }
  }
  if (raw.formatVersion > BACKUP_FORMAT_VERSION) {
    return {
      ok: false,
      reason: `더 새로운 버전의 백업입니다 (형식 v${raw.formatVersion}, 이 앱은 v${BACKUP_FORMAT_VERSION}까지). 앱을 업데이트한 뒤 다시 시도하세요.`
    }
  }
  // v1 백업은 언제나 전체였다. v2부터는 groups가 반드시 있어야 하고 아는 id만 허용한다.
  let groups: BackupGroupId[]
  if (raw.formatVersion < 2) {
    groups = [...BACKUP_GROUP_IDS]
  } else {
    const parsed = normalizeGroups(raw.groups)
    if (!parsed) {
      return {
        ok: false,
        reason:
          'manifest의 groups가 없거나 비었거나 이 앱이 모르는 항목이 있습니다. 앱을 업데이트했는지 확인하세요.'
      }
    }
    groups = parsed
  }
  if (typeof raw.appVersion !== 'string') return { ok: false, reason: 'appVersion이 없습니다.' }
  if (typeof raw.createdAt !== 'string') return { ok: false, reason: 'createdAt이 없습니다.' }
  if (!isRecord(raw.db) || typeof raw.db.bytes !== 'number' || !isRecord(raw.db.tables)) {
    return { ok: false, reason: 'db 정보(bytes/tables)가 없습니다.' }
  }
  if (
    !isRecord(raw.files) ||
    !isCountBytes(raw.files.recordings) ||
    !isCountBytes(raw.files.attachments)
  ) {
    return { ok: false, reason: 'files 정보(recordings/attachments)가 없습니다.' }
  }
  const manifest: BackupManifest = {
    format: 'linkwork-backup',
    formatVersion: raw.formatVersion,
    appVersion: raw.appVersion,
    createdAt: raw.createdAt,
    platform: typeof raw.platform === 'string' ? raw.platform : 'unknown',
    groups,
    db: { bytes: raw.db.bytes, tables: raw.db.tables as Record<string, number> },
    files: { recordings: raw.files.recordings, attachments: raw.files.attachments },
    excluded: Array.isArray(raw.excluded) ? raw.excluded.filter((x) => typeof x === 'string') : []
  }
  return { ok: true, manifest }
}

/**
 * zip slip 방어. zip 엔트리 이름은 **공격자가 정하는 값**이라, 그대로 join하면
 * `../../../.ssh/authorized_keys` 같은 이름으로 압축 해제 대상 폴더 밖에 쓸 수 있다.
 * yauzl도 기본적으로 같은 검사를 하지만, 우리 층에서 한 번 더 막고 한국어로 알린다.
 */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.includes('\0') || name.length > 1024) return false
  if (name.includes('\\')) return false // 윈도우 구분자로 위장한 경로
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false // 절대 경로
  const parts = name.split('/')
  if (parts.some((p) => p === '..' || p === '.' || p === '')) return false
  return true
}

/** 우리가 만든 백업에 들어 있어야 하는 엔트리인지. 모르는 엔트리는 풀지 않는다. */
export function classifyEntry(
  name: string
): 'manifest' | 'db' | 'recordings' | 'attachments' | null {
  if (name === MANIFEST_ENTRY) return 'manifest'
  if (name === DB_FILE) return 'db'
  if (name.startsWith('recordings/') && !name.slice('recordings/'.length).includes('/')) {
    return 'recordings'
  }
  if (name.startsWith('ai-attachments/') && !name.slice('ai-attachments/'.length).includes('/')) {
    return 'attachments'
  }
  return null
}

function assertSafeEntryName(name: string): void {
  if (!isSafeEntryName(name)) {
    throw new Error(
      `백업 파일에 안전하지 않은 경로의 항목이 있습니다: ${name}\n손상됐거나 조작된 파일일 수 있어 복원하지 않습니다.`
    )
  }
}

/** join 이후에도 대상 폴더 안인지 확인 (심볼릭 링크·정규화 우회에 대한 최종 방어) */
function assertInside(rootDir: string, target: string): void {
  const rel = relative(resolve(rootDir), resolve(target))
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
    throw new Error(`백업 파일의 항목이 대상 폴더를 벗어납니다: ${target}`)
  }
}

/**
 * recordings/ · ai-attachments/ **바로 아래 파일만** 모은다.
 * 재귀하지 않고(.DS_Store 같은) 숨김 파일과 하위 폴더는 건너뛴다.
 * dirs를 주면 그 폴더만 본다(선택 백업·복원). 생략하면 전부.
 */
export async function planFileCopies(
  userDataDir: string,
  dirs?: readonly FileDir[]
): Promise<FileCopyPlanEntry[]> {
  const plan: FileCopyPlanEntry[] = []
  for (const group of FILE_GROUPS) {
    if (dirs && !dirs.includes(group.dir)) continue
    const dir = join(userDataDir, group.dir)
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // 폴더가 없으면 그 그룹은 0개
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      const src = join(dir, entry.name)
      const info = await stat(src)
      plan.push({ src, rel: `${group.dir}/${entry.name}`, bytes: info.size })
    }
  }
  return plan
}

function tallyFiles(plan: FileCopyPlanEntry[]): BackupManifest['files'] {
  const files: BackupManifest['files'] = {
    recordings: { count: 0, bytes: 0 },
    attachments: { count: 0, bytes: 0 }
  }
  for (const entry of plan) {
    const key = entry.rel.startsWith('recordings/') ? 'recordings' : 'attachments'
    files[key].count += 1
    files[key].bytes += entry.bytes
  }
  return files
}

/**
 * **백업 사본**에서 기기 종속 시크릿을 지운다. 라이브 DB에 절대 쓰지 말 것.
 * 반환값은 실제로 지워진 항목의 목록(= manifest.excluded)이라, 값이 없던 항목은 빠진다.
 * VACUUM(free page 스크럽)은 호출측 책임이다.
 */
export function stripSecrets(db: DatabaseLike): string[] {
  const removed: string[] = []

  for (const table of SECRET_TABLES) {
    if (!tableExists(db, table)) continue // 구버전 DB
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).all() as { c: number }[]
    if ((rows[0]?.c ?? 0) === 0) continue
    db.exec(`DELETE FROM ${table}`)
    removed.push(table)
  }

  if (tableExists(db, 'app_settings')) {
    const del = db.prepare('DELETE FROM app_settings WHERE key = ?')
    const sel = db.prepare('SELECT key FROM app_settings WHERE key = ?')
    for (const key of SECRET_SETTING_KEYS) {
      if (sel.all(key).length === 0) continue
      del.run(key)
      removed.push(`app_settings:${key}`)
    }
  }

  return removed
}

/** sqlite_master를 돌며 테이블별 행 수를 센다 (manifest.db.tables). */
function readTableCounts(db: DatabaseLike): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[]
  const counts: Record<string, number> = {}
  for (const { name } of tables.sort((a, b) => a.name.localeCompare(b.name))) {
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).all() as { c: number }[]
    counts[name] = Number(rows[0]?.c ?? 0)
  }
  return counts
}

/**
 * 백업 화면용 그룹별 현재 건수·파일 용량. COUNT(*) 몇십 번과 녹음·첨부 폴더의
 * readdir+stat이 전부라 화면을 열 때마다 불러도 된다.
 * 없는 테이블(구버전 DB)은 건너뛴다.
 */
export async function collectGroupStats(
  db: DatabaseLike,
  userDataDir: string
): Promise<BackupGroupStat[]> {
  const count = (table: string): number => {
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).all() as { c: number }[]
    return Number(rows[0]?.c ?? 0)
  }

  let settingsKeys = 0
  if (tableExists(db, 'app_settings')) {
    const keys = db.prepare('SELECT key FROM app_settings').all() as { key: string }[]
    settingsKeys = keys.filter((r) => classifySettingKey(r.key) === 'settings').length
  }

  const plan = await planFileCopies(userDataDir)
  const stats: BackupGroupStat[] = []
  for (const id of BACKUP_GROUP_IDS) {
    const tables: Record<string, number> = {}
    for (const table of GROUP_TABLES[id]) {
      if (tableExists(db, table)) tables[table] = count(table)
    }
    if (id === 'settings') tables.app_settings = settingsKeys

    const dirs = GROUP_FILE_DIRS[id]
    const files = { count: 0, bytes: 0 }
    for (const entry of plan) {
      if (!dirs.some((d) => entry.rel.startsWith(`${d}/`))) continue
      files.count += 1
      files.bytes += entry.bytes
    }
    stats.push({ id, tables, files })
  }
  return stats
}

// ── 기본값(electron) 지연 해석 ──

async function resolveDefaultPaths(): Promise<BackupPaths> {
  const { app } = await import('electron')
  const userDataDir = app.getPath('userData')
  return { userDataDir, dbPath: join(userDataDir, DB_FILE) }
}

async function resolveDefaultAppVersion(): Promise<string> {
  const { app } = await import('electron')
  return app.getVersion()
}

async function resolveSourceDb(): Promise<DatabaseLike> {
  const { getDatabase } = await import('../db/database')
  return getDatabase() as unknown as DatabaseLike
}

// ── DB 스냅샷 ──

/** VACUUM INTO는 SQL 리터럴이라 경로의 작은따옴표를 이스케이프해야 한다. */
function sqlQuote(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

/** **백업 사본**에서 캐시 테이블(CACHE_TABLES)의 행을 지운다. 원본에서 다시 받는 값이라 옮기지 않는다 */
export function stripCaches(db: DatabaseLike): void {
  for (const table of CACHE_TABLES) {
    if (tableExists(db, table)) db.exec(`DELETE FROM ${table}`)
  }
}

/**
 * 라이브 DB를 destPath에 일관된 사본으로 뜨고, 그 사본에서 시크릿을 지운다.
 * WAL이 켜져 있어도 안전하다(파일 복사와 달리 -wal을 신경 쓸 필요가 없다).
 * groups를 주면 빠지는 그룹의 행·설정 키를 사본에서 지운다(스키마는 남긴다).
 */
function snapshotDatabase(
  destPath: string,
  sourceDb: DatabaseLike,
  groups: readonly BackupGroupId[] = BACKUP_GROUP_IDS
): { excluded: string[]; tables: Record<string, number> } {
  sourceDb.exec(`VACUUM INTO ${sqlQuote(destPath)}`)

  const copy = new Database(destPath)
  try {
    // 백업 안에서는 단일 파일이어야 한다 — WAL을 끄면 -wal/-shm이 생기지 않는다.
    copy.pragma('journal_mode = DELETE')
    // **무엇이든 지우기 전에 FK를 끈다.** 켠 채로 projects를 지우면 사본 안의
    // meetings.project_id가 ON DELETE SET NULL로 지워져, 회의만 복원할 때 연결이 사라진다.
    copy.pragma('foreign_keys = OFF')
    const excluded = stripSecrets(copy as unknown as DatabaseLike)
    stripCaches(copy as unknown as DatabaseLike)
    if (!isAllGroups(groups)) {
      filterSnapshotGroups(copy as unknown as DatabaseLike, [...groups])
    }
    copy.exec('VACUUM') // 지운 시크릿이 free page에 남지 않도록 스크럽
    const tables = readTableCounts(copy as unknown as DatabaseLike)
    return { excluded, tables }
  } finally {
    copy.close()
  }
}

// ── zip 쓰기 ──

function shouldCompress(entryName: string): boolean {
  const lower = entryName.toLowerCase()
  return !STORED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * yazl은 fs.stat 실패 같은 오류를 ZipFile 자체에 emit하고 outputStream은 그대로 멈춘다.
 * 그래서 pipeline만 기다리면 영원히 매달린다 — 두 실패 경로를 함께 기다린다.
 */
async function writeZip(
  zipPath: string,
  entries: Array<{ src: string; name: string }>,
  manifest: BackupManifest,
  onBytes: (written: number) => void
): Promise<void> {
  const zip = new ZipFile()
  const failed = new Promise<never>((_, reject) => {
    zip.on('error', (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))))
  })
  failed.catch(() => {}) // race에서 져도 unhandled rejection이 되지 않게

  let written = 0
  const counter = new PassThrough()
  counter.on('data', (chunk: Buffer) => {
    written += chunk.length
    onBytes(written)
  })

  for (const entry of entries) {
    zip.addFile(entry.src, entry.name, { compress: shouldCompress(entry.name) })
  }
  // manifest는 **마지막 엔트리**다 — 존재 자체가 "끝까지 쓰였다"는 표시가 된다.
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'), MANIFEST_ENTRY, {
    compress: true
  })
  zip.end()

  const out = createWriteStream(zipPath)
  const piped = pipeline(zip.outputStream, counter, out)
  piped.catch(() => {}) // race에서 져도 unhandled rejection이 되지 않게
  try {
    await Promise.race([piped, failed])
  } catch (error) {
    // yazl이 error를 emit하면 outputStream은 끝나지 않는다 — 매달린 파일 핸들을 끊어 준다.
    out.destroy()
    throw error
  }
}

export async function exportBackup(
  zipPath: string,
  opts: ExportOptions = {}
): Promise<{ path: string; manifest: BackupManifest }> {
  // 그룹 검증은 아무것도 만들기 전에 한다 — 빈 선택으로 "빈 백업"을 만들면 안 된다.
  let groups: BackupGroupId[] = [...BACKUP_GROUP_IDS]
  if (opts.groups !== undefined) {
    const parsed = parseGroupsArg(opts.groups)
    if (!parsed.ok) throw new Error(parsed.error)
    groups = parsed.groups
  }
  const paths = opts.paths ?? (await resolveDefaultPaths())
  const sourceDb = opts.sourceDb ?? (await resolveSourceDb())
  const appVersion = opts.appVersion ?? (await resolveDefaultAppVersion())
  const report = (p: BackupProgress): void => opts.onProgress?.(p)

  const target = zipPath.toLowerCase().endsWith(BACKUP_FILE_EXTENSION)
    ? zipPath
    : `${zipPath}${BACKUP_FILE_EXTENSION}`
  // 저장 대화상자에서 **기존 백업을 "대체"로 고를 수 있다.** 그 경로에 바로 쓰기 시작하면
  // 스냅샷이나 파일 복사가 실패했을 때 옛 백업까지 함께 사라진다 — 새 백업을 못 만든 것과
  // 갖고 있던 백업을 잃는 것은 전혀 다른 사고다. 그래서 .part에 다 쓴 뒤 마지막에 이름만 바꾼다.
  const partPath = `${target}.part`

  const workDir = await mkdtemp(join(tmpdir(), 'linkwork-backup-'))
  try {
    // 1) DB 스냅샷 (임시 폴더에 만든 뒤 zip에 넣고 버린다)
    report({ phase: 'db', progress: 0.02, message: '데이터베이스 스냅샷을 만드는 중…' })
    const dbCopy = join(workDir, DB_FILE)
    const { excluded, tables } = snapshotDatabase(dbCopy, sourceDb, groups)
    const dbBytes = (await stat(dbCopy)).size

    // 2) 넣을 파일 목록과 manifest를 먼저 확정한다 (manifest는 마지막에 기록)
    //    파일은 포함한 그룹의 폴더만 담는다.
    const plan = await planFileCopies(paths.userDataDir, fileDirsForGroups(groups))
    const files = tallyFiles(plan)
    const manifest = buildManifest({ appVersion, dbBytes, tables, files, excluded, groups })

    // 3) 스트리밍으로 zip 기록. 진행률은 zip에 흘러나온 바이트 / 원본 총량 추정치.
    //    .wav를 비압축으로 저장하므로 이 추정치는 실제와 꽤 가깝다.
    const estimated = dbBytes + plan.reduce((sum, e) => sum + e.bytes, 0)
    report({
      phase: 'files',
      progress: 0.1,
      message: `파일 ${plan.length}개를 백업에 담는 중…`
    })
    await writeZip(
      partPath,
      [{ src: dbCopy, name: DB_FILE }, ...plan.map((e) => ({ src: e.src, name: e.rel }))],
      manifest,
      (written) => {
        const ratio = estimated > 0 ? Math.min(written / estimated, 1) : 1
        report({ phase: 'files', progress: 0.1 + ratio * 0.85, message: '백업 파일을 쓰는 중…' })
      }
    )

    // 끝까지 쓴 뒤에야 최종 이름을 차지한다. 같은 폴더 안의 rename이라 원자적이다.
    await rename(partPath, target)

    report({ phase: 'done', progress: 1, message: '내보내기 완료' })
    return { path: target, manifest }
  } catch (error) {
    // 만들다 만 .part만 지운다 — 반쯤 쓰인 백업을 나중에 복원하면 데이터가 사라진다.
    // 사용자가 "대체"로 고른 기존 파일은 **건드리지 않는다**(아직 이름을 바꾸기 전이다).
    await rm(partPath, { force: true }).catch(() => {})
    report({ phase: 'error', progress: 0, message: String(error) })
    throw error
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── zip 읽기 ──

/** yauzl이 던지는 영어 오류를 사용자가 읽을 수 있는 문장으로 바꾼다. */
function describeZipError(error: unknown, zipPath: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/invalid relative path|absolute path|invalid characters in fileName/.test(message)) {
    return new Error(
      `백업 파일에 안전하지 않은 경로의 항목이 있습니다 (${message}).\n손상됐거나 조작된 파일일 수 있어 복원하지 않습니다.`
    )
  }
  if (/end of central directory|signature|not a zip|Invalid|corrupt/i.test(message)) {
    return new Error(`백업 파일(.zip)을 열 수 없습니다: ${zipPath}\n${message}`)
  }
  return error instanceof Error ? error : new Error(message)
}

async function readEntryText(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  const stream = await zip.openReadStreamPromise(entry)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

interface ScannedZip {
  manifestEntry: yauzl.Entry | null
  hasDb: boolean
  counts: { recordings: number; attachments: number }
  /** 압축을 풀었을 때 필요한 총 바이트 (디스크 여유 확인용) */
  uncompressedBytes: number
}

/**
 * 엔트리를 한 번 훑는다. 여기서 zip slip 검사도 함께 한다 —
 * 이름이 위험한 항목이 하나라도 있으면 그 파일은 통째로 거부한다.
 */
type EntryKind = NonNullable<ReturnType<typeof classifyEntry>>

/** 선택 복원에서 풀 엔트리만 고른다. manifest·DB는 늘 포함. */
function entryFilter(dirs: readonly FileDir[]): (kind: EntryKind) => boolean {
  return (kind) =>
    kind === 'manifest' ||
    kind === 'db' ||
    (kind === 'recordings' && dirs.includes('recordings')) ||
    (kind === 'attachments' && dirs.includes('ai-attachments'))
}

async function scanZip(
  zip: yauzl.ZipFile,
  include: (kind: EntryKind) => boolean = () => true
): Promise<ScannedZip> {
  const result: ScannedZip = {
    manifestEntry: null,
    hasDb: false,
    counts: { recordings: 0, attachments: 0 },
    uncompressedBytes: 0
  }
  for await (const entry of zip.eachEntry()) {
    if (entry.fileName.endsWith('/')) continue // 디렉터리 엔트리는 만들지도, 풀지도 않는다
    assertSafeEntryName(entry.fileName)
    const kind = classifyEntry(entry.fileName)
    if (kind === null) continue // 모르는 항목은 세지도 풀지도 않는다
    if (!include(kind)) continue // 이번에 복원하지 않는 그룹의 파일
    result.uncompressedBytes += entry.uncompressedSize
    if (kind === 'manifest') result.manifestEntry = entry
    else if (kind === 'db') result.hasDb = true
    else result.counts[kind] += 1
  }
  return result
}

/**
 * 복원 전에 백업 파일이 온전한지 확인한다. 치명적인 문제는 throw, 복원은 가능하지만
 * 알아야 할 문제는 warnings로 돌려준다(예: manifest와 실제 파일 수가 다름).
 * manifest.json 외에는 내용을 읽지 않는다 — 2GB짜리를 훑는 화면이 되면 안 된다.
 */
export async function inspectBackup(
  zipPath: string,
  _opts: { paths?: BackupPaths } = {}
): Promise<BackupSummary> {
  let zip: yauzl.ZipFile
  try {
    zip = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false })
  } catch (error) {
    throw describeZipError(error, zipPath)
  }

  let scanned: ScannedZip
  let manifestText: string
  try {
    scanned = await scanZip(zip)
    if (!scanned.manifestEntry) {
      throw new Error(
        `백업 파일에 ${MANIFEST_ENTRY}이 없습니다. LinkWork 백업이 맞는지, 내보내기가 끝까지 됐는지 확인하세요.`
      )
    }
    manifestText = await readEntryText(zip, scanned.manifestEntry)
  } catch (error) {
    throw describeZipError(error, zipPath)
  } finally {
    zip.close()
  }

  let raw: unknown
  try {
    raw = JSON.parse(manifestText)
  } catch {
    throw new Error(`${MANIFEST_ENTRY}을 읽을 수 없습니다 (JSON 형식이 아닙니다).`)
  }

  const checked = validateManifest(raw)
  if (!checked.ok) throw new Error(checked.reason)
  const manifest = checked.manifest

  if (!scanned.hasDb) throw new Error(`백업에 ${DB_FILE}이 없습니다.`)

  const warnings: string[] = []
  for (const group of FILE_GROUPS) {
    const expected = manifest.files[group.key].count
    const actual = scanned.counts[group.key]
    if (actual !== expected) {
      warnings.push(`${group.dir}: 파일 ${expected}개가 기록됐는데 실제로는 ${actual}개입니다.`)
    }
  }

  return { path: zipPath, manifest, warnings }
}

// ── 압축 해제 ──

async function extractZip(
  zipPath: string,
  destDir: string,
  onBytes: (written: number) => void,
  include: (kind: EntryKind) => boolean = () => true
): Promise<void> {
  let zip: yauzl.ZipFile
  try {
    zip = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false })
  } catch (error) {
    throw describeZipError(error, zipPath)
  }

  let written = 0
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.endsWith('/')) continue
      assertSafeEntryName(entry.fileName)
      const kind = classifyEntry(entry.fileName)
      if (kind === null) continue // 모르는 항목은 풀지 않는다
      if (!include(kind)) continue // 이번에 복원하지 않는 그룹의 파일

      const dest = join(destDir, entry.fileName)
      assertInside(destDir, dest)
      await mkdir(dirname(dest), { recursive: true })

      const source = await zip.openReadStreamPromise(entry)
      const counter = new PassThrough()
      counter.on('data', (chunk: Buffer) => {
        written += chunk.length
        onBytes(written)
      })
      await pipeline(source, counter, createWriteStream(dest))
    }
  } catch (error) {
    throw describeZipError(error, zipPath)
  } finally {
    zip.close()
  }
}

/**
 * 압축 해제와 복사가 들어갈 자리가 있는지 미리 확인한다.
 * 없으면 파일을 반쯤 쓴 채로 ENOSPC를 만나는데, 그때는 이미 DB를 갈아치운 뒤일 수 있다.
 * 같은 볼륨이면 필요한 양을 합산한다(tmp에 풀고 userData로 복사 → 한동안 두 벌이 공존).
 */
async function assertFreeSpace(needs: Array<{ dir: string; bytes: number }>): Promise<void> {
  const perDevice = new Map<number, { bytes: number; dir: string }>()
  for (const need of needs) {
    let device: number
    try {
      device = (await stat(need.dir)).dev
    } catch {
      continue // 아직 없는 폴더는 상위가 만들어 준다 — 확인을 건너뛴다
    }
    const acc = perDevice.get(device)
    if (acc) acc.bytes += need.bytes
    else perDevice.set(device, { bytes: need.bytes, dir: need.dir })
  }

  for (const { bytes, dir } of perDevice.values()) {
    let free: number
    try {
      const fsStat = await statfs(dir)
      free = Number(fsStat.bavail) * Number(fsStat.bsize)
    } catch {
      continue // statfs를 못 쓰는 환경이면 확인을 건너뛴다 (복원 자체를 막지는 않는다)
    }
    const required = bytes * 1.05 + 64 * 1024 * 1024 // 여유 5% + 64MB
    if (free < required) {
      const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)}GB`
      throw new Error(
        `디스크 여유 공간이 부족합니다. ${dir}에 ${gb(required)}가 필요한데 ${gb(free)}만 남아 있습니다.\n` +
          '공간을 확보한 뒤 다시 시도하세요. (복원은 백업을 임시 폴더에 푼 뒤 옮기므로 잠시 두 벌이 필요합니다.)'
      )
    }
  }
}

// ── 복원 ──

function scaleProgress(
  report: (p: BackupProgress) => void,
  from: number,
  to: number
): (p: BackupProgress) => void {
  return (p) => {
    if (p.phase === 'error') return report(p)
    report({ ...p, progress: from + Math.min(Math.max(p.progress, 0), 1) * (to - from) })
  }
}

/**
 * 요청 그룹을 검증한다: 비어 있지 않고, 아는 id이며, 백업에 든 그룹의 부분집합이어야 한다.
 * 실패는 throw — **DB를 닫기 전에** 불러야 한다(아무것도 바꾸지 않고 거부).
 */
function resolveRestoreGroups(
  requested: readonly BackupGroupId[] | undefined,
  available: readonly BackupGroupId[]
): BackupGroupId[] {
  if (requested === undefined) return [...available]
  const groups = normalizeGroups(requested)
  if (!groups) throw new Error('복원할 항목을 하나 이상 올바르게 선택하세요.')
  const missing = groups.filter((g) => !available.includes(g))
  if (missing.length > 0) {
    throw new Error(`이 백업에 없는 항목은 복원할 수 없습니다: ${missing.join(', ')}`)
  }
  return groups
}

/**
 * 같은 이름의 기존 파일을 `userData/<dir>.bak-<시각>/`로 옮긴 뒤 백업 파일을 복사한다.
 * 같은 볼륨 안의 rename이라 빠르고, 덮어쓴 녹음을 되돌릴 수 있다.
 * 같은 폴더의 다른 파일은 지우지 않는다.
 */
async function copyFilesWithBackup(
  plan: FileCopyPlanEntry[],
  userDataDir: string,
  stamp: string,
  onCopied: (bytes: number) => void
): Promise<void> {
  const madeBakDirs = new Set<string>()
  for (const entry of plan) {
    const dest = join(userDataDir, entry.rel)
    assertInside(userDataDir, dest)
    if (existsSync(dest)) {
      const [dir, name] = entry.rel.split('/')
      const bakDir = join(userDataDir, `${dir}.bak-${stamp}`)
      if (!madeBakDirs.has(bakDir)) {
        await mkdir(bakDir, { recursive: true })
        madeBakDirs.add(bakDir)
      }
      await rename(dest, join(bakDir, name))
    }
    await copyFile(entry.src, dest)
    onCopied(entry.bytes)
  }
}

/**
 * 압축을 푼 폴더의 백업으로 **선택한 그룹만** 교체한다 (zip 층 없이도 테스트할 수 있게 분리).
 * 선택하지 않은 그룹은 행도 파일도 바꾸지 않는다. 순서는 docs/DATA_BACKUP.md §3:
 *   1) 백업 DB 사본을 현재 스키마까지 올리고(applySchema) 모르는 테이블·컬럼이면 거부 — **닫기 전**
 *   2) 라이브 DB를 닫고 .bak-<시각>으로 보관
 *   3) 라이브 파일을 제자리에서 한 트랜잭션으로 고친다(실패하면 ROLLBACK, 라이브는 그대로)
 *   4) 커밋 뒤 선택 그룹의 파일을 복사(같은 이름은 <dir>.bak-<시각>/로 먼저 옮긴다)
 * DB를 다시 열지 않는다 — 호출측이 app.relaunch()로 재시작한다.
 */
async function restoreFromFolder(dir: string, opts: ImportOptions): Promise<ImportResult> {
  const paths = opts.paths ?? (await resolveDefaultPaths())
  const report = (p: BackupProgress): void => opts.onProgress?.(p)

  const groups = resolveRestoreGroups(opts.groups, BACKUP_GROUP_IDS)

  const sourceDbPath = join(dir, DB_FILE)
  if (!existsSync(sourceDbPath)) throw new Error(`복원할 ${DB_FILE}을 찾지 못했습니다.`)
  const liveExists = existsSync(paths.dbPath)
  // 라이브 DB 가 없으면(새 기기) 빈 스키마 DB 를 임시로 만들어 같은 경로(검사·병합)를 탄다.
  // 그냥 사본을 복사하면 고르지 않은 그룹과 refs 표까지 들어오고 모르는 스키마도 검사되지 않는다.
  const blank = liveExists ? null : await makeBlankLiveDb()

  try {
    // 1) 백업 사본을 현재 스키마로 올린다. 라이브를 닫기 전이라 실패해도 바뀌는 것이 없다.
    report({ phase: 'db', progress: 0.05, message: '백업 데이터베이스를 확인하는 중…' })
    const liveTarget = blank ? blank.dbPath : paths.dbPath
    prepareBackupDb(sourceDbPath, liveTarget)

    // 2) **먼저 핸들을 닫는다.** WAL이 켜져 있어 최근 쓰기가 -wal에만 있을 수 있는데,
    //    닫기 전에 linkwork.db만 복사하면 보관본에 그 내용이 빠진다(= 되돌릴 수 없는 보관본).
    //    깨끗한 close는 WAL을 체크포인트해 본 파일에 합쳐 준다.
    report({ phase: 'db', progress: 0.1, message: '현재 데이터베이스를 보관하는 중…' })
    opts.closeDb()
    opts.onDbClosed?.()

    const stamp = backupStamp()
    let restoredDbBackupPath = ''
    if (liveExists) {
      restoredDbBackupPath = `${paths.dbPath}.bak-${stamp}`
      await copyFile(paths.dbPath, restoredDbBackupPath)
      opts.onRollbackPointCreated?.(restoredDbBackupPath)
    }

    // 3) 선택 그룹의 테이블을 교체한다. 파일을 갈아끼우지 않고 제자리에서 고치므로
    //    -wal/-shm은 **지우지 않는다**(남은 프레임을 잃을 수 있다).
    report({ phase: 'db', progress: 0.25, message: '데이터베이스를 복원하는 중…' })
    const warnings: string[] = []
    const merged = mergeBackupIntoLive(liveTarget, sourceDbPath, groups)
    warnings.push(...merged.warnings)
    if (blank) {
      // 새 기기: 병합이 끝난 빈 DB 를 자리에 둔다. 스키마 설정·시드는 재시작 때 initDatabase 가 한다.
      await mkdir(dirname(paths.dbPath), { recursive: true })
      await copyFile(blank.dbPath, paths.dbPath)
    }

    // 4) 선택 그룹의 녹음·첨부 복사
    const dirs = fileDirsForGroups(groups)
    const plan = await planFileCopies(dir, dirs)
    const totalBytes = plan.reduce((sum, e) => sum + e.bytes, 0)
    for (const d of dirs) {
      await mkdir(join(paths.userDataDir, d), { recursive: true })
    }
    let copied = 0
    report({ phase: 'files', progress: 0.3, message: `파일 ${plan.length}개를 복원하는 중…` })
    await copyFilesWithBackup(plan, paths.userDataDir, stamp, (bytes) => {
      copied += bytes
      report({
        phase: 'files',
        progress: totalBytes > 0 ? 0.3 + (copied / totalBytes) * 0.7 : 0.95,
        message: '파일 복원 중…'
      })
    })

    return { restoredDbBackupPath, groups, warnings }
  } finally {
    if (blank) await rm(blank.dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 라이브 DB 가 없을 때 쓸 빈 스키마 DB 를 임시 폴더에 만든다(새 기기의 복원 대상). */
async function makeBlankLiveDb(): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'linkwork-blank-'))
  const dbPath = join(dir, DB_FILE)
  const blank = new Database(dbPath)
  try {
    applySchema(blank)
  } finally {
    blank.close()
  }
  return { dir, dbPath }
}

/**
 * 백업 .zip에서 **선택한 그룹만** 현재 앱 데이터에 교체해 넣는다.
 * DB를 닫기 전에 그룹 검증·여유 공간 확인·압축 해제를 끝낸다 — 여기서 실패하면 바뀌는 것이 없다.
 * zip은 os.tmpdir에 풀고(DB와 선택 그룹의 파일만) 끝나면 임시 폴더를 지운다.
 */
export async function importBackup(zipPath: string, opts: ImportOptions): Promise<ImportResult> {
  const paths = opts.paths ?? (await resolveDefaultPaths())
  const report = (p: BackupProgress): void => opts.onProgress?.(p)

  report({ phase: 'db', progress: 0.02, message: '백업 파일을 확인하는 중…' })
  const { manifest } = await inspectBackup(zipPath, { paths })
  const groups = resolveRestoreGroups(opts.groups, manifest.groups)
  const include = entryFilter(fileDirsForGroups(groups))

  // 압축 해제에 얼마나 필요한지 다시 훑는다 (inspect는 요약만 돌려준다)
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false })
  let needed: number
  try {
    needed = (await scanZip(zip, include)).uncompressedBytes
  } finally {
    zip.close()
  }
  await assertFreeSpace([
    { dir: tmpdir(), bytes: needed },
    { dir: paths.userDataDir, bytes: needed }
  ])

  const workDir = await mkdtemp(join(tmpdir(), 'linkwork-restore-'))
  try {
    report({ phase: 'files', progress: 0.05, message: '백업 파일을 푸는 중…' })
    await extractZip(
      zipPath,
      workDir,
      (written) => {
        const ratio = needed > 0 ? Math.min(written / needed, 1) : 1
        report({ phase: 'files', progress: 0.05 + ratio * 0.4, message: '백업 파일을 푸는 중…' })
      },
      include
    )

    return await restoreFromFolder(workDir, {
      ...opts,
      groups,
      paths,
      onProgress: scaleProgress(report, 0.45, 0.98)
    })
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
