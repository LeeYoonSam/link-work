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
// ipc/backup.ipc.ts의 핸들러를 직접 불러 인자 검증을 확인하려고 ipcMain.handle을 가로챈다.
const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const dialogCalls = vi.hoisted(() => ({ save: 0, relaunch: 0, exit: 0 }))
vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userData,
    getVersion: () => '1.0.0-test',
    relaunch: () => {
      dialogCalls.relaunch += 1
    },
    exit: () => {
      dialogCalls.exit += 1
    }
  },
  // sender에 fakeWindow를 달아 두면 그 창을 돌려준다(창 닫힘 재시작 테스트용). 없으면 null.
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: (sender: { fakeWindow?: unknown } | undefined) => sender?.fakeWindow ?? null
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn)
    }
  },
  dialog: {
    showSaveDialog: async () => {
      dialogCalls.save += 1
      return { canceled: true }
    },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
  }
}))

import Database from 'better-sqlite3'
import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import { registerBackupIpc, resetBackupIpcStateForTest } from '../ipc/backup.ipc'
import {
  BACKUP_FORMAT_VERSION,
  DB_FILE,
  MANIFEST_ENTRY,
  SECRET_SETTING_KEYS,
  buildManifest,
  classifyEntry,
  collectGroupStats,
  parseGroupsArg,
  defaultBackupFileName,
  exportBackup,
  importBackup,
  inspectBackup,
  isSafeEntryName,
  planFileCopies,
  stripCaches,
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
      INSERT INTO app_settings (key, value) VALUES ('google_client_secret', 'enc-google-secret');
      INSERT INTO app_settings (key, value) VALUES ('bitbucket_api_token', 'enc-bitbucket');
      INSERT INTO app_settings (key, value) VALUES ('bitbucket_email', 'me@example.com');
      INSERT INTO auth_tokens (id, provider, access_token) VALUES (1, 'google', 'enc-token');
    `)

    const removed = stripSecrets(db as unknown as DatabaseLike)

    expect(removed).toContain('auth_tokens')
    expect(removed).toContain('app_settings:notion_token')
    expect(removed).toContain('app_settings:jira_api_token')
    expect(removed).toContain('app_settings:google_client_secret')
    expect(removed).toContain('app_settings:bitbucket_api_token')

    // bitbucket_email 은 평문이라 남는다. token 이 없으니 복원 뒤 미연동으로 보인다.
    const keys = (
      db.prepare('SELECT key FROM app_settings ORDER BY key').all() as { key: string }[]
    ).map((r) => r.key)
    expect(keys).toEqual(['bitbucket_email', 'google_client_id', 'jira_site_url'])

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

describe('stripCaches', () => {
  it('프로젝트 보드 캐시 행을 지우고 테이블은 남긴다. 테이블이 없으면 넘어간다', async () => {
    const dir = await makeTempDir('lw-cache-')
    const db = openDb(join(dir, 'x.db'))
    db.exec(`
      CREATE TABLE jira_board_issues (project_key TEXT, issue_key TEXT, data TEXT, updated TEXT, synced_at TEXT);
      CREATE TABLE jira_board_sync (project_key TEXT PRIMARY KEY, recent_done_days INTEGER NOT NULL);
      INSERT INTO jira_board_issues VALUES ('PROJ', 'PROJ-1', '{}', 'x', 'x');
      INSERT INTO jira_board_sync VALUES ('PROJ', 14);
    `)
    stripCaches(db as unknown as DatabaseLike)
    for (const t of ['jira_board_issues', 'jira_board_sync']) {
      expect(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).all()).toEqual([{ c: 0 }])
    }
    const old = openDb(join(dir, 'old.db'))
    expect(() => stripCaches(old as unknown as DatabaseLike)).not.toThrow()
    old.close()
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
      INSERT INTO app_settings (key, value) VALUES ('google_client_secret', 'enc-google-secret');
      INSERT INTO app_settings (key, value) VALUES ('bitbucket_api_token', 'enc-bitbucket');
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
    // 제자리 병합 뒤 연결을 깨끗이 닫았는지 — 닫히면 WAL이 체크포인트되고 -wal이 사라진다
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

// ── 선택 백업·복원 (docs/DATA_BACKUP.md, 테스트 ID는 설계 §6) ──

/** 폴더 안 파일 이름과 내용을 한 문자열로 — "바이트 단위로 그대로"를 비교한다. */
async function hashDir(dir: string): Promise<string> {
  const h = createHash('sha256')
  for (const name of (await readdir(dir)).sort()) {
    h.update(name)
    h.update(await readFile(join(dir, name)))
  }
  return h.digest('hex')
}

/** 파일 경로나 문자열로 zip을 만든다 (DB 같은 바이너리를 담는 v1 픽스처용) */
async function writeZipFrom(
  zipPath: string,
  entries: Array<{ name: string; src?: string; content?: string }>
): Promise<void> {
  const zip = new ZipFile()
  for (const e of entries) {
    if (e.src) zip.addFile(e.src, e.name)
    else zip.addBuffer(Buffer.from(e.content ?? '', 'utf-8'), e.name)
  }
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(zipPath))
}

/** 전역 DB 핸들을 userData로 옮겨 새로 띄운다 (앱 한 번 실행과 같다) */
function openLive(userData: string, seed = ''): void {
  closeDatabase()
  electronState.userData = userData
  initDatabase()
  if (seed) getDatabase().exec(seed)
}

function count(dbPath: string, sql: string): number {
  const db = openDb(dbPath)
  try {
    const rows = db.prepare(sql).all() as { c: number }[]
    return Number(rows[0]?.c ?? 0)
  } finally {
    db.close()
  }
}

function fileNames(dir: string): Promise<string[]> {
  return readdir(dir).then((n) => n.sort())
}

describe('manifest 형식 v2 (S3·S8)', () => {
  const base = {
    format: 'linkwork-backup',
    appVersion: '1.0.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    platform: 'darwin',
    db: { bytes: 1, tables: {} },
    files: { recordings: { count: 0, bytes: 0 }, attachments: { count: 0, bytes: 0 } },
    excluded: []
  }

  it('S3 v1 manifest는 groups가 없어도 전체 그룹으로 해석한다', () => {
    const result = validateManifest({ ...base, formatVersion: 1 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.formatVersion).toBe(1)
      expect(result.manifest.groups).toEqual(['work', 'meetings', 'library', 'ai', 'settings'])
    }
  })

  it('S8 v2 manifest에 groups가 없거나 비었거나 모르는 id가 있으면 거부한다', () => {
    expect(validateManifest({ ...base, formatVersion: 2 }).ok).toBe(false)
    expect(validateManifest({ ...base, formatVersion: 2, groups: [] }).ok).toBe(false)
    expect(validateManifest({ ...base, formatVersion: 2, groups: ['work', 'photos'] }).ok).toBe(false)
    expect(validateManifest({ ...base, formatVersion: 2, groups: 'work' }).ok).toBe(false)
  })

  it('S8 v2 manifest의 groups는 고정 순서로 정규화된다', () => {
    const result = validateManifest({ ...base, formatVersion: 2, groups: ['ai', 'work', 'ai'] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.manifest.groups).toEqual(['work', 'ai'])
  })

  it('BACKUP_FORMAT_VERSION은 2이고 buildManifest의 기본 groups는 전체다', () => {
    expect(BACKUP_FORMAT_VERSION).toBe(2)
    const m = buildManifest({
      appVersion: '1',
      dbBytes: 0,
      tables: {},
      files: base.files,
      excluded: []
    })
    expect(m.groups).toEqual(['work', 'meetings', 'library', 'ai', 'settings'])
  })
})

describe('parseGroupsArg (IPC 인자 검증)', () => {
  it('빈 배열·배열 아님·모르는 id는 사용자 문장과 함께 거부한다', () => {
    for (const bad of [undefined, null, [], 'work', ['work', 'nope'], [1]]) {
      const r = parseGroupsArg(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/선택/)
    }
    expect(parseGroupsArg(['settings', 'work'])).toEqual({ ok: true, groups: ['work', 'settings'] })
  })
})

describe('선택 백업·복원', () => {
  let sourceUserData: string
  let outDir: string
  let fullZip: string
  let libraryZip: string
  let meetingsZip: string

  const SRC_AUDIO = 'SRC-AUDIO'

  beforeAll(async () => {
    sourceUserData = await makeTempDir('lw-sel-src-')
    outDir = await makeTempDir('lw-sel-out-')
    openLive(
      sourceUserData,
      `
      INSERT INTO projects (id, name, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date)
      VALUES (1, '원본 프로젝트', '2026-01-01', '2026-01-10', '2026-01-11', '2026-01-15', '2026-01-16');
      INSERT INTO todos (title) VALUES ('원본 할 일');
      INSERT INTO meetings (id, title, status, audio_path, project_id) VALUES (1, '원본 회의', 'done', '1.wav', 1);
      INSERT INTO documents (name, url, project_id) VALUES ('원본 문서', 'https://x', 1);
      INSERT INTO memos (content) VALUES ('원본 메모');
      INSERT INTO ai_chats (title) VALUES ('원본 대화');
      INSERT INTO app_settings (key, value) VALUES ('ai_model', 'src-model');
      INSERT INTO app_settings (key, value) VALUES ('notion_token', 'enc-notion');
      INSERT INTO app_settings (key, value) VALUES ('project_sync_created_keys', '[]');
      `
    )
    await mkdir(join(sourceUserData, 'recordings'), { recursive: true })
    await mkdir(join(sourceUserData, 'ai-attachments'), { recursive: true })
    await writeFile(join(sourceUserData, 'recordings', '1.wav'), SRC_AUDIO)
    await writeFile(join(sourceUserData, 'ai-attachments', '1-a.png'), 'PNG')

    const opts = { paths: pathsFor(sourceUserData), sourceDb: getDatabase(), appVersion: '2.0.0' }
    fullZip = (await exportBackup(join(outDir, 'full.zip'), opts)).path
    libraryZip = (await exportBackup(join(outDir, 'library.zip'), { ...opts, groups: ['library'] }))
      .path
    meetingsZip = (
      await exportBackup(join(outDir, 'meetings.zip'), { ...opts, groups: ['meetings'] })
    ).path
    closeDatabase()
  })

  it('collectGroupStats: 그룹별 대표 건수와 파일 용량을 고정 순서로 돌려준다', async () => {
    openLive(sourceUserData)
    const stats = await collectGroupStats(getDatabase() as unknown as DatabaseLike, sourceUserData)
    expect(stats.map((s) => s.id)).toEqual(['work', 'meetings', 'library', 'ai', 'settings'])
    const by = Object.fromEntries(stats.map((s) => [s.id, s]))
    expect(by.work.tables.projects).toBe(1)
    expect(by.work.tables.todos).toBe(1)
    expect(by.meetings.tables.meetings).toBe(1)
    expect(by.meetings.files).toEqual({ count: 1, bytes: SRC_AUDIO.length })
    expect(by.library.tables.documents).toBe(1)
    expect(by.library.tables.memos).toBe(1)
    expect(by.ai.tables.ai_chats).toBe(1)
    expect(by.ai.files).toEqual({ count: 1, bytes: 3 })
    expect(by.work.files).toEqual({ count: 0, bytes: 0 })
    // settings는 settings로 분류되는 키만 — 시크릿(notion_token)과 work 키는 빠진다
    const settingsKeys = (
      getDatabase().prepare('SELECT key FROM app_settings').all() as { key: string }[]
    ).filter((r) => !['notion_token', 'project_sync_created_keys'].includes(r.key)).length
    expect(by.settings.tables.app_settings).toBe(settingsKeys)
    closeDatabase()
  })

  it('S1 부분 내보내기: formatVersion 2, groups가 맞고 빠진 그룹은 행 0, 녹음 미포함', async () => {
    const { manifest } = await inspectBackup(libraryZip)
    expect(manifest.formatVersion).toBe(2)
    expect(manifest.groups).toEqual(['library'])
    expect(manifest.db.tables.documents).toBe(1)
    expect(manifest.db.tables.memos).toBe(1)
    expect(manifest.db.tables.projects).toBe(0)
    expect(manifest.db.tables.todos).toBe(0)
    expect(manifest.db.tables.meetings).toBe(0)
    expect(manifest.db.tables.ai_chats).toBe(0)
    expect(manifest.files.recordings).toEqual({ count: 0, bytes: 0 })
    expect(manifest.files.attachments).toEqual({ count: 0, bytes: 0 })
    const names = (await listZipEntries(libraryZip)).map((e) => e.name)
    expect(names.some((n) => n.startsWith('recordings/'))).toBe(false)
    expect(names.some((n) => n.startsWith('ai-attachments/'))).toBe(false)

    // 회의 그룹을 담으면 녹음은 들어가고 첨부는 빠진다
    const meet = await inspectBackup(meetingsZip)
    expect(meet.manifest.groups).toEqual(['meetings'])
    expect(meet.manifest.files.recordings.count).toBe(1)
    expect(meet.manifest.files.attachments.count).toBe(0)

    // 전체 내보내기는 5개 그룹 전부
    expect((await inspectBackup(fullZip)).manifest.groups).toEqual([
      'work',
      'meetings',
      'library',
      'ai',
      'settings'
    ])
  })

  it('S2 부분 내보내기 사본에서 meetings.project_id가 보존된다(SET NULL이 일어나지 않음)', async () => {
    const scratch = await makeTempDir('lw-sel-peek-')
    const dbCopy = join(scratch, 'peek.db')
    await extractZipEntryToFile(meetingsZip, DB_FILE, dbCopy)
    expect(count(dbCopy, 'SELECT COUNT(*) AS c FROM projects')).toBe(0)
    expect(count(dbCopy, 'SELECT COUNT(*) AS c FROM meetings WHERE project_id = 1')).toBe(1)
    // 시크릿은 부분 백업에서도 빠진다
    expect(count(dbCopy, "SELECT COUNT(*) AS c FROM app_settings WHERE key = 'notion_token'")).toBe(0)
  })

  it('S5 빈 그룹이나 모르는 그룹으로 내보내기를 요청하면 아무 파일도 만들지 않고 거부한다', async () => {
    const dir = await makeTempDir('lw-sel-empty-')
    openLive(sourceUserData)
    try {
      for (const groups of [[], ['photos']] as unknown as Array<['work']>) {
        await expect(
          exportBackup(join(dir, 'x.zip'), {
            paths: pathsFor(sourceUserData),
            sourceDb: getDatabase(),
            appVersion: '0',
            groups
          })
        ).rejects.toThrow(/선택/)
      }
      expect(await readdir(dir)).toEqual([])
    } finally {
      closeDatabase()
    }
  })

  it('S4 백업에 없는 그룹이나 빈 그룹을 요청하면 아무것도 바꾸지 않고 거부한다(.bak 미생성)', async () => {
    const target = await makeTempDir('lw-sel-s4-')
    openLive(target, "INSERT INTO todos (title) VALUES ('대상 할 일')")
    const before = await fileNames(target)
    const neverClose = (): void => {
      throw new Error('여기까지 오면 안 된다 — 검증 전에 DB를 닫았다')
    }
    try {
      await expect(
        importBackup(libraryZip, {
          paths: pathsFor(target),
          groups: ['meetings'],
          closeDb: neverClose
        })
      ).rejects.toThrow(/백업에 없는/)
      await expect(
        importBackup(libraryZip, {
          paths: pathsFor(target),
          groups: [],
          closeDb: neverClose
        })
      ).rejects.toThrow(/선택/)
      expect(await fileNames(target)).toEqual(before)
      expect((await fileNames(target)).some((n) => n.includes('.bak-'))).toBe(false)
      const todos = getDatabase().prepare('SELECT title FROM todos').all() as { title: string }[]
      expect(todos.map((t) => t.title)).toEqual(['대상 할 일'])
    } finally {
      closeDatabase()
    }
  })

  it('S6 회의를 선택하지 않으면 recordings 폴더가 바이트 단위로 그대로다', async () => {
    const target = await makeTempDir('lw-sel-s6-')
    openLive(target)
    await mkdir(join(target, 'recordings'), { recursive: true })
    await writeFile(join(target, 'recordings', '1.wav'), 'TARGET-AUDIO')
    await writeFile(join(target, 'recordings', '7.wav'), 'OTHER')
    const before = await hashDir(join(target, 'recordings'))

    const result = await importBackup(fullZip, {
      paths: pathsFor(target),
      groups: ['library', 'ai'],
      closeDb: closeDatabase
    })
    expect(result.groups).toEqual(['library', 'ai'])
    expect(await hashDir(join(target, 'recordings'))).toBe(before)
    expect((await fileNames(target)).some((n) => n.startsWith('recordings.bak-'))).toBe(false)
    // 고른 그룹의 파일은 들어왔다
    expect(existsSync(join(target, 'ai-attachments', '1-a.png'))).toBe(true)
    const dbPath = join(target, DB_FILE)
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM documents')).toBe(1)
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM meetings')).toBe(0)
  })

  it('S7 덮어쓸 녹음 파일은 recordings.bak-<시각>/ 로 옮겨진다', async () => {
    const target = await makeTempDir('lw-sel-s7-')
    openLive(target)
    await mkdir(join(target, 'recordings'), { recursive: true })
    await writeFile(join(target, 'recordings', '1.wav'), 'OLD-AUDIO')
    await writeFile(join(target, 'recordings', '9.wav'), 'UNTOUCHED')

    const { restoredDbBackupPath } = await importBackup(meetingsZip, {
      paths: pathsFor(target),
      groups: ['meetings'],
      closeDb: closeDatabase
    })
    expect(existsSync(restoredDbBackupPath)).toBe(true)
    expect(await readFile(join(target, 'recordings', '1.wav'), 'utf-8')).toBe(SRC_AUDIO)
    // 같은 폴더의 다른 파일은 지우지 않는다
    expect(await readFile(join(target, 'recordings', '9.wav'), 'utf-8')).toBe('UNTOUCHED')

    const bakDirs = (await fileNames(target)).filter((n) => n.startsWith('recordings.bak-'))
    expect(bakDirs).toHaveLength(1)
    // DB 보관본과 같은 시각 도장을 쓴다
    expect(restoredDbBackupPath.endsWith(bakDirs[0].slice('recordings'.length))).toBe(true)
    expect(await fileNames(join(target, bakDirs[0]))).toEqual(['1.wav'])
    expect(await readFile(join(target, bakDirs[0], '1.wav'), 'utf-8')).toBe('OLD-AUDIO')
  })

  it('S3 v1 zip은 전체 복원과 부분 복원이 모두 성공한다', async () => {
    // v1 백업 흉내: 전체 백업의 DB·파일에 groups 없는 formatVersion 1 manifest
    const scratch = await makeTempDir('lw-sel-v1-')
    const dbCopy = join(scratch, DB_FILE)
    await extractZipEntryToFile(fullZip, DB_FILE, dbCopy)
    const audio = join(scratch, '1.wav')
    await writeFile(audio, SRC_AUDIO)
    const { manifest } = await inspectBackup(fullZip)
    const v1 = { ...manifest, formatVersion: 1 } as Record<string, unknown>
    delete v1.groups
    const v1Zip = join(scratch, 'v1.zip')
    await writeZipFrom(v1Zip, [
      { name: DB_FILE, src: dbCopy },
      { name: 'recordings/1.wav', src: audio },
      { name: MANIFEST_ENTRY, content: JSON.stringify(v1) }
    ])
    // v1 manifest에 attachments가 1개로 기록돼 있지만 이 픽스처는 넣지 않았다 — 경고만 난다
    const summary = await inspectBackup(v1Zip)
    expect(summary.manifest.formatVersion).toBe(1)
    expect(summary.manifest.groups).toHaveLength(5)

    const full = await makeTempDir('lw-sel-v1-full-')
    openLive(full, "INSERT INTO todos (title) VALUES ('지워질 할 일')")
    const r1 = await importBackup(v1Zip, { paths: pathsFor(full), closeDb: closeDatabase })
    expect(r1.groups).toEqual(['work', 'meetings', 'library', 'ai', 'settings'])
    const fullDb = join(full, DB_FILE)
    const todos = openDb(fullDb)
    expect(
      (todos.prepare('SELECT title FROM todos').all() as { title: string }[]).map((t) => t.title)
    ).toEqual(['원본 할 일'])
    todos.close()
    expect(count(fullDb, 'SELECT COUNT(*) AS c FROM meetings WHERE project_id = 1')).toBe(1)
    expect(await readFile(join(full, 'recordings', '1.wav'), 'utf-8')).toBe(SRC_AUDIO)

    const part = await makeTempDir('lw-sel-v1-part-')
    openLive(part, "INSERT INTO todos (title) VALUES ('남을 할 일')")
    const r2 = await importBackup(v1Zip, {
      paths: pathsFor(part),
      groups: ['library'],
      closeDb: closeDatabase
    })
    expect(r2.groups).toEqual(['library'])
    const partDb = join(part, DB_FILE)
    expect(count(partDb, "SELECT COUNT(*) AS c FROM todos WHERE title = '남을 할 일'")).toBe(1)
    expect(count(partDb, 'SELECT COUNT(*) AS c FROM documents')).toBe(1)
    expect(count(partDb, 'SELECT COUNT(*) AS c FROM meetings')).toBe(0)
    // 회의를 고르지 않았으니 녹음은 풀지도 복사하지도 않는다
    expect(existsSync(join(part, 'recordings', '1.wav'))).toBe(false)
  })
  it('S9 DB 가 없는 새 기기에 일부 그룹만 고르면 고르지 않은 그룹은 비어 있고 refs 표가 남지 않는다', async () => {
    const target = await makeTempDir('lw-sel-s9-')
    const result = await importBackup(fullZip, {
      paths: pathsFor(target),
      groups: ['library'],
      closeDb: closeDatabase
    })
    expect(result.groups).toEqual(['library'])
    const dbPath = join(target, DB_FILE)
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM documents')).toBe(1)
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM memos')).toBe(1)
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM meetings')).toBe(0)
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM projects')).toBe(0)
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM ai_chats')).toBe(0)
    // 고르지 않은 프로젝트를 가리키던 문서의 연결은 끊긴다(고아 참조 0건)
    expect(count(dbPath, 'SELECT COUNT(*) AS c FROM documents WHERE project_id IS NOT NULL')).toBe(0)
    expect(count(dbPath, "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'linkwork_backup_refs'")).toBe(0)
    expect((await fileNames(target)).some((n) => n.startsWith('recordings'))).toBe(false)
  })
})

describe('backup IPC 인자 검증', () => {
  const event = { sender: {} }

  beforeAll(() => {
    ipcHandlers.clear()
    resetBackupIpcStateForTest()
    registerBackupIpc()
  })

  it('backup:export는 그룹이 잘못되면 저장 대화상자를 띄우지 않고 {success:false,error}', async () => {
    const handler = ipcHandlers.get('backup:export')!
    for (const bad of [undefined, [], ['nope'], 'work']) {
      const res = (await handler(event, bad)) as { success: boolean; error?: string }
      expect(res.success).toBe(false)
      expect(res.error).toMatch(/선택/)
    }
    expect(dialogCalls.save).toBe(0)
    // 올바른 그룹이면 대화상자까지 간다(여기서는 취소)
    const ok = (await handler(event, ['work'])) as { success: boolean; canceled?: boolean }
    expect(ok).toEqual({ success: false, canceled: true })
    expect(dialogCalls.save).toBe(1)
  })

  it('backup:import는 경로나 그룹이 잘못되면 DB를 건드리지 않고 {success:false,error}', async () => {
    const handler = ipcHandlers.get('backup:import')!
    const noPath = (await handler(event, '', ['work'])) as { success: boolean; error?: string }
    expect(noPath.success).toBe(false)
    for (const bad of [undefined, [], ['nope']]) {
      const res = (await handler(event, '/tmp/x.zip', bad)) as { success: boolean; error?: string }
      expect(res.success).toBe(false)
      expect(res.error).toMatch(/선택/)
    }
  })

  it('backup:stats는 5개 그룹의 현재 건수를 돌려준다', async () => {
    const userData = await makeTempDir('lw-ipc-stats-')
    openLive(userData, "INSERT INTO todos (title) VALUES ('a'), ('b')")
    try {
      const res = (await ipcHandlers.get('backup:stats')!()) as {
        success: boolean
        groups: Array<{ id: string; tables: Record<string, number> }>
      }
      expect(res.success).toBe(true)
      expect(res.groups.map((g) => g.id)).toEqual(['work', 'meetings', 'library', 'ai', 'settings'])
      expect(res.groups[0].tables.todos).toBe(2)
    } finally {
      closeDatabase()
    }
  })
})

describe('backup:import 뒤 재시작 분기', () => {
  const event = { sender: {} }
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  let zipPath: string

  beforeAll(async () => {
    ipcHandlers.clear()
    resetBackupIpcStateForTest()
    registerBackupIpc()
    // 백업 쪽 Bitbucket 계정은 a@example.com
    const src = await makeTempDir('lw-rs-src-')
    openLive(src, "INSERT INTO app_settings (key, value) VALUES ('bitbucket_email', 'a@example.com')")
    const out = await makeTempDir('lw-rs-out-')
    zipPath = (
      await exportBackup(join(out, 'rs.zip'), {
        paths: pathsFor(src),
        sourceDb: getDatabase(),
        appVersion: '1'
      })
    ).path
    closeDatabase()
  })

  it('경고가 없으면 restartPending 없이 1초 뒤 자동 재시작한다', async () => {
    resetBackupIpcStateForTest()
    const target = await makeTempDir('lw-rs-quiet-')
    // 같은 계정이라 연동 경고가 나지 않는다
    openLive(target, "INSERT INTO app_settings (key, value) VALUES ('bitbucket_email', 'a@example.com')")
    const before = dialogCalls.relaunch
    const res = (await ipcHandlers.get('backup:import')!(event, zipPath, ['settings'])) as Record<
      string,
      unknown
    >
    expect(res).toEqual({ success: true, groups: ['settings'], warnings: [] })
    expect(res.restartPending).toBeUndefined()
    await wait(1100)
    expect(dialogCalls.relaunch).toBe(before + 1)
  })

  it('경고가 있으면 restartPending: true로 돌려주고 backup:restart 전까지 재시작하지 않는다', async () => {
    resetBackupIpcStateForTest()
    const target = await makeTempDir('lw-rs-warn-')
    // 다른 계정 + 현재 토큰 → 토큰을 지우고 "다시 연결" 경고
    openLive(
      target,
      `INSERT INTO app_settings (key, value) VALUES ('bitbucket_email', 'b@example.com');
       INSERT INTO app_settings (key, value) VALUES ('bitbucket_api_token', 'enc-b');`
    )
    const before = dialogCalls.relaunch
    const res = (await ipcHandlers.get('backup:import')!(event, zipPath, ['settings'])) as {
      success: boolean
      warnings: string[]
      restartPending?: boolean
    }
    expect(res.success).toBe(true)
    expect(res.warnings.length).toBeGreaterThan(0)
    expect(res.warnings.join('\n')).toMatch(/Bitbucket/)
    expect(res.restartPending).toBe(true)
    await wait(1100)
    expect(dialogCalls.relaunch).toBe(before)

    // 기다리는 동안(DB 닫힘) 두 번째 복원·내보내기는 거부되고, 통계는 실패만 한다
    const again = (await ipcHandlers.get('backup:import')!(event, zipPath, ['settings'])) as {
      success: boolean
      error?: string
    }
    expect(again.success).toBe(false)
    expect(again.error).toMatch(/재시작/)
    const exp = (await ipcHandlers.get('backup:export')!(event, ['work'])) as {
      success: boolean
      error?: string
    }
    expect(exp.success).toBe(false)
    expect(exp.error).toMatch(/재시작/)
    const stats = (await ipcHandlers.get('backup:stats')!()) as { success: boolean }
    expect(stats.success).toBe(false)
    expect(existsSync(join(target, DB_FILE))).toBe(true)
    expect((await readdir(target)).filter((n) => n.startsWith(`${DB_FILE}.bak-`))).toHaveLength(1)

    // 사용자가 확인하면 restart가 앱을 다시 띄운다
    const restarted = (await ipcHandlers.get('backup:restart')!()) as { success: boolean }
    expect(restarted.success).toBe(true)
    await wait(20)
    expect(dialogCalls.relaunch).toBe(before + 1)
  })

  it('경고로 재시작을 기다리는 중 요청한 창이 닫히면 한 번만 재시작한다', async () => {
    resetBackupIpcStateForTest()
    const target = await makeTempDir('lw-rs-close-')
    openLive(
      target,
      `INSERT INTO app_settings (key, value) VALUES ('bitbucket_email', 'b@example.com');
       INSERT INTO app_settings (key, value) VALUES ('bitbucket_api_token', 'enc-b');`
    )
    const closedHandlers: Array<() => void> = []
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: { send: () => {} },
      once: (name: string, fn: () => void) => {
        if (name === 'closed') closedHandlers.push(fn)
      }
    }
    const before = dialogCalls.relaunch
    const res = (await ipcHandlers.get('backup:import')!(
      { sender: { fakeWindow } },
      zipPath,
      ['settings']
    )) as { restartPending?: boolean }
    expect(res.restartPending).toBe(true)
    expect(closedHandlers).toHaveLength(1)
    await wait(50)
    expect(dialogCalls.relaunch).toBe(before)

    closedHandlers[0]()
    // 창 닫힘 뒤 restart가 또 와도 재시작은 한 번뿐이다
    await ipcHandlers.get('backup:restart')!()
    await wait(20)
    expect(dialogCalls.relaunch).toBe(before + 1)
  })

  it('복원이 진행 중이면 두 번째 복원과 내보내기를 거부한다(동시에 DB 를 닫고 여는 일을 막는다)', async () => {
    resetBackupIpcStateForTest()
    const target = await makeTempDir('lw-rs-busy-')
    openLive(target)
    const saveBefore = dialogCalls.save
    const handler = ipcHandlers.get('backup:import')!
    // 세 호출을 기다리지 않고 연달아 건다. 첫 호출이 실행 중인 동안 나머지가 들어온다.
    const first = handler(event, zipPath, ['settings']) as Promise<Record<string, unknown>>
    const second = handler(event, zipPath, ['settings']) as Promise<Record<string, unknown>>
    const exportWhileBusy = ipcHandlers.get('backup:export')!(event, ['work']) as Promise<
      Record<string, unknown>
    >
    const [a, b, c] = await Promise.all([first, second, exportWhileBusy])
    expect(a.success).toBe(true)
    expect(b.success).toBe(false)
    expect(String(b.error)).toMatch(/진행/)
    expect(c.success).toBe(false)
    expect(String(c.error)).toMatch(/진행/)
    expect(dialogCalls.save).toBe(saveBefore)
  })
})
