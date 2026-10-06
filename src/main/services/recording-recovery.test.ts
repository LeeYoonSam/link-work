import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3는 Electron ABI로 빌드돼 vitest의 Node에서 로드할 수 없으므로, 테스트에서만
// Node 내장 node:sqlite로 갈아끼운다(recognition-aids.test.ts와 같은 방식). initDatabase()의
// 실제 스키마로 검증한다.
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  type Args = unknown[]

  class BetterSqlite3Shim {
    private readonly db: InstanceType<typeof DatabaseSync>

    constructor() {
      this.db = new DatabaseSync(':memory:')
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

vi.mock('electron', () => ({
  // 위 shim이 경로를 쓰지 않으므로 값 자체는 의미가 없다.
  app: { getPath: () => '/linkwork-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))

import type Database from 'better-sqlite3'
import { closeDatabase, getDatabase, initDatabase } from '../db/database'
import {
  ORPHAN_NO_AUDIO_ERROR,
  ORPHAN_UNPROCESSED_ERROR,
  discardDraft,
  onRendererReload,
  recoverOrphanRecordings
} from './recording-recovery'
import { RecordingGuard } from './recording-guard'

let db: Database.Database

beforeEach(() => {
  closeDatabase()
  initDatabase()
  db = getDatabase()
})

afterAll(() => {
  closeDatabase()
})

function seedMeeting(status: string, audioPath: string | null = null): number {
  const result = db
    .prepare('INSERT INTO meetings (title, status, audio_path) VALUES (?, ?, ?)')
    .run(`회의 ${status}`, status, audioPath)
  return Number(result.lastInsertRowid)
}

function rowOf(id: number): { status: string; error: string | null } | undefined {
  return db.prepare('SELECT status, error FROM meetings WHERE id = ?').get(id) as
    | { status: string; error: string | null }
    | undefined
}

describe('[S1] recoverOrphanRecordings', () => {
  it('[S1] 오디오 없는 recording → failed + NO_AUDIO, 오디오 있는 recording → failed + UNPROCESSED', () => {
    const noAudio = seedMeeting('recording')
    const withAudio = seedMeeting('recording', 'x.wav')

    const recovered = recoverOrphanRecordings(db, null)

    expect(recovered.sort()).toEqual([noAudio, withAudio].sort())
    expect(rowOf(noAudio)).toEqual({ status: 'failed', error: ORPHAN_NO_AUDIO_ERROR })
    expect(rowOf(withAudio)).toEqual({ status: 'failed', error: ORPHAN_UNPROCESSED_ERROR })
  })

  it('[S1] keepId로 지정한 녹음 중 행은 건드리지 않는다', () => {
    const live = seedMeeting('recording')
    const orphan = seedMeeting('recording')

    const recovered = recoverOrphanRecordings(db, live)

    expect(recovered).toEqual([orphan])
    expect(rowOf(live)).toEqual({ status: 'recording', error: null })
    expect(rowOf(orphan)?.status).toBe('failed')
  })

  it('[S1] recording이 아닌 status는 그대로 둔다', () => {
    const ids = ['processing', 'transcribed', 'summarized', 'failed'].map((s) =>
      seedMeeting(s, 'a.wav')
    )
    const before = ids.map(rowOf)

    expect(recoverOrphanRecordings(db, null)).toEqual([])
    expect(ids.map(rowOf)).toEqual(before)
  })
})

describe('[S2] discardDraft', () => {
  it('[S2] recording + 오디오 없음인 행만 삭제한다', () => {
    const draft = seedMeeting('recording')
    expect(discardDraft(db, draft)).toBe(true)
    expect(rowOf(draft)).toBeUndefined()
  })

  it('[S2] 오디오가 있거나 recording이 아니거나 없는 행이면 false이고 아무것도 지우지 않는다', () => {
    const saved = seedMeeting('recording', 'b.wav')
    const done = seedMeeting('summarized')
    const failed = seedMeeting('failed')

    expect(discardDraft(db, saved)).toBe(false)
    expect(discardDraft(db, done)).toBe(false)
    expect(discardDraft(db, failed)).toBe(false)
    expect(discardDraft(db, 99999)).toBe(false)
    expect(rowOf(saved)?.status).toBe('recording')
    expect(rowOf(done)?.status).toBe('summarized')
    expect(rowOf(failed)?.status).toBe('failed')
  })
})

describe('[S13] onRendererReload', () => {
  it('[S13] 가드를 비우고 대기 중 저장 요청을 renderer-gone으로 끝내며 recording 행을 복구한다', async () => {
    const orphan = seedMeeting('recording')
    const done = seedMeeting('summarized', 'c.wav')
    const guard = new RecordingGuard(() => 'req-1')
    guard.setState({ active: true, draftId: orphan })
    const pending = guard.requestStopAndSave(() => {}, true)

    const recovered = onRendererReload(db, guard)

    expect(recovered).toEqual([orphan])
    expect(guard.isActive()).toBe(false)
    expect(guard.draftId()).toBeNull()
    await expect(pending).resolves.toEqual({ success: false, error: 'renderer-gone' })
    expect(rowOf(orphan)).toEqual({ status: 'failed', error: ORPHAN_NO_AUDIO_ERROR })
    expect(rowOf(done)?.status).toBe('summarized')
  })

  it('[S13] 첫 로드처럼 녹음 행이 없으면 아무것도 바꾸지 않는다', () => {
    const done = seedMeeting('transcribed', 'd.wav')
    expect(onRendererReload(db, new RecordingGuard())).toEqual([])
    expect(rowOf(done)?.status).toBe('transcribed')
  })
})
