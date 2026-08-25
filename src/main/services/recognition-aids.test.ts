import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// better-sqlite3는 electron-builder가 Electron ABI로 빌드해 두므로 vitest가 도는 Node에서는
// 네이티브 모듈을 로드할 수 없다(NODE_MODULE_VERSION 불일치). Node용으로 재빌드하면 앱이 깨지기
// 때문에, 테스트에서만 Node 내장 node:sqlite로 갈아끼운다(release-note-sync.test.ts와 같은 방식).
// SQLite 엔진은 같으므로 initDatabase()의 **실제 스키마**를 그대로 돌려 검증할 수 있다 —
// 즉 이 테스트는 database.ts가 stt_glossary/meeting_members/meeting_attendees를 실제로
// 만드는지까지 함께 확인한다(DDL을 테스트에 복사하지 않는다).
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
  parseGlossaryText,
  importGlossaryText,
  listGlossary,
  upsertGlossary,
  removeGlossary,
  listMembers,
  upsertMember,
  removeMember,
  setAttendees,
  listAttendees,
  loadPromptContext,
  buildSummaryContextBlock
} from './recognition-aids'

let db: Database.Database

beforeEach(() => {
  closeDatabase()
  initDatabase()
  db = getDatabase()
})

afterAll(() => {
  closeDatabase()
})

function seedMeeting(title: string, projectId: number | null = null): number {
  const result = db
    .prepare("INSERT INTO meetings (title, status, project_id) VALUES (?, 'recording', ?)")
    .run(title, projectId)
  return Number(result.lastInsertRowid)
}

function seedProject(name: string): number {
  const result = db
    .prepare(
      `INSERT INTO projects (name, dev_start_date, dev_end_date, qa_start_date, qa_end_date, deploy_date)
       VALUES (?, '2026-08-01', '2026-08-20', '2026-08-21', '2026-08-25', '2026-09-01')`
    )
    .run(name)
  return Number(result.lastInsertRowid)
}

describe('database.ts 스키마', () => {
  it('인식 보조 테이블과 meetings 컷편집 컬럼을 만든다', () => {
    for (const table of ['stt_glossary', 'meeting_members', 'meeting_attendees']) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table)
      expect(row, `${table} 테이블이 없다`).toBeTruthy()
    }
    const columns = (db.prepare('PRAGMA table_info(meetings)').all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(columns).toEqual(
      expect.arrayContaining([
        'compact_audio',
        'audio_compacted',
        'original_duration_ms',
        'pipeline_version'
      ])
    )
  })

  it('새 회의는 컷편집 기본 on, 미적용·미처리 상태로 시작한다', () => {
    // pipeline_version=0은 "아직 새 파이프라인을 거치지 않음"을 뜻한다. 요약 재생성 UI가
    // 이 값으로 재분석 필요 여부를 판단하므로, 기본값이 0이 아니면 재분석이 조용히 생략된다.
    const id = seedMeeting('주간 회의')
    const row = db
      .prepare(
        'SELECT compact_audio, audio_compacted, original_duration_ms, pipeline_version FROM meetings WHERE id = ?'
      )
      .get(id) as {
      compact_audio: number
      audio_compacted: number
      original_duration_ms: number | null
      pipeline_version: number
    }
    expect(row).toEqual({
      compact_audio: 1,
      audio_compacted: 0,
      original_duration_ms: null,
      pipeline_version: 0
    })
  })
})

