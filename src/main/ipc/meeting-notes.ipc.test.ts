import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../db/database', () => ({ getDatabase: vi.fn() }))
vi.mock('../services/recognition-aids', () => ({ listAttendees: () => [] }))

const { listMeetingNotes } = await import('./meeting-notes.ipc')

// listMeetingNotes 가 쓰는 열만 만든다. project_id 는 옛 연결이 남은 행을 흉내 낸다
function seed(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE meetings (
      id INTEGER PRIMARY KEY, title TEXT, kind TEXT, status TEXT,
      started_at TEXT, duration_ms INTEGER, project_id INTEGER
    );
    CREATE TABLE meeting_summaries (
      meeting_id INTEGER PRIMARY KEY, tldr TEXT, key_points TEXT, decisions TEXT,
      action_items TEXT, next_steps TEXT, qa_pairs TEXT, generated_at TEXT
    );
    INSERT INTO meetings VALUES
      (1, '미지정 회의', 'meeting', 'summarized', '2026-11-01 10:00:00', 60000, NULL),
      (2, '결제 회의', 'meeting', 'summarized', '2026-11-02 10:00:00', 60000, 10),
      (3, '검색 회의', 'meeting', 'summarized', '2026-11-03 10:00:00', 60000, 20);
    INSERT INTO meeting_summaries (meeting_id, generated_at) VALUES
      (1, '2026-11-01'), (2, '2026-11-02'), (3, '2026-11-03');
  `)
  return db
}

const ids = (db: DatabaseSync, filter?: Parameters<typeof listMeetingNotes>[1]): number[] =>
  listMeetingNotes(db as unknown as Parameters<typeof listMeetingNotes>[0], filter).map((n) => n.id)

describe('listMeetingNotes', () => {
  it('프로젝트 연결 여부와 관계없이 전체를 돌려준다', () => {
    const db = seed()
    expect(ids(db, { q: '', kind: 'all' })).toEqual([3, 2, 1])
    expect(ids(db)).toEqual([3, 2, 1])
  })

  it('목록 항목에 프로젝트 필드를 싣지 않는다', () => {
    const notes = listMeetingNotes(seed() as unknown as Parameters<typeof listMeetingNotes>[0])
    expect(notes[1]).not.toHaveProperty('project_id')
    expect(notes[1]).not.toHaveProperty('project_name')
  })

  it('kind 로 거른다', () => {
    expect(ids(seed(), { kind: 'interview' })).toEqual([])
    expect(ids(seed(), { kind: 'meeting' })).toEqual([3, 2, 1])
  })
})
