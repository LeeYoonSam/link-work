import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  BackupGroupId,
  BackupGroupStat,
  BackupManifest,
  BackupProgress,
  BackupSummary
} from '../../types'

// 백업·복원 모달이 두 섹션과 복원 확인 절차를 실제로 그리는지 고정한다.
//
// zustand v5는 서버 렌더(renderToStaticMarkup)에서 useSyncExternalStore의
// getServerSnapshot으로 **초기 상태**를 돌려준다. setState로 주입해도 렌더에 반영되지
// 않으므로 스토어 훅 자체를 모킹한다 (RecognitionAidsPanel.test.tsx와 같은 방식).

interface BackupState {
  exporting: boolean
  importing: boolean
  progress: BackupProgress | null
  lastExport: { path: string; manifest: BackupManifest } | null
  pickedSummary: BackupSummary | null
  stats: BackupGroupStat[] | null
  importWarnings: string[]
  restartPending: boolean
  error: string | null
}

const state: { backup: BackupState; recorderState: string } = {
  backup: {
    exporting: false,
    importing: false,
    progress: null,
    lastExport: null,
    pickedSummary: null,
    stats: null,
    importWarnings: [],
    restartPending: false,
    error: null
  },
  recorderState: 'idle'
}

const noop = async (): Promise<void> => {}

vi.mock('../../stores/backupStore', () => ({
  useBackupStore: () => ({
    ...state.backup,
    loadStats: noop,
    exportToFile: noop,
    pickBackup: noop,
    importBackup: noop,
    restart: noop,
    reset: () => {},
    subscribeProgress: () => () => {}
  })
}))

vi.mock('../../stores/recorderStore', () => ({
  useRecorderStore: (selector: (s: { state: string }) => unknown) =>
    selector({ state: state.recorderState })
}))

const BackupModal = (await import('./BackupModal')).default
const { formatBytes, isConfirmedFor } = await import('./BackupModal')
const { BACKUP_GROUP_IDS, confirmKey } = await import('./backupGroups')

const ALL: BackupGroupId[] = [...BACKUP_GROUP_IDS]

const manifest = (overrides: Partial<BackupManifest> = {}): BackupManifest => ({
  format: 'linkwork-backup',
  formatVersion: 2,
  groups: ['work', 'meetings', 'library', 'ai', 'settings'],
  appVersion: '1.0.0',
  createdAt: '2026-08-25T10:30:00',
  platform: 'darwin',
  db: { bytes: 2_800_000, tables: { projects: 4, tasks: 27, todos: 12, memos: 9, meetings: 31 } },
  files: {
    recordings: { count: 18, bytes: 2_254_857_830 },
    attachments: { count: 3, bytes: 1_048_576 }
  },
  excluded: ['auth_tokens', 'app_settings:notion_token'],
  ...overrides
})

const BACKUP_PATH = '/Users/me/Backups/LinkWork-backup-20260825-103000.zip'

const summary = (overrides: Partial<BackupSummary> = {}): BackupSummary => ({
  path: BACKUP_PATH,
  manifest: manifest(),
  warnings: [],
  ...overrides
})

// 인접한 텍스트 노드 사이에 React가 넣을 수 있는 주석 마커를 지워
// "라벨 + 값"처럼 표현식이 섞인 문자열도 통째로 검사할 수 있게 한다.
interface RenderOptions {
  exportGroups?: BackupGroupId[]
  restoreSelection?: { path: string; groups: BackupGroupId[] } | null
}

const render = (
  next: Partial<BackupState> = {},
  recorderState = 'idle',
  confirmedKey: string | null = null,
  opts: RenderOptions = {}
): string => {
  state.backup = {
    exporting: false,
    importing: false,
    progress: null,
    lastExport: null,
    pickedSummary: null,
    stats: null,
    importWarnings: [],
    restartPending: false,
    error: null,
    ...next
  }
  state.recorderState = recorderState
  return renderToStaticMarkup(
    <BackupModal
      onClose={() => {}}
      initialConfirmedKey={confirmedKey}
      initialExportGroups={opts.exportGroups}
      initialRestoreSelection={opts.restoreSelection ?? null}
    />
  ).replace(/<!-- -->/g, '')
}

