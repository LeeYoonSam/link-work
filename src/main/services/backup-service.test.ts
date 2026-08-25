import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWriteStream, existsSync } from 'fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { createHash, randomBytes } from 'crypto'
import { crc32 } from 'zlib'
import * as yauzl from 'yauzl'
import { ZipFile } from 'yazl'

// better-sqlite3는 electron-builder가 Electron ABI로 빌드해 두므로 vitest가 도는 Node에서는
// 로드할 수 없다. release-note-sync.test.ts와 같은 방식으로 node:sqlite로 갈아끼우되,
// **경로를 무시하지 않는다** — 이 테스트는 VACUUM INTO로 뜬 파일 사본을 zip에 담고 다시 푸는
// 흐름을 검증하므로 인메모리로는 아무 의미가 없다.
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  type Args = unknown[]

  class BetterSqlite3Shim {
    private readonly db: InstanceType<typeof DatabaseSync>

    constructor(path: string, options?: { readonly?: boolean }) {
      // node:sqlite는 두 번째 인자로 undefined를 받지 못한다 — 필요할 때만 넘긴다.
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

    transaction<T>(fn: (...args: Args) => T): (...args: Args) => T {
      return (...args: Args): T => {
        this.db.exec('BEGIN')
        try {
          const result = fn(...args)
          this.db.exec('COMMIT')
          return result
        } catch (e) {
          this.db.exec('ROLLBACK')
          throw e
        }
      }
    }

    close(): void {
      this.db.close()
    }
  }

  return { default: BetterSqlite3Shim }
})

// db/database.ts가 app.getPath('userData')로 DB 경로를 정하므로, 테스트가 그 경로를 바꿔 가며
// "두 대의 PC"(원본 userData / 복원 대상 userData)를 흉내 낸다.
const electronState = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userData,
    getVersion: () => '1.0.0-test'
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

import Database from 'better-sqlite3'
import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import {
  BACKUP_FORMAT_VERSION,
  DB_FILE,
  MANIFEST_ENTRY,
  SECRET_SETTING_KEYS,
  buildManifest,
  classifyEntry,
  defaultBackupFileName,
  exportBackup,
  importBackup,
  inspectBackup,
  isSafeEntryName,
  planFileCopies,
  stripSecrets,
  validateManifest,
  type BackupPaths,
  type BackupProgress,
  type DatabaseLike
} from './backup-service'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function pathsFor(userDataDir: string): BackupPaths {
  return { userDataDir, dbPath: join(userDataDir, DB_FILE) }
}

/** 사람이 읽는 요약이 아니라 실제 행을 확인하기 위해 DB를 직접 연다. */
function openDb(path: string): InstanceType<typeof Database> {
  return new Database(path)
}

// ── zip 헬퍼 ──

interface ZipEntryInfo {
  name: string
  /** 0 = 저장(비압축), 8 = deflate */
  method: number
  size: number
}

async function listZipEntries(zipPath: string): Promise<ZipEntryInfo[]> {
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false })
  const out: ZipEntryInfo[] = []
  try {
    for await (const entry of zip.eachEntry()) {
      out.push({
        name: entry.fileName,
        method: entry.compressionMethod,
        size: entry.uncompressedSize
      })
    }
  } finally {
    zip.close()
  }
  return out
}

async function readZipEntry(zipPath: string, entryName: string): Promise<Buffer> {
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false })
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName !== entryName) continue
      const stream = await zip.openReadStreamPromise(entry)
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks)
    }
  } finally {
    zip.close()
  }
  throw new Error(`엔트리를 찾지 못했습니다: ${entryName}`)
}

async function extractZipEntryToFile(
  zipPath: string,
  entryName: string,
  destPath: string
): Promise<void> {
  await writeFile(destPath, await readZipEntry(zipPath, entryName))
}

/** yazl로 정상 zip을 만든다 (실패 케이스 픽스처용) */
async function writeSimpleZip(
  zipPath: string,
  entries: Array<{ name: string; content: string }>
): Promise<void> {
  const zip = new ZipFile()
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.content, 'utf-8'), entry.name)
  }
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(zipPath))
}