describe('parseGlossaryText', () => {
  it('주석과 빈 줄을 무시한다', () => {
    expect(parseGlossaryText('# 사내 용어\n\n  \nLinkWork\n# 끝')).toEqual([
      { term: 'LinkWork', aliases: [], note: null }
    ])
  })

  it('파이프가 없으면 정답 표기만 있는 줄로 본다', () => {
    expect(parseGlossaryText('  Jira  ')).toEqual([{ term: 'Jira', aliases: [], note: null }])
  })

  it('별칭을 쉼표로 나누고 공백·빈 항목·중복을 정리한다', () => {
    expect(parseGlossaryText('LinkWork | 링크워크,  링크 워크 , ,링크워크')).toEqual([
      { term: 'LinkWork', aliases: ['링크워크', '링크 워크'], note: null }
    ])
  })

  it('세 번째 필드를 메모로 읽고, 메모 안의 파이프는 되살린다', () => {
    expect(parseGlossaryText('WBS | 더블유비에스 | 작업 분해 구조 | Work Breakdown')).toEqual([
      { term: 'WBS', aliases: ['더블유비에스'], note: '작업 분해 구조 | Work Breakdown' }
    ])
  })

  it('같은 term(대소문자 무시)은 별칭 합집합으로 병합한다', () => {
    expect(parseGlossaryText('LinkWork | 링크워크\nlinkwork | 링크웍, 링크워크 | 사내 앱')).toEqual([
      { term: 'LinkWork', aliases: ['링크워크', '링크웍'], note: '사내 앱' }
    ])
  })

  it('정답 표기가 비어 있는 줄은 버린다', () => {
    expect(parseGlossaryText(' | 링크워크 | 메모')).toEqual([])
  })
})

describe('buildSummaryContextBlock', () => {
  it('참석자도 용어도 없으면 빈 문자열', () => {
    expect(buildSummaryContextBlock({ glossary: [], rules: [], attendees: [] })).toBe('')
  })

  it('참석자와 용어를 함께 적는다', () => {
    const block = buildSummaryContextBlock({
      glossary: [
        { term: 'LinkWork', note: '사내 WBS 앱' },
        { term: 'Jira', note: null },
        { term: 'WBS', note: null }
      ],
      rules: [],
      attendees: [
        { member_id: 1, name: '홍길동', role: 'PM' },
        { member_id: 2, name: '김철수', role: null }
      ]
    })
    expect(block.split('\n')).toEqual([
      '[참고 정보]',
      '- 참석자: 홍길동(PM), 김철수',
      '- 용어: LinkWork — 사내 WBS 앱; Jira; WBS',
      '표기는 위 용어집을 따르세요. 담당자(assignee)는 위 참석자 이름 중에서만 고르고, 특정할 수 없으면 비워두세요. 참고 정보에만 있고 전사록에 없는 내용은 만들어내지 마세요.'
    ])
  })

  it('한쪽만 있으면 그 줄과 그에 맞는 지시문만 남긴다', () => {
    const onlyTerms = buildSummaryContextBlock({
      glossary: [{ term: 'Jira', note: null }],
      rules: [],
      attendees: []
    })
    expect(onlyTerms).toContain('- 용어: Jira')
    expect(onlyTerms).not.toContain('참석자')
    expect(onlyTerms).not.toContain('담당자')
    expect(onlyTerms.split('\n').at(-1)).toBe(
      '표기는 위 용어집을 따르세요. 참고 정보에만 있고 전사록에 없는 내용은 만들어내지 마세요.'
    )

    const onlyAttendees = buildSummaryContextBlock({
      glossary: [],
      rules: [],
      attendees: [{ member_id: 1, name: '홍길동', role: null }]
    })
    expect(onlyAttendees).toContain('- 참석자: 홍길동')
    expect(onlyAttendees).not.toContain('용어')
    expect(onlyAttendees.split('\n').at(-1)).toBe(
      '담당자(assignee)는 위 참석자 이름 중에서만 고르고, 특정할 수 없으면 비워두세요. 참고 정보에만 있고 전사록에 없는 내용은 만들어내지 마세요.'
    )
  })

  it('프롬프트 비대화를 막으려 용어 40개·메모 60자로 자른다', () => {
    const block = buildSummaryContextBlock({
      glossary: [
        { term: 'A', note: '가'.repeat(90) },
        ...Array.from({ length: 50 }, (_, i) => ({ term: `T${i}`, note: null }))
      ],
      rules: [],
      attendees: []
    })
    const termLine = block.split('\n').find((l) => l.startsWith('- 용어:')) as string
    expect(termLine.slice('- 용어: '.length).split('; ')).toHaveLength(40)
    expect(termLine).toContain(`A — ${'가'.repeat(60)}…`)
    expect(termLine).not.toContain('가'.repeat(61))
  })
})

