import type { BackupGroupId, BackupGroupStat, BackupManifest } from '../../types'

// 백업 그룹의 화면 표현과 순수 헬퍼 (docs/DATA_BACKUP.md §1).
//
// 그룹 ID 와 순서는 main 의 services/backup-groups.ts 의 BACKUP_GROUP_IDS 와 같다.
// 사용자는 테이블 이름이 아니라 메뉴 이름으로 데이터를 떠올리므로, 라벨·설명은 사이드바 메뉴를 따른다.

export const BACKUP_GROUP_IDS: readonly BackupGroupId[] = [
  'work',
  'meetings',
  'library',
  'ai',
  'settings'
]

export interface BackupGroupDef {
  id: BackupGroupId
  /** 체크박스 라벨 */
  label: string
  /** 이 그룹에 든 메뉴·데이터 — 라벨 옆 보조 문구 */
  menus: string
  /**
   * 건수를 보여줄 대표 테이블. 전체 테이블을 다 세면 숫자가 뜻을 잃으므로
   * 사용자가 "내 데이터"로 세는 것만 고른다. settings 는 app_settings 키 수다.
   */
  counts: ReadonlyArray<{ table: string; label: string }>
  /** 녹음·첨부처럼 파일 폴더가 따라가는 그룹 */
  files: { label: string } | null
  /**
   * 복원 화면에서 "현재 N → 백업 M" 비교를 할 수 있는가. settings 는 현재 쪽(stats)이
   * settings 키만, 백업 쪽(manifest.db.tables.app_settings)이 app_settings 전체 행을 세서
   * 기준이 달라 비교하면 숫자가 어긋난다 — 그래서 현재 키 수만 보여준다.
   */
  comparable: boolean
  /** 건수 단위. 설정은 행이 아니라 키라 '개' */
  unit: string
}

export const BACKUP_GROUPS: readonly BackupGroupDef[] = [
  {
    id: 'work',
    label: '오늘·업무',
    menus: '오늘, 프로젝트(릴리스 탭 포함), 할 일',
    counts: [
      { table: 'projects', label: '프로젝트' },
      { table: 'todos', label: '할 일' }
    ],
    files: null,
    comparable: true,
    unit: '건'
  },
  {
    id: 'meetings',
    label: '회의',
    menus: '녹음, 회의록, 용어집·구성원',
    counts: [{ table: 'meetings', label: '회의' }],
    files: { label: '녹음 파일' },
    comparable: true,
    unit: '건'
  },
  {
    id: 'library',
    label: '자료',
    menus: '메모, 변수, 예전 문서 메뉴의 문서',
    counts: [
      { table: 'documents', label: '문서' },
      { table: 'memos', label: '메모' },
      { table: 'variables', label: '변수' }
    ],
    files: null,
    comparable: true,
    unit: '건'
  },
  {
    id: 'ai',
    label: 'AI 대화',
    menus: 'AI 대화, 첨부 이미지',
    counts: [{ table: 'ai_chats', label: '대화' }],
    files: { label: '첨부 파일' },
    comparable: true,
    unit: '건'
  },
  {
    id: 'settings',
    label: '설정·연동',
    menus: '비서·AI 모델 설정, Jira·Google·Bitbucket 연결 정보(토큰 제외)',
    counts: [{ table: 'app_settings', label: '설정 키' }],
    files: null,
    comparable: false,
    unit: '개'
  }
]

/** 고정 순서로 정렬하고 중복·모르는 값을 뺀다 */
export function orderGroups(groups: readonly unknown[]): BackupGroupId[] {
  return BACKUP_GROUP_IDS.filter((id) => groups.includes(id))
}

/** 체크박스 하나를 켜고 끈 결과. 순서는 늘 고정 순서다. */
export function toggleGroup(
  selected: readonly BackupGroupId[],
  id: BackupGroupId
): BackupGroupId[] {
  return selected.includes(id)
    ? orderGroups(selected.filter((g) => g !== id))
    : orderGroups([...selected, id])
}

/** 내보내기는 그룹이 하나 이상일 때만 할 수 있다 */
export function canExport(selected: readonly BackupGroupId[]): boolean {
  return orderGroups(selected).length > 0
}

/** formatVersion 1 은 그룹 개념이 없던 "이전 형식" — 언제나 전체 백업이었다 */
export function isLegacyBackup(manifest: Pick<BackupManifest, 'formatVersion'>): boolean {
  return manifest.formatVersion < 2
}

/**
 * 백업에 든 그룹. main 이 v1 을 전체로 정규화해 내려주지만, 혹시 groups 가 빠져 와도
 * v1 이면 전체로 본다. v2 인데 groups 가 없으면 아무 그룹도 고를 수 없게 빈 배열이다.
 */
export function manifestGroups(
  manifest: Pick<BackupManifest, 'formatVersion'> & {
    groups?: readonly unknown[]
  }
): BackupGroupId[] {
  if (Array.isArray(manifest.groups)) return orderGroups(manifest.groups)
  return isLegacyBackup(manifest) ? [...BACKUP_GROUP_IDS] : []
}

/**
 * 복원 확인 체크의 키. 어느 백업의 **어느 그룹 조합**을 확인했는지를 담는다.
 * 그룹 선택을 바꾸면 키가 달라져 확인이 저절로 풀린다(isConfirmedFor 와 짝).
 * 그룹은 고정 순서로 정렬하므로 같은 조합이면 클릭 순서와 무관하게 같은 키다.
 */
export function confirmKey(path: string, groups: readonly BackupGroupId[]): string {
  return `${path}|${orderGroups(groups).join(',')}`
}

/** 대표 테이블 행 수의 합. 테이블이 없으면 0 으로 센다. */
export function groupRowCount(
  def: Pick<BackupGroupDef, 'counts'>,
  tables: Record<string, number> | undefined
): number {
  if (!tables) return 0
  return def.counts.reduce((sum, c) => sum + (tables[c.table] ?? 0), 0)
}

/** 대표 테이블 이름을 "프로젝트·할 일" 처럼 잇는다 */
export function countLabel(def: Pick<BackupGroupDef, 'counts'>): string {
  return def.counts.map((c) => c.label).join('·')
}

export function findStat(
  stats: readonly BackupGroupStat[] | null | undefined,
  id: BackupGroupId
): BackupGroupStat | undefined {
  return stats?.find((s) => s.id === id)
}

/** 백업에 담긴 그룹 파일 (manifest 기준). 파일이 없는 그룹은 null */
export function manifestFiles(
  manifest: Pick<BackupManifest, 'files'>,
  id: BackupGroupId
): { count: number; bytes: number } | null {
  if (id === 'meetings') return manifest.files.recordings
  if (id === 'ai') return manifest.files.attachments
  return null
}

/** 일부 그룹만 복원하면 다른 기기·시점 데이터와 섞여 그룹 간 연결이 끊길 수 있다 */
export function isPartialSelection(selected: readonly BackupGroupId[]): boolean {
  return orderGroups(selected).length < BACKUP_GROUP_IDS.length
}
