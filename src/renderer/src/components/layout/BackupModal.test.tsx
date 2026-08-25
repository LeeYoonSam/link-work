import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BackupManifest, BackupProgress, BackupSummary } from '../../types'

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
  error: string | null
}

const state: { backup: BackupState; recorderState: string } = {
  backup: {
    exporting: false,
    importing: false,
    progress: null,
    lastExport: null,
    pickedSummary: null,
    error: null
  },
  recorderState: 'idle'
}

const noop = async (): Promise<void> => {}

vi.mock('../../stores/backupStore', () => ({
  useBackupStore: () => ({
    ...state.backup,
    exportToFile: noop,
    pickBackup: noop,
    importBackup: noop,
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

const manifest = (overrides: Partial<BackupManifest> = {}): BackupManifest => ({
  format: 'linkwork-backup',
  formatVersion: 1,
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
const render = (
  next: Partial<BackupState> = {},
  recorderState = 'idle',
  confirmedPath: string | null = null
): string => {
  state.backup = {
    exporting: false,
    importing: false,
    progress: null,
    lastExport: null,
    pickedSummary: null,
    error: null,
    ...next
  }
  state.recorderState = recorderState
  return renderToStaticMarkup(
    <BackupModal onClose={() => {}} initialConfirmedPath={confirmedPath} />
  ).replace(/<!-- -->/g, '')
}

// 버튼이 **정말** 잠겼는지 본다.
//
// `/<button[^>]*disabled[^>]*>/`로 쓰면 안 된다 — 모든 버튼의 class에 Tailwind의
// `disabled:opacity-40`이 들어 있어서 활성 버튼도 매치된다(그렇게 쓴 검사는 항상 통과한다).
// React가 실제 속성으로 내보내는 `disabled=""`만 인정한다.
const buttonDisabled = (html: string, label: string): boolean =>
  new RegExp(`<button[^>]*\\sdisabled=""[^>]*>${label}</button>`).test(html)

describe('BackupModal', () => {
  it('buttonDisabled 헬퍼는 class의 disabled:* 유틸리티에 속지 않는다', () => {
    const active = '<button class="px-4 disabled:opacity-40 bg-red-50">복원 후 재시작</button>'
    const locked = '<button disabled="" class="px-4 disabled:opacity-40">복원 후 재시작</button>'
    expect(buttonDisabled(active, '복원 후 재시작')).toBe(false)
    expect(buttonDisabled(locked, '복원 후 재시작')).toBe(true)
  })

  it('초기 상태에서 안내 문구와 내보내기·가져오기 두 섹션을 그린다', () => {
    const html = render()
    expect(html).toContain('데이터 백업 · 복원')
    // 백업 한 벌은 폴더가 아니라 .zip 파일 하나다
    expect(html).toContain('앱 데이터 전체를 파일 하나(.zip)로')
    expect(html).toContain('Google/Notion/Jira 인증 정보는 기기에 묶여 있어 제외되며')
    expect(html).toContain('음성 모델은 자동으로 다시 내려받습니다')
    // 섹션 제목과 각 섹션의 시작 버튼
    expect(html).toContain('>내보내기</h4>')
    expect(html).toContain('>가져오기</h4>')
    expect(html).toContain('백업 파일(.zip) 저장…')
    expect(html).toContain('백업 파일(.zip) 선택…')
    // 아직 아무것도 고르지 않았으므로 복원 절차는 없다
    expect(html).not.toContain('복원 후 재시작')
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
    // 빨간 경고 박스
    expect(html).toContain('모두 대체')
    expect(html).toContain('앱이 다시 시작됩니다')
    expect(html).toContain('linkwork.db.bak-')
    // 확인 체크박스는 꺼져 있고 복원 버튼은 잠겨 있다
    expect(html).toContain('복원 후 재시작')
    expect(buttonDisabled(html, '복원 후 재시작')).toBe(true)
    expect(html).toContain('위 확인란에 체크해야 복원할 수 있습니다')
  })

  it('확인 체크는 그 백업에만 걸린다 — 다른 백업을 고르면 풀린다', () => {
    const OTHER = '/Users/me/Backups/LinkWork-backup-20260701-090000.zip'

    // 같은 백업을 확인한 상태 — 체크가 켜져 있고 복원 버튼이 열린다
    const same = render({ pickedSummary: summary() }, 'idle', BACKUP_PATH)
    expect(same).toMatch(/<input[^>]*type="checkbox"[^>]*checked[^>]*\/?>/)
    expect(buttonDisabled(same, '복원 후 재시작')).toBe(false)
    expect(same).not.toContain('위 확인란에 체크해야 복원할 수 있습니다')

    // 백업 A를 확인해 둔 채 B를 고르면, 확인은 A에 걸려 있으므로 B에는 적용되지 않는다.
    // 되돌릴 수 없는 동작이라 요약을 읽지 않은 백업이 즉시 복원되면 안 된다.
    const other = render({ pickedSummary: summary({ path: OTHER }) }, 'idle', BACKUP_PATH)
    expect(other).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked[^>]*\/?>/)
    expect(buttonDisabled(other, '복원 후 재시작')).toBe(true)
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
    const html = render({ pickedSummary: summary() }, 'recording')
    expect(buttonDisabled(html, '복원 후 재시작')).toBe(true)
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