describe('용어집 CRUD', () => {
  it('추가하고 다시 읽으면 aliases가 배열로 돌아온다', () => {
    const { id } = upsertGlossary(db, {
      term: ' LinkWork ',
      aliases: [' 링크워크 ', '', '링크워크', '링크웍'],
      note: '  사내 앱  ',
      priority: 5
    })
    const [row] = listGlossary(db)
    expect(row.id).toBe(id)
    expect(row.term).toBe('LinkWork')
    expect(row.aliases).toEqual(['링크워크', '링크웍'])
    expect(row.note).toBe('사내 앱')
    expect(row.priority).toBe(5)
    expect(row.enabled).toBe(1)
    expect(row.project_id).toBeNull()
  })

  it('id를 주면 갱신하고 행이 늘지 않는다', () => {
    const { id } = upsertGlossary(db, { term: 'Jira', aliases: ['지라'] })
    upsertGlossary(db, { id, term: 'Jira', aliases: ['지라', '자이라'], enabled: false })
    const rows = listGlossary(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].aliases).toEqual(['지라', '자이라'])
    expect(rows[0].enabled).toBe(0)
  })

  it('빈 용어는 거부한다', () => {
    expect(() => upsertGlossary(db, { term: '   ' })).toThrow()
  })

  it('삭제한다', () => {
    const { id } = upsertGlossary(db, { term: 'WBS' })
    removeGlossary(db, id)
    expect(listGlossary(db)).toHaveLength(0)
  })

  it('손상된 aliases JSON은 빈 배열로 흡수한다', () => {
    db.prepare("INSERT INTO stt_glossary (term, aliases) VALUES ('X', 'not-json')").run()
    expect(listGlossary(db)[0].aliases).toEqual([])
  })
})

describe('importGlossaryText', () => {
  it('새 항목은 added, 같은 term은 별칭 합집합으로 updated', () => {
    expect(importGlossaryText(db, 'LinkWork | 링크워크\nJira | 지라')).toEqual({
      added: 2,
      updated: 0,
      skipped: 0
    })
    expect(importGlossaryText(db, 'linkwork | 링크웍 | 사내 WBS 앱\nWBS')).toEqual({
      added: 1,
      updated: 1,
      skipped: 0
    })

    const link = listGlossary(db).find((g) => g.term === 'LinkWork') as { aliases: string[]; note: string | null }
    expect(link.aliases).toEqual(['링크워크', '링크웍'])
    expect(link.note).toBe('사내 WBS 앱')
    expect(listGlossary(db)).toHaveLength(3)
  })

  it('정답 표기가 없는 줄은 skipped로 센다', () => {
    expect(importGlossaryText(db, '# 주석\n\n | 별칭만\nJira')).toEqual({
      added: 1,
      updated: 0,
      skipped: 1
    })
  })

  it('메모가 없는 재가져오기는 기존 메모를 지우지 않는다', () => {
    importGlossaryText(db, 'Jira | 지라 | 이슈 트래커')
    importGlossaryText(db, 'Jira | 자이라')
    const [row] = listGlossary(db)
    expect(row.note).toBe('이슈 트래커')
    expect(row.aliases).toEqual(['지라', '자이라'])
  })
})

describe('구성원과 참석자', () => {
  it('구성원을 sort_order·이름 순으로 읽는다', () => {
    upsertMember(db, { name: '김철수', sort_order: 1 })
    upsertMember(db, { name: '홍길동', role: 'PM', aliases: ['길동님', ' '], sort_order: 0 })
    const members = listMembers(db)
    expect(members.map((m) => m.name)).toEqual(['홍길동', '김철수'])
    expect(members[0].aliases).toEqual(['길동님'])
    expect(members[0].role).toBe('PM')
  })

  it('참석자를 전량 교체하고, 없는 구성원 id는 무시한다', () => {
    const meetingId = seedMeeting('주간 회의')
    const a = upsertMember(db, { name: '홍길동', role: 'PM', sort_order: 0 })
    const b = upsertMember(db, { name: '김철수', sort_order: 1 })

    setAttendees(db, meetingId, [a.id, b.id, 9999])
    expect(listAttendees(db, meetingId)).toEqual([
      { member_id: a.id, name: '홍길동', role: 'PM' },
      { member_id: b.id, name: '김철수', role: null }
    ])

    setAttendees(db, meetingId, [b.id, b.id])
    expect(listAttendees(db, meetingId).map((x) => x.member_id)).toEqual([b.id])

    setAttendees(db, meetingId, [])
    expect(listAttendees(db, meetingId)).toEqual([])
  })

  it('비활성 구성원도 이미 지정된 참석자면 그대로 남는다', () => {
    const meetingId = seedMeeting('주간 회의')
    const a = upsertMember(db, { name: '홍길동' })
    setAttendees(db, meetingId, [a.id])
    upsertMember(db, { id: a.id, name: '홍길동', enabled: false })
    expect(listAttendees(db, meetingId)).toHaveLength(1)
  })

  it('구성원을 지우면 참석자 지정도 함께 사라진다', () => {
    const meetingId = seedMeeting('주간 회의')
    const a = upsertMember(db, { name: '홍길동' })
    setAttendees(db, meetingId, [a.id])
    removeMember(db, a.id)
    expect(listMembers(db)).toHaveLength(0)
    expect(listAttendees(db, meetingId)).toHaveLength(0)
  })
})