/**
 * **직접 바이트를 써서** zip을 만든다. yazl은 `../`가 든 엔트리 이름을 만들어 주지 않으므로
 * (validateMetadataPath에서 거부), zip slip 방어를 검증하려면 이렇게 손으로 만들어야 한다.
 * 모든 엔트리는 저장(method 0) 방식이다.
 */
async function writeRawZip(
  zipPath: string,
  entries: Array<{ name: string; content: string }>
): Promise<void> {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8')
    const data = Buffer.from(entry.content, 'utf-8')
    const crc = crc32(data)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0) // local file header signature
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0x0800, 6) // general purpose flag: UTF-8 이름
    header.writeUInt16LE(0, 8) // compression method: stored
    header.writeUInt16LE(0, 10) // mod time
    header.writeUInt16LE(0x21, 12) // mod date (1980-01-01)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18) // compressed size
    header.writeUInt32LE(data.length, 22) // uncompressed size
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28) // extra field length
    local.push(header, name, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // central directory signature
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk number start
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42) // relative offset of local header
    central.push(cd, name)

    offset += header.length + name.length + data.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // disk with central directory
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  await writeFile(zipPath, Buffer.concat([...local, centralBuf, eocd]))
}

afterAll(async () => {
  closeDatabase()
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('validateManifest', () => {
  const valid = buildManifest({
    appVersion: '1.0.0',
    dbBytes: 1024,
    tables: { projects: 2 },
    files: { recordings: { count: 1, bytes: 10 }, attachments: { count: 0, bytes: 0 } },
    excluded: ['auth_tokens']
  })

  it('정상 manifest를 통과시킨다', () => {
    const result = validateManifest(JSON.parse(JSON.stringify(valid)))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.formatVersion).toBe(BACKUP_FORMAT_VERSION)
      expect(result.manifest.db.tables.projects).toBe(2)
    }
  })

  it('format이 다르면 거부한다', () => {
    const result = validateManifest({ ...valid, format: 'something-else' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('format')
  })

  it('앱보다 새로운 formatVersion은 거부한다', () => {
    const result = validateManifest({ ...valid, formatVersion: BACKUP_FORMAT_VERSION + 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('업데이트')
  })

  it('필수 필드가 없으면 거부한다', () => {
    const missingDb = { ...valid } as Record<string, unknown>
    delete missingDb.db
    const result = validateManifest(missingDb)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('db')

    const missingFiles = { ...valid } as Record<string, unknown>
    delete missingFiles.files
    expect(validateManifest(missingFiles).ok).toBe(false)

    expect(validateManifest(null).ok).toBe(false)
    expect(validateManifest('nope').ok).toBe(false)
  })
})

describe('엔트리 이름 검사 (zip slip 방어)', () => {
  it('정상 엔트리만 통과시킨다', () => {
    expect(isSafeEntryName('manifest.json')).toBe(true)
    expect(isSafeEntryName('linkwork.db')).toBe(true)
    expect(isSafeEntryName('recordings/12.wav')).toBe(true)

    expect(isSafeEntryName('../evil.txt')).toBe(false)
    expect(isSafeEntryName('recordings/../../evil.txt')).toBe(false)
    expect(isSafeEntryName('/etc/passwd')).toBe(false)
    expect(isSafeEntryName('C:\\evil.txt')).toBe(false)
    expect(isSafeEntryName('recordings\\evil.wav')).toBe(false)
    expect(isSafeEntryName('recordings//evil.wav')).toBe(false)
    expect(isSafeEntryName('evil\0.txt')).toBe(false)
    expect(isSafeEntryName('')).toBe(false)
  })

  it('우리가 만든 백업에 들어 있어야 하는 엔트리만 분류한다', () => {
    expect(classifyEntry('manifest.json')).toBe('manifest')
    expect(classifyEntry('linkwork.db')).toBe('db')
    expect(classifyEntry('recordings/a.wav')).toBe('recordings')
    expect(classifyEntry('ai-attachments/a.png')).toBe('attachments')
    // 하위 폴더나 모르는 위치는 대상이 아니다
    expect(classifyEntry('recordings/sub/a.wav')).toBeNull()
    expect(classifyEntry('models/big.bin')).toBeNull()
  })
})

describe('stripSecrets', () => {
  it('기기 종속 시크릿만 지우고 평문 설정은 남긴다', async () => {
    const dir = await makeTempDir('lw-strip-')
    const db = openDb(join(dir, 'x.db'))
    db.exec(`
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE auth_tokens (id INTEGER PRIMARY KEY, provider TEXT, access_token TEXT);
      INSERT INTO app_settings (key, value) VALUES ('notion_token', 'enc-notion');
      INSERT INTO app_settings (key, value) VALUES ('jira_api_token', 'enc-jira');
      INSERT INTO app_settings (key, value) VALUES ('jira_site_url', 'https://x.atlassian.net');
      INSERT INTO app_settings (key, value) VALUES ('google_client_id', 'plain-id');
      INSERT INTO auth_tokens (id, provider, access_token) VALUES (1, 'google', 'enc-token');
    `)

    const removed = stripSecrets(db as unknown as DatabaseLike)

    expect(removed).toContain('auth_tokens')
    expect(removed).toContain('app_settings:notion_token')
    expect(removed).toContain('app_settings:jira_api_token')

    const keys = (
      db.prepare('SELECT key FROM app_settings ORDER BY key').all() as { key: string }[]
    ).map((r) => r.key)
    expect(keys).toEqual(['google_client_id', 'jira_site_url'])

    // 테이블 자체는 남는다 — 스키마가 달라지면 복원 후 마이그레이션이 꼬인다
    const authRows = db.prepare('SELECT COUNT(*) AS c FROM auth_tokens').all() as { c: number }[]
    expect(authRows[0].c).toBe(0)
    db.close()
  })

  it('테이블이 없는 구버전 DB에서도 터지지 않는다', async () => {
    const dir = await makeTempDir('lw-strip-old-')
    const db = openDb(join(dir, 'old.db'))
    db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY)')
    expect(stripSecrets(db as unknown as DatabaseLike)).toEqual([])
    db.close()
  })
})

describe('planFileCopies', () => {
  it('recordings·ai-attachments의 바로 아래 파일만 모으고 models/·숨김 파일은 뺀다', async () => {
    const userData = await makeTempDir('lw-plan-')
    await mkdir(join(userData, 'recordings', 'sub'), { recursive: true })
    await mkdir(join(userData, 'ai-attachments'), { recursive: true })
    await mkdir(join(userData, 'models'), { recursive: true })
    await writeFile(join(userData, 'recordings', '1.wav'), 'aaaa')
    await writeFile(join(userData, 'recordings', '1.channels.json'), '[]')
    await writeFile(join(userData, 'recordings', '.DS_Store'), 'x')
    await writeFile(join(userData, 'recordings', 'sub', 'nested.wav'), 'x')
    await writeFile(join(userData, 'ai-attachments', 'a.png'), 'img')
    await writeFile(join(userData, 'models', 'big.bin'), 'model')

    const plan = await planFileCopies(userData)
    const rels = plan.map((e) => e.rel).sort()
    expect(rels).toEqual(['ai-attachments/a.png', 'recordings/1.channels.json', 'recordings/1.wav'])
    expect(plan.find((e) => e.rel === 'recordings/1.wav')?.bytes).toBe(4)
  })

  it('폴더가 아예 없으면 빈 계획을 돌려준다', async () => {
    const userData = await makeTempDir('lw-plan-empty-')
    expect(await planFileCopies(userData)).toEqual([])
  })
})

describe('defaultBackupFileName', () => {
  it('LinkWork-backup-YYYYMMDD-HHmmss.zip 형태다', () => {
    const name = defaultBackupFileName(new Date(2026, 7, 25, 10, 30, 0))
    expect(name).toBe('LinkWork-backup-20260825-103000.zip')
  })
})

describe('export → inspect → import 라운드트립 (.zip)', () => {
  let sourceUserData: string
  let outDir: string
  let zipPath: string
  let bigAudio: Buffer

  beforeAll(async () => {
    sourceUserData = await makeTempDir('lw-src-')
    outDir = await makeTempDir('lw-out-')

    // 실제 스키마로 원본 DB를 만든다 (DDL을 테스트에 복사하지 않는다)
    electronState.userData = sourceUserData
    initDatabase()
    const db = getDatabase()
    db.exec(`
      INSERT INTO projects (name, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date)
      VALUES ('백업 대상', '2026-01-01', '2026-01-10', '2026-01-11', '2026-01-15', '2026-01-16');
      INSERT INTO todos (title) VALUES ('할 일 1'), ('할 일 2');
      INSERT INTO app_settings (key, value) VALUES ('notion_token', 'enc-notion');
      INSERT INTO app_settings (key, value) VALUES ('jira_api_token', 'enc-jira');
      INSERT INTO app_settings (key, value) VALUES ('google_client_id', 'plain-client-id');
      INSERT INTO auth_tokens (id, provider, access_token) VALUES (1, 'google', 'enc-access');
      INSERT INTO meetings (title, status, audio_path) VALUES ('회의', 'done', 'rec-1.wav');
    `)

    await mkdir(join(sourceUserData, 'recordings'), { recursive: true })
    await mkdir(join(sourceUserData, 'ai-attachments'), { recursive: true })
    await writeFile(join(sourceUserData, 'recordings', 'rec-1.wav'), 'RIFF-fake-audio')
    await writeFile(join(sourceUserData, 'recordings', 'rec-1.channels.json'), '{"ch":1}')
    await writeFile(join(sourceUserData, 'ai-attachments', 'shot.png'), 'PNG-fake')
    // 실제 녹음은 수백 MB~GB다. 한 청크에 들어가지 않는 파일을 하나 넣어 스트리밍 경로
    // (PassThrough 누적 · pipeline · 저장 방식 엔트리)를 여러 청크로 실제로 태운다.
    bigAudio = randomBytes(4 * 1024 * 1024)
    await writeFile(join(sourceUserData, 'recordings', 'rec-2.wav'), bigAudio)
  })

  it('exportBackup이 시크릿을 뺀 DB와 파일을 담은 .zip 하나를 만든다', async () => {
    const events: BackupProgress[] = []
    const result = await exportBackup(join(outDir, 'my-backup'), {
      paths: pathsFor(sourceUserData),
      sourceDb: getDatabase(),
      appVersion: '9.9.9',
      onProgress: (p) => events.push(p)
    })
    zipPath = result.path

    // 확장자가 없으면 붙여 준다
    expect(zipPath).toBe(join(outDir, 'my-backup.zip'))
    expect(existsSync(zipPath)).toBe(true)
    // 폴더가 아니라 파일 하나만 남는다
    expect(await readdir(outDir)).toEqual(['my-backup.zip'])

    const manifest = result.manifest
    expect(manifest.appVersion).toBe('9.9.9')
    expect(manifest.formatVersion).toBe(BACKUP_FORMAT_VERSION)
    expect(manifest.db.tables.projects).toBe(1)
    expect(manifest.db.tables.todos).toBe(2)
    expect(manifest.files.recordings.count).toBe(3)
    expect(manifest.files.recordings.bytes).toBe(bigAudio.length + 'RIFF-fake-audio'.length + '{"ch":1}'.length)
    expect(manifest.files.attachments.count).toBe(1)
    expect(manifest.excluded).toContain('auth_tokens')
    for (const key of SECRET_SETTING_KEYS) {
      expect(manifest.excluded).toContain(`app_settings:${key}`)
    }

    const entries = await listZipEntries(zipPath)
    const names = entries.map((e) => e.name)
    expect(names).toContain(DB_FILE)
    expect(names).toContain('recordings/rec-1.wav')
    expect(names).toContain('recordings/rec-1.channels.json')
    expect(names).toContain('ai-attachments/shot.png')
    // manifest는 마지막 엔트리 — 존재 자체가 "끝까지 쓰였다"는 표시다
    expect(names.at(-1)).toBe(MANIFEST_ENTRY)
    // .wav와 .png는 저장(method 0), DB와 json은 deflate(method 8)
    expect(entries.find((e) => e.name === 'recordings/rec-1.wav')?.method).toBe(0)
    expect(entries.find((e) => e.name === 'recordings/rec-2.wav')?.method).toBe(0)
    expect(entries.find((e) => e.name === 'recordings/rec-2.wav')?.size).toBe(bigAudio.length)
    expect(entries.find((e) => e.name === 'ai-attachments/shot.png')?.method).toBe(0)
    expect(entries.find((e) => e.name === DB_FILE)?.method).toBe(8)
    expect(entries.find((e) => e.name === 'recordings/rec-1.channels.json')?.method).toBe(8)

    // zip 안의 manifest도 같은 내용이어야 한다
    const inZip = JSON.parse((await readZipEntry(zipPath, MANIFEST_ENTRY)).toString('utf-8'))
    expect(validateManifest(inZip).ok).toBe(true)
    expect(inZip.appVersion).toBe('9.9.9')

    // 진행률은 단조 증가하고 1.0/done으로 끝난다
    expect(events.at(-1)).toMatchObject({ phase: 'done', progress: 1 })
    expect(events.every((e, i) => i === 0 || e.progress >= events[i - 1].progress)).toBe(true)
    // 4MB 파일은 한 청크에 담기지 않으므로 진행률이 여러 번 갱신돼야 한다
    expect(new Set(events.map((e) => e.progress)).size).toBeGreaterThan(5)

    // zip 안의 DB에서 시크릿만 사라졌는지 직접 확인
    const scratch = await makeTempDir('lw-peek-')
    const dbCopy = join(scratch, 'peek.db')
    await extractZipEntryToFile(zipPath, DB_FILE, dbCopy)
    const copy = openDb(dbCopy)
    const settings = (copy.prepare('SELECT key FROM app_settings').all() as { key: string }[]).map(
      (r) => r.key
    )
    expect(settings).toEqual(['google_client_id'])
    const auth = copy.prepare('SELECT COUNT(*) AS c FROM auth_tokens').all() as { c: number }[]
    expect(auth[0].c).toBe(0)
    const projects = copy.prepare('SELECT name FROM projects').all() as { name: string }[]
    expect(projects[0].name).toBe('백업 대상')
    copy.close()

    // 원본은 그대로 (사본에서만 지운다)
    const liveAuth = getDatabase().prepare('SELECT COUNT(*) AS c FROM auth_tokens').get() as {
      c: number
    }
    expect(liveAuth.c).toBe(1)
  })

  it('inspectBackup이 manifest를 검증하고 요약을 돌려준다', async () => {
    const summary = await inspectBackup(zipPath)
    expect(summary.path).toBe(zipPath)
    expect(summary.manifest.db.tables.projects).toBe(1)
    expect(summary.manifest.files.recordings.count).toBe(3)
    // 파일 수가 manifest와 일치하므로 경고가 없다
    expect(summary.warnings).toEqual([])
  })

  it('importBackup이 현재 DB를 .bak으로 남기고 백업으로 대체한다', async () => {
    const targetUserData = await makeTempDir('lw-dst-')

    // "새 PC": 빈 상태로 앱이 한 번 뜬 뒤 복원한다고 가정
    closeDatabase()
    electronState.userData = targetUserData
    initDatabase()
    getDatabase().exec("INSERT INTO todos (title) VALUES ('새 PC의 기존 할 일')")

    // os.tmpdir는 이 프로세스 것이 아니다 — 다른 vitest 실행이나 예전 크래시가 남긴
    // linkwork-restore-*까지 세면 엉뚱하게 실패한다. **이번 복원이 새로 만든 것**만 본다.
    const restoreDirsBefore = new Set(
      (await readdir(tmpdir())).filter((n) => n.startsWith('linkwork-restore-'))
    )

    const events: BackupProgress[] = []
    const { restoredDbBackupPath } = await importBackup(zipPath, {
      paths: pathsFor(targetUserData),
      closeDb: closeDatabase,
      onProgress: (p) => events.push(p)
    })

    expect(restoredDbBackupPath).toContain(`${DB_FILE}.bak-`)
    expect(existsSync(restoredDbBackupPath)).toBe(true)
    // WAL 잔재를 지웠는지 — 남으면 새 DB 파일 위에 옛 WAL이 재생된다
    expect(existsSync(`${join(targetUserData, DB_FILE)}-wal`)).toBe(false)
    expect(events.some((e) => e.phase === 'files')).toBe(true)
    expect(events.every((e, i) => i === 0 || e.progress >= events[i - 1].progress)).toBe(true)

    // 복원된 DB는 백업의 내용이다
    const restored = openDb(join(targetUserData, DB_FILE))
    const projects = restored.prepare('SELECT name FROM projects').all() as { name: string }[]
    expect(projects.map((p) => p.name)).toEqual(['백업 대상'])
    const todos = restored.prepare('SELECT title FROM todos ORDER BY id').all() as {
      title: string
    }[]
    expect(todos.map((t) => t.title)).toEqual(['할 일 1', '할 일 2'])
    restored.close()

    // 보관본은 복원 전 상태를 담고 있다
    const bak = openDb(restoredDbBackupPath)
    const bakTodos = bak.prepare('SELECT title FROM todos').all() as { title: string }[]
    expect(bakTodos.map((t) => t.title)).toEqual(['새 PC의 기존 할 일'])
    bak.close()

    // 녹음·첨부도 옮겨졌고 내용까지 같다
    const recordings = (await readdir(join(targetUserData, 'recordings'))).sort()
    expect(recordings).toEqual(['rec-1.channels.json', 'rec-1.wav', 'rec-2.wav'])
    expect(await readFile(join(targetUserData, 'recordings', 'rec-1.wav'), 'utf-8')).toBe(
      'RIFF-fake-audio'
    )
    // 4MB 녹음이 압축·해제를 거쳐 바이트 하나 틀리지 않고 돌아왔는지
    const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')
    expect(sha(await readFile(join(targetUserData, 'recordings', 'rec-2.wav')))).toBe(sha(bigAudio))
    expect(existsSync(join(targetUserData, 'ai-attachments', 'shot.png'))).toBe(true)

    // 압축을 푼 임시 폴더를 남기지 않는다 (2GB짜리가 그대로 쌓이면 디스크가 찬다)
    const leftovers = (await readdir(tmpdir())).filter(
      (n) => n.startsWith('linkwork-restore-') && !restoreDirsBefore.has(n)
    )
    expect(leftovers).toEqual([])
  })
})

describe('실패 처리', () => {
  it('manifest가 없는 zip은 inspectBackup이 거부한다', async () => {
    const dir = await makeTempDir('lw-bad-')
    const zipPath = join(dir, 'no-manifest.zip')
    await writeSimpleZip(zipPath, [{ name: DB_FILE, content: 'not really a db' }])
    await expect(inspectBackup(zipPath)).rejects.toThrow(/manifest\.json/)
  })

  it('다른 앱의 manifest를 가진 zip은 거부한다', async () => {
    const dir = await makeTempDir('lw-other-')
    const zipPath = join(dir, 'other.zip')
    await writeSimpleZip(zipPath, [
      { name: DB_FILE, content: 'x' },
      { name: MANIFEST_ENTRY, content: JSON.stringify({ format: 'other-app' }) }
    ])
    await expect(inspectBackup(zipPath)).rejects.toThrow(/LinkWork 백업 파일이 아닙니다/)
  })

  it('zip이 아닌 파일은 읽을 수 없다고 알린다', async () => {
    const dir = await makeTempDir('lw-notzip-')
    const notZip = join(dir, 'plain.zip')
    await writeFile(notZip, '이건 그냥 텍스트입니다')
    await expect(inspectBackup(notZip)).rejects.toThrow(/열 수 없습니다/)
  })

  it('zip slip: 대상 폴더를 벗어나는 엔트리를 가진 zip은 inspect·import 모두 거부한다', async () => {
    const dir = await makeTempDir('lw-slip-')
    const zipPath = join(dir, 'evil.zip')
    // yazl은 '../'가 든 이름을 만들어 주지 않으므로 zip 바이트를 직접 쓴다
    await writeRawZip(zipPath, [
      { name: DB_FILE, content: 'x' },
      { name: '../evil.txt', content: 'pwned' },
      {
        name: MANIFEST_ENTRY,
        content: JSON.stringify(
          buildManifest({
            appVersion: '1.0.0',
            dbBytes: 1,
            tables: {},
            files: {
              recordings: { count: 0, bytes: 0 },
              attachments: { count: 0, bytes: 0 }
            },
            excluded: []
          })
        )
      }
    ])

    await expect(inspectBackup(zipPath)).rejects.toThrow(/안전하지 않은 경로/)

    const targetUserData = await makeTempDir('lw-slip-dst-')
    await expect(
      importBackup(zipPath, {
        paths: pathsFor(targetUserData),
        closeDb: () => {
          throw new Error('여기까지 오면 안 된다 — 검사 전에 DB를 닫았다')
        }
      })
    ).rejects.toThrow(/안전하지 않은 경로/)

    // 대상 폴더 밖에 아무것도 쓰이지 않았다
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false)
    expect(existsSync(join(targetUserData, '..', 'evil.txt'))).toBe(false)
  })

  it('DB 스냅샷이 실패하면 만들다 만 zip을 지운다', async () => {
    const outDir = await makeTempDir('lw-fail-db-')
    const userData = await makeTempDir('lw-fail-src-')
    const brokenDb: DatabaseLike = {
      exec: () => {
        throw new Error('disk I/O error')
      },
      prepare: () => ({ run: () => undefined, all: () => [] })
    }
    const events: BackupProgress[] = []

    await expect(
      exportBackup(join(outDir, 'broken.zip'), {
        paths: pathsFor(userData),
        sourceDb: brokenDb,
        appVersion: '0.0.0',
        onProgress: (p) => events.push(p)
      })
    ).rejects.toThrow(/disk I\/O error/)

    // .part도 최종 파일도 남지 않는다
    expect(await readdir(outDir)).toEqual([])
    expect(events.at(-1)?.phase).toBe('error')
  })

  it('실패해도 사용자가 "대체"로 고른 기존 백업 파일을 건드리지 않는다', async () => {
    const outDir = await makeTempDir('lw-keep-old-')
    const userData = await makeTempDir('lw-keep-old-src-')

    // 지난주에 만들어 둔 백업이 이미 그 자리에 있고, 저장 대화상자에서 이걸 골랐다고 가정
    const target = join(outDir, 'LinkWork-backup-20260818-090000.zip')
    const previous = '지난주 백업 — 이게 사라지면 안 된다'
    await writeFile(target, previous)

    const brokenDb: DatabaseLike = {
      exec: () => {
        throw new Error('disk I/O error')
      },
      prepare: () => ({ run: () => undefined, all: () => [] })
    }

    await expect(
      exportBackup(target, {
        paths: pathsFor(userData),
        sourceDb: brokenDb,
        appVersion: '0.0.0'
      })
    ).rejects.toThrow(/disk I\/O error/)

    // 기존 파일은 내용까지 그대로고, 만들다 만 .part는 남지 않는다
    expect(await readFile(target, 'utf-8')).toBe(previous)
    expect(await readdir(outDir)).toEqual(['LinkWork-backup-20260818-090000.zip'])
  })

  it('성공하면 기존 백업을 새 백업으로 덮어쓴다', async () => {
    const outDir = await makeTempDir('lw-replace-')
    const userData = await makeTempDir('lw-replace-src-')
    closeDatabase()
    electronState.userData = userData
    initDatabase()

    const target = join(outDir, 'LinkWork-backup-20260818-090000.zip')
    await writeFile(target, '지난주 백업')

    const { path } = await exportBackup(target, {
      paths: pathsFor(userData),
      sourceDb: getDatabase(),
      appVersion: '1.2.3'
    })

    expect(path).toBe(target)
    // .part는 정리되고 최종 파일 하나만 남으며, 내용은 진짜 백업이다
    expect(await readdir(outDir)).toEqual(['LinkWork-backup-20260818-090000.zip'])
    const inZip = JSON.parse((await readZipEntry(target, MANIFEST_ENTRY)).toString('utf-8'))
    expect(inZip.appVersion).toBe('1.2.3')
    closeDatabase()
  })

  it('파일을 읽지 못하면 만들다 만 zip을 남기지 않는다', async () => {
    // root로 돌면 권한이 무시돼 복사가 성공해 버린다
    if (typeof process.getuid === 'function' && process.getuid() === 0) return

    const outDir = await makeTempDir('lw-fail-copy-')
    const userData = await makeTempDir('lw-fail-copy-src-')
    closeDatabase()
    electronState.userData = userData
    initDatabase()

    await mkdir(join(userData, 'recordings'), { recursive: true })
    const unreadable = join(userData, 'recordings', 'locked.wav')
    await writeFile(unreadable, 'secret')
    await chmod(unreadable, 0o000)

    try {
      await expect(
        exportBackup(join(outDir, 'partial.zip'), {
          paths: pathsFor(userData),
          sourceDb: getDatabase(),
          appVersion: '0.0.0'
        })
      ).rejects.toThrow()
      expect(await readdir(outDir)).toEqual([])
    } finally {
      await chmod(unreadable, 0o600).catch(() => {})
      closeDatabase()
    }
  })
})