// name 으로 체크박스 태그를 골라 value → {checked, disabled} 로 돌려준다.
// React 정적 마크업은 불리언 속성을 `checked=""`/`disabled=""` 로 내보낸다.
const checkboxes = (
  html: string,
  name: string
): Record<string, { checked: boolean; disabled: boolean }> => {
  const out: Record<string, { checked: boolean; disabled: boolean }> = {}
  for (const tag of html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`, 'g')) ?? []) {
    const value = /value="([^"]*)"/.exec(tag)?.[1] ?? ''
    out[value] = { checked: /\schecked=""/.test(tag), disabled: /\sdisabled=""/.test(tag) }
  }
  return out
}

const RESTORE = '선택 항목 복원 후 재시작'

// 버튼이 **정말** 잠겼는지 본다.
//
// `/<button[^>]*disabled[^>]*>/`로 쓰면 안 된다 — 모든 버튼의 class에 Tailwind의
// `disabled:opacity-40`이 들어 있어서 활성 버튼도 매치된다(그렇게 쓴 검사는 항상 통과한다).
// React가 실제 속성으로 내보내는 `disabled=""`만 인정한다.
// 라벨은 정규식 특수문자를 이스케이프한다 — "백업 파일(.zip) 저장…"의 괄호·점이 그대로 들어가면
// 문자 그대로가 아니라 그룹·임의 문자로 해석돼 어느 쪽 판정도 믿을 수 없다.
const buttonDisabled = (html: string, label: string): boolean => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`<button[^>]*\\sdisabled=""[^>]*>${escaped}</button>`).test(html)
}

// 버튼이 그 라벨로 실제로 그려졌는지(잠김 여부와 무관)
const hasButton = (html: string, label: string): boolean => html.includes(`>${label}</button>`)

describe('BackupModal', () => {
  it('buttonDisabled 헬퍼는 class의 disabled:* 유틸리티에 속지 않는다', () => {
    const active = `<button class="px-4 disabled:opacity-40 bg-red-50">${RESTORE}</button>`
    const locked = `<button disabled="" class="px-4 disabled:opacity-40">${RESTORE}</button>`
    expect(buttonDisabled(active, RESTORE)).toBe(false)
    expect(buttonDisabled(locked, RESTORE)).toBe(true)
  })

  it('초기 상태에서 안내 문구와 내보내기·가져오기 두 섹션을 그린다', () => {
    const html = render()
    expect(html).toContain('데이터 백업 · 복원')
    // 백업 한 벌은 폴더가 아니라 .zip 파일 하나이고, 고른 항목만 담고 되돌린다
    expect(html).toContain('선택한 항목을 파일 하나(.zip)로')
    expect(html).toContain('선택한 항목만 되돌립니다')
    expect(html).toContain('인증 토큰은 기기에')
    // 토큰 유지 정책 — 복원해도 이 기기의 연결은 남는다
    expect(html).toContain('복원해도 이 기기의 연결은 유지되며')
    expect(html).toContain('음성 모델은 자동으로 다시 내려받습니다')
    // 섹션 제목과 각 섹션의 시작 버튼
    expect(html).toContain('>내보내기</h4>')
    expect(html).toContain('>가져오기</h4>')
    expect(html).toContain('백업 파일(.zip) 저장…')
    expect(html).toContain('백업 파일(.zip) 선택…')
    // 아직 아무것도 고르지 않았으므로 복원 절차는 없다
    expect(html).not.toContain(RESTORE)
  })

  it('내보내기가 끝나면 저장한 .zip 경로와 회의·녹음 파일 요약을 보여준다', () => {
    const html = render({ lastExport: { path: BACKUP_PATH, manifest: manifest() } })
    expect(html).toContain(`저장 위치: ${BACKUP_PATH}`)
    expect(html).toContain('회의 31건')
    expect(html).toContain('녹음 파일 18개')
    expect(html).toContain('2.1 GB')
    // manifest 값은 압축 전 원본 크기다 — .zip 파일 크기로 읽히지 않게 라벨을 고정한다
    expect(html).toContain('담긴 데이터 2.1 GB')
    expect(html).not.toContain('전체 2.1 GB')
  })

  it('백업을 고르면 요약 카드·경고 문구를 그리고, 확인 체크 전에는 복원 버튼이 비활성이다', () => {
    const html = render({
      pickedSummary: summary({
        warnings: ['recordings: 파일 18개가 기록됐는데 실제로는 16개입니다']
      })
    })
    // 요약 카드 — 파일 경로·생성일·앱 버전·핵심 테이블 행수·녹음 파일
    expect(html).toContain(BACKUP_PATH)
    expect(html).toContain('생성일 2026-08-25 10:30')
    expect(html).toContain('앱 버전 1.0.0')
    expect(html).toContain('프로젝트 4건')
    expect(html).toContain('작업 27건')
    expect(html).toContain('TODO 12건')
    expect(html).toContain('메모 9건')
    expect(html).toContain('회의 31건')
    expect(html).toContain('녹음 파일 18개')
    // inspectBackup이 돌려준 경고를 그대로 옮긴다
    expect(html).toContain('recordings: 파일 18개가 기록됐는데 실제로는 16개입니다')
    // 빨간 경고 박스 — 교체(합치지 않음)와 보관 위치
    expect(html).toContain('<strong class="font-semibold">교체</strong>됩니다(합치지 않음)')
    expect(html).toContain('선택하지 않은 항목은 그대로 둡니다')
    expect(html).toContain('앱이 다시 시작되며')
    expect(html).toContain('직접 재시작합니다')
    expect(html).toContain('linkwork.db.bak-')
    expect(html).toContain('recordings.bak-')
    expect(html).toContain('ai-attachments.bak-')
    // 전체를 고르면 "일부만" 경고는 없고, 설정·연동이 들어 있어 재연결 경고는 있다
    expect(html).not.toContain('연결은 끊깁니다')
    expect(html).toContain('연동 계정이 백업과 다르면 그 연동은 다시 연결해야 합니다')
    // 확인 체크박스는 꺼져 있고 복원 버튼은 잠겨 있다
    expect(html).toContain(RESTORE)
    expect(buttonDisabled(html, RESTORE)).toBe(true)
    expect(html).toContain('위 확인란에 체크해야 복원할 수 있습니다')
  })

  it('확인 체크는 그 백업에만 걸린다 — 다른 백업을 고르면 풀린다', () => {
    const OTHER = '/Users/me/Backups/LinkWork-backup-20260701-090000.zip'

    // 같은 백업을 확인한 상태 — 체크가 켜져 있고 복원 버튼이 열린다
    const same = render({ pickedSummary: summary() }, 'idle', confirmKey(BACKUP_PATH, ALL))
    expect(checkboxes(same, 'restore-confirm')[''].checked).toBe(true)
    expect(buttonDisabled(same, RESTORE)).toBe(false)
    expect(same).not.toContain('위 확인란에 체크해야 복원할 수 있습니다')

    // 백업 A를 확인해 둔 채 B를 고르면, 확인은 A에 걸려 있으므로 B에는 적용되지 않는다.
    // 되돌릴 수 없는 동작이라 요약을 읽지 않은 백업이 즉시 복원되면 안 된다.
    const other = render(
      { pickedSummary: summary({ path: OTHER }) },
      'idle',
      confirmKey(BACKUP_PATH, ALL)
    )
    expect(checkboxes(other, 'restore-confirm')[''].checked).toBe(false)
    expect(buttonDisabled(other, RESTORE)).toBe(true)
    expect(other).toContain('위 확인란에 체크해야 복원할 수 있습니다')
  })

  it('isConfirmedFor는 경로가 정확히 같을 때만 확인으로 본다', () => {
    expect(isConfirmedFor('/a.zip', '/a.zip')).toBe(true)
    expect(isConfirmedFor('/a.zip', '/b.zip')).toBe(false)
    // 고른 백업이 없는데 확인만 남아 있는 경우
    expect(isConfirmedFor('/a.zip', null)).toBe(false)
    // 아무것도 확인하지 않은 경우 — null끼리 같다고 통과시키면 안 된다
    expect(isConfirmedFor(null, null)).toBe(false)
    expect(isConfirmedFor(null, '/a.zip')).toBe(false)
  })

  it('녹음 중이면 복원 버튼을 잠그고 사유를 알린다', () => {
    const html = render({ pickedSummary: summary() }, 'recording', confirmKey(BACKUP_PATH, ALL))
    expect(buttonDisabled(html, RESTORE)).toBe(true)
    expect(html).toContain('녹음 중에는 복원할 수 없습니다')
  })

  it('진행 중이면 진행 바를 그 비율만큼 그린다', () => {
    const html = render({
      exporting: true,
      progress: { phase: 'files', progress: 0.42, message: '녹음 파일 복사 중 (8/18)' }
    })
    expect(html).toContain('width:42%')
    expect(html).toContain('녹음 파일 복사 중 (8/18)')
    // 작업 중에는 닫기 버튼도 잠근다
    expect(buttonDisabled(html, '닫기')).toBe(true)
  })

  it('message가 없으면 방향에 맞는 단계 문구로 되돌아간다', () => {
    // 같은 phase:'files'라도 내보낼 땐 묶고, 복원할 땐 푼다 — 한 문구로 뭉뚱그리지 않는다
    const exporting = render({
      exporting: true,
      progress: { phase: 'files', progress: 0.3 }
    })
    expect(exporting).toContain('파일 압축 중')

    const importing = render({
      importing: true,
      pickedSummary: summary(),
      progress: { phase: 'files', progress: 0.6 }
    })
    expect(importing).toContain('파일 복원 중')
    expect(importing).not.toContain('파일 압축 중')
  })

  it('복원 경고가 있어 재시작이 멈추면 경고와 [확인 후 재시작]만 보여주고 다른 조작은 막는다', () => {
    const html = render({
      importing: true,
      restartPending: true,
      pickedSummary: summary(),
      importWarnings: [
        'Jira 연동 계정이 백업과 달라 현재 연결을 지웠습니다. 다시 연결하세요.',
        '오늘 계획 항목 2건의 회의 연결이 확인되지 않습니다.'
      ]
    })
    expect(html).toContain('data-testid="restart-pending"')
    expect(html).toContain('Jira 연동 계정이 백업과 달라 현재 연결을 지웠습니다')
    expect(html).toContain('오늘 계획 항목 2건의 회의 연결이 확인되지 않습니다')
    expect(hasButton(html, '확인 후 재시작')).toBe(true)
    expect(buttonDisabled(html, '확인 후 재시작')).toBe(false)
    // 내보내기·가져오기 섹션은 그리지 않는다 — DB 가 이미 바뀌어 다른 조작을 열면 안 된다
    expect(html).not.toContain('>내보내기</h4>')
    expect(html).not.toContain('>가져오기</h4>')
    expect(html).not.toContain('name="export-group"')
    expect(html).not.toContain('name="restore-group"')
    expect(html).not.toContain(RESTORE)
    // 닫기도 잠긴다
    expect(buttonDisabled(html, '닫기')).toBe(true)
  })

  it('경고 없이 복원되면(restartPending=false) 지금처럼 재시작 중 표시만 한다', () => {
    const html = render({ importing: true, pickedSummary: summary() })
    expect(html).not.toContain('data-testid="restart-pending"')
    expect(html).not.toContain('확인 후 재시작')
    expect(html).toContain('재시작 중...')
  })

  it('실패 사유를 빨간 안내로 보여준다', () => {
    const html = render({ error: '백업 파일에 manifest.json이 없습니다' })
    expect(html).toContain('백업 파일에 manifest.json이 없습니다')
    expect(html).toContain('bg-red-50')
  })

  it('formatBytes는 단위를 올려가며 GB에서 멈춘다', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(2_254_857_830)).toBe('2.1 GB')
    // TB로는 올라가지 않는다
    expect(formatBytes(1024 ** 4)).toBe('1024.0 GB')
  })
})

describe('BackupModal 그룹 선택 (docs/DATA_BACKUP.md §1)', () => {
  const stats: BackupGroupStat[] = [
    { id: 'work', tables: { projects: 3, todos: 10 }, files: { count: 0, bytes: 0 } },
    { id: 'meetings', tables: { meetings: 20 }, files: { count: 12, bytes: 1_048_576 } },
    {
      id: 'library',
      tables: { documents: 2, memos: 5, variables: 1 },
      files: { count: 0, bytes: 0 }
    },
    { id: 'ai', tables: { ai_chats: 7 }, files: { count: 2, bytes: 2048 } },
    { id: 'settings', tables: { app_settings: 14 }, files: { count: 0, bytes: 0 } }
  ]

  it('R1 내보내기 체크박스 5개가 고정 순서로 있고 기본은 전체 선택이다', () => {
    const html = render({ stats })
    const boxes = checkboxes(html, 'export-group')
    expect(Object.keys(boxes)).toEqual(ALL)
    for (const id of ALL) expect(boxes[id]).toEqual({ checked: true, disabled: false })
    // 그룹 이름은 메뉴 이름으로 읽힌다
    expect(html).toContain('오늘·업무')
    expect(html).toContain('오늘, 프로젝트(릴리스 탭 포함), 할 일')
    expect(html).toContain('녹음, 회의록')
    expect(html).toContain('메모, 변수, 예전 문서 메뉴의 문서')
    // backup:stats 숫자와 파일 용량
    expect(html).toContain('프로젝트 3건 · 할 일 10건')
    expect(html).toContain('회의 20건 · 녹음 파일 12개 · 1.0 MB')
    expect(html).toContain('대화 7건 · 첨부 파일 2개 · 2.0 KB')
    // 설정은 행이 아니라 키라 단위가 '개'다
    expect(html).toContain('설정 키 14개')
    expect(hasButton(html, '백업 파일(.zip) 저장…')).toBe(true)
    expect(buttonDisabled(html, '백업 파일(.zip) 저장…')).toBe(false)
  })

  it('R1 stats 를 못 받아도 체크박스와 내보내기는 그대로 쓸 수 있다', () => {
    const html = render({ stats: null })
    expect(Object.keys(checkboxes(html, 'export-group'))).toEqual(ALL)
    expect(html).not.toContain('프로젝트 3건')
    expect(buttonDisabled(html, '백업 파일(.zip) 저장…')).toBe(false)
  })

  it('R2 선택이 0개면 내보내기 버튼이 비활성이고 사유를 알린다', () => {
    const none = render({}, 'idle', null, { exportGroups: [] })
    expect(buttonDisabled(none, '백업 파일(.zip) 저장…')).toBe(true)
    expect(none).toContain('내보낼 항목을 하나 이상 고르세요')
    for (const box of Object.values(checkboxes(none, 'export-group'))) {
      expect(box.checked).toBe(false)
    }

    const one = render({}, 'idle', null, { exportGroups: ['library'] })
    expect(hasButton(one, '백업 파일(.zip) 저장…')).toBe(true)
    expect(buttonDisabled(one, '백업 파일(.zip) 저장…')).toBe(false)
    expect(checkboxes(one, 'export-group').library.checked).toBe(true)
    expect(checkboxes(one, 'export-group').work.checked).toBe(false)
  })

  it('R3 파일에 없는 그룹은 비활성·미선택이며 "이 백업에 없음"으로 표시한다', () => {
    const partial = summary({
      manifest: manifest({
        groups: ['meetings', 'library'],
        db: { bytes: 1000, tables: { meetings: 31, documents: 4, memos: 9, variables: 0 } }
      })
    })
    const html = render({ pickedSummary: partial, stats })
    const boxes = checkboxes(html, 'restore-group')
    expect(Object.keys(boxes)).toEqual(ALL)
    expect(boxes.meetings).toEqual({ checked: true, disabled: false })
    expect(boxes.library).toEqual({ checked: true, disabled: false })
    for (const id of ['work', 'ai', 'settings']) {
      expect(boxes[id]).toEqual({ checked: false, disabled: true })
    }
    expect(html.match(/이 백업에 없음/g)?.length).toBe(3)
    // 현재 N건 → 백업 M건 (stats 와 manifest.db.tables)
    expect(html).toContain('회의 현재 20건 → 백업 31건')
    expect(html).toContain('문서·메모·변수 현재 8건 → 백업 13건')
    // 설정·연동은 현재·백업의 세는 기준이 달라 비교하지 않고 현재 키 수만 보인다
    const full = render({ pickedSummary: summary(), stats })
    expect(full).toContain('현재 설정 키 14개')
    expect(full).not.toMatch(/설정 키[^<]*→ 백업/)
    // 일부만 복원 → 연결이 끊길 수 있다는 경고, 설정은 없으니 재연결 경고는 없다
    expect(html).toContain('연결은 끊깁니다')
    expect(html).not.toContain('그 연동은 다시 연결해야 합니다')
    expect(html).not.toContain('이전 형식(전체) 백업')
  })

  it('R4 그룹 선택을 바꾸면 confirmKey 가 달라져 확인이 풀린다', () => {
    // 키는 경로와 정렬된 그룹 — 클릭 순서와 무관하다
    expect(confirmKey('/a.zip', ['work', 'meetings'])).toBe(
      confirmKey('/a.zip', ['meetings', 'work'])
    )
    expect(confirmKey('/a.zip', ALL)).not.toBe(confirmKey('/a.zip', ['work']))
    expect(confirmKey('/a.zip', ['work'])).not.toBe(confirmKey('/b.zip', ['work']))

    // 전체를 확인해 둔 상태에서 회의만 남기면 확인은 풀리고 복원 버튼이 잠긴다
    const changed = render({ pickedSummary: summary() }, 'idle', confirmKey(BACKUP_PATH, ALL), {
      restoreSelection: { path: BACKUP_PATH, groups: ['meetings'] }
    })
    expect(checkboxes(changed, 'restore-confirm')[''].checked).toBe(false)
    expect(buttonDisabled(changed, RESTORE)).toBe(true)
    expect(changed).toContain('위 확인란에 체크해야 복원할 수 있습니다')

    // 같은 조합을 확인한 경우에만 열린다
    const same = render(
      { pickedSummary: summary() },
      'idle',
      confirmKey(BACKUP_PATH, ['meetings']),
      { restoreSelection: { path: BACKUP_PATH, groups: ['meetings'] } }
    )
    expect(checkboxes(same, 'restore-confirm')[''].checked).toBe(true)
    expect(buttonDisabled(same, RESTORE)).toBe(false)

    // 다른 백업에 대한 선택은 쓰지 않고 그 백업의 전체(기본값)로 돌아간다
    const stale = render({ pickedSummary: summary() }, 'idle', null, {
      restoreSelection: { path: '/other.zip', groups: ['meetings'] }
    })
    for (const box of Object.values(checkboxes(stale, 'restore-group'))) {
      expect(box.checked).toBe(true)
    }

    // 하나도 고르지 않으면 확인도 복원도 할 수 없다
    const empty = render({ pickedSummary: summary() }, 'idle', confirmKey(BACKUP_PATH, []), {
      restoreSelection: { path: BACKUP_PATH, groups: [] }
    })
    expect(buttonDisabled(empty, RESTORE)).toBe(true)
    expect(empty).toContain('복원할 항목을 하나 이상 고르세요')
  })

  it('R5 v1 백업은 "이전 형식(전체) 백업"으로 표시하고 5개 그룹을 모두 고를 수 있다', () => {
    // main 이 groups 를 채워 주지 않은 경우까지 방어한다
    const { groups: _omit, ...legacy } = manifest({ formatVersion: 1 })
    void _omit
    const html = render({
      pickedSummary: summary({ manifest: legacy as BackupManifest })
    })
    expect(html).toContain('이전 형식(전체) 백업')
    const boxes = checkboxes(html, 'restore-group')
    for (const id of ALL) expect(boxes[id]).toEqual({ checked: true, disabled: false })
    expect(html).not.toContain('이 백업에 없음')

    const v2 = render({ pickedSummary: summary() })
    expect(v2).not.toContain('이전 형식(전체) 백업')
  })

  it('R12 요약 카드는 백업에 없는 그룹의 건수·녹음 줄을 0건으로 그리지 않는다', () => {
    const aiOnly = summary({
      manifest: manifest({
        groups: ['ai'],
        db: { bytes: 1000, tables: { ai_chats: 4 } },
        files: { recordings: { count: 0, bytes: 0 }, attachments: { count: 2, bytes: 2048 } }
      })
    })
    const html = render({ pickedSummary: aiOnly })
    expect(html).not.toContain('프로젝트 0건')
    expect(html).not.toContain('회의 0건')
    expect(html).not.toContain('녹음 파일 0개')
    // 백업에 있는 그룹은 그대로 보인다
    const full = render({ pickedSummary: summary() })
    expect(full).toContain('프로젝트 4건')
    expect(full).toContain('녹음 파일 18개')
  })

  it('R12 방금 내보낸 백업이 회의를 뺐으면 회의·녹음 줄을 그리지 않는다', () => {
    const libraryOnly = manifest({
      groups: ['library'],
      db: { bytes: 1000, tables: { memos: 3 } },
      files: { recordings: { count: 0, bytes: 0 }, attachments: { count: 0, bytes: 0 } }
    })
    const html = render({
      lastExport: { path: '/tmp/x.zip', manifest: libraryOnly }
    })
    expect(html).toContain('담은 항목: 자료')
    expect(html).not.toContain('녹음 파일 0개')
  })
})