describe('loadPromptContext', () => {
  it('전역 용어 + 해당 프로젝트 용어만 우선순위 순으로 싣는다', () => {
    const p1 = seedProject('LinkWork')
    const p2 = seedProject('다른 프로젝트')
    const meetingId = seedMeeting('주간 회의', p1)

    upsertGlossary(db, { term: '전역', aliases: ['글로벌'], priority: 1 })
    upsertGlossary(db, { term: '프로젝트1', aliases: ['P1'], priority: 9, project_id: p1 })
    upsertGlossary(db, { term: '프로젝트2', aliases: ['P2'], priority: 9, project_id: p2 })
    upsertGlossary(db, { term: '꺼둠', aliases: ['off'], enabled: false })

    const ctx = loadPromptContext(db, meetingId)
    expect(ctx.glossary.map((g) => g.term)).toEqual(['프로젝트1', '전역'])
    expect(ctx.rules.map((r) => r.term)).toEqual(['프로젝트1', '전역'])
    expect(ctx.rules[0].aliases).toEqual(['P1'])
  })

  it('프로젝트가 없는 회의는 전역 용어만 본다', () => {
    const p1 = seedProject('LinkWork')
    const meetingId = seedMeeting('프로젝트 없는 회의', null)
    upsertGlossary(db, { term: '전역' })
    upsertGlossary(db, { term: '프로젝트1', project_id: p1 })
    expect(loadPromptContext(db, meetingId).glossary.map((g) => g.term)).toEqual(['전역'])
  })

  it('별칭이 없는 항목은 힌트로만 쓰고 치환 규칙에서는 뺀다', () => {
    const meetingId = seedMeeting('주간 회의')
    upsertGlossary(db, { term: '별칭없음' })
    const ctx = loadPromptContext(db, meetingId)
    expect(ctx.glossary.map((g) => g.term)).toEqual(['별칭없음'])
    expect(ctx.rules).toEqual([])
  })

  it('참석자를 함께 싣는다', () => {
    const meetingId = seedMeeting('주간 회의')
    const a = upsertMember(db, { name: '홍길동', role: 'PM' })
    setAttendees(db, meetingId, [a.id])
    expect(loadPromptContext(db, meetingId).attendees).toEqual([
      { member_id: a.id, name: '홍길동', role: 'PM' }
    ])
  })

  it('없는 회의를 물어도 전역 용어만 담긴 컨텍스트를 준다', () => {
    upsertGlossary(db, { term: '전역' })
    upsertGlossary(db, { term: '프로젝트1', project_id: seedProject('LinkWork') })
    const ctx = loadPromptContext(db, 999999)
    expect(ctx.glossary.map((g) => g.term)).toEqual(['전역'])
    expect(ctx.attendees).toEqual([])
  })

  it('조회 자체가 실패해도 throw하지 않고 빈 컨텍스트를 준다', () => {
    // 전사/요약 한가운데서 호출되므로, 보조 정보 조회 실패가 처리 실패로 번져선 안 된다.
    const meetingId = seedMeeting('주간 회의')
    upsertGlossary(db, { term: '전역' })
    db.exec('DROP TABLE stt_glossary')
    expect(loadPromptContext(db, meetingId)).toEqual({ glossary: [], rules: [], attendees: [] })
  })
})
