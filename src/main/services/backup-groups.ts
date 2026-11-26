// 백업 그룹 정의 (docs/DATA_BACKUP.md)
//
// 백업·복원은 아래 5개 그룹 단위로 고른다. 모든 테이블은 정확히 한 그룹에 속하거나
// 백업 제외(NON_GROUP_TABLES)다 — backup-groups.test.ts G1 이 sqlite_master 전체로 검사한다.
// 새 테이블을 만들면 여기에 배정해야 테스트가 통과한다(조용히 빠지는 것을 막는다).
//
// 정책: 그룹을 추가하거나 그룹의 의미를 바꾸면 backup-service 의 BACKUP_FORMAT_VERSION 을 올린다.
//
// 이 모듈은 electron·better-sqlite3 를 import 하지 않는다(렌더러 없이 Node 테스트에서 로드).

export type BackupGroupId = 'work' | 'meetings' | 'library' | 'ai' | 'settings'

/** 고정 순서. manifest.groups 와 UI 표시 순서가 이것을 따른다. */
export const BACKUP_GROUP_IDS: readonly BackupGroupId[] = [
  'work',
  'meetings',
  'library',
  'ai',
  'settings'
]

/**
 * 그룹별 테이블. 부모 테이블을 앞에 둔다(FK 를 끈 채 다루므로 순서가 필수는 아니다).
 * - work: 오늘(비서) 기록을 포함한다. plan_items.candidate_id 가 `task:<id>`·`todo:<id>` 로
 *   작업·할 일을 가리키고 렌더러의 "원본 완료"가 그 id 로 직접 완료를 호출하므로 떼어 놓으면
 *   엉뚱한 할 일이 완료될 수 있다.
 * - meetings: meeting_attendees 가 meeting_members 를 FK 로 가리키므로 구성원·용어집을 함께 둔다.
 *   목소리(meeting_speaker_voices·member_voice_samples)도 화자·구성원을 FK 로 가리켜 같은 그룹이다.
 * - settings: 테이블이 없다. app_settings 를 키 단위로 나눈다(classifySettingKey).
 */
export const GROUP_TABLES: Record<BackupGroupId, readonly string[]> = {
  work: [
    'projects',
    'tasks',
    'todos',
    'todo_tags',
    'todo_tag_map',
    'todo_history',
    'release_notes',
    'release_note_items',
    'activity_log',
    'daily_plans',
    'plan_items',
    'assistant_events',
    'assistant_exclusions'
  ],
  meetings: [
    'meetings',
    'meeting_speakers',
    'meeting_segments',
    'meeting_cuts',
    'meeting_summaries',
    'meeting_marks',
    'meeting_members',
    'meeting_attendees',
    'meeting_speaker_voices',
    'member_voice_samples',
    'stt_glossary'
  ],
  library: ['documents', 'memo_categories', 'memos', 'variables'],
  ai: ['ai_chats', 'ai_messages', 'ai_audit_log'],
  settings: []
}

/** userData 아래에서 그룹과 함께 옮기는 폴더 */
export type BackupFileDir = 'recordings' | 'ai-attachments'

export const GROUP_FILE_DIRS: Record<BackupGroupId, readonly BackupFileDir[]> = {
  work: [],
  meetings: ['recordings'],
  library: [],
  ai: ['ai-attachments'],
  settings: []
}

/**
 * 그룹에 속하지 않는 테이블.
 * - app_settings: 키 단위로 work/settings/secret 에 나뉜다(classifySettingKey).
 * - auth_tokens: 기기 종속 시크릿. 백업에서 늘 뺀다.
 * - jira_board_issues·jira_board_sync: 프로젝트 보드 캐시(CACHE_TABLES). Jira에서 다시 받는다.
 * - jira_epic_summaries: 보드 캐시에서 만든 에픽 AI 요약(CACHE_TABLES). 버튼으로 다시 만든다.
 */
export const NON_GROUP_TABLES: readonly string[] = [
  'app_settings',
  'auth_tokens',
  'jira_board_issues',
  'jira_board_sync',
  'jira_epic_summaries'
]

/**
 * 원본에서 다시 받을 수 있는 캐시 테이블. 백업 사본에서 행을 지운다(테이블은 남긴다).
 * 복원 뒤 캐시가 비어 있으면 화면이 전체 동기화를 한다.
 */
export const CACHE_TABLES: readonly string[] = ['jira_board_issues', 'jira_board_sync', 'jira_epic_summaries']

/** 부분 백업에서 빠진 부모 테이블의 (id, created_at) 만 담는 테이블. 내용은 넣지 않는다. */
export const BACKUP_REFS_TABLE = 'linkwork_backup_refs'

/** 행을 통째로 지우는 테이블(테이블 자체는 남긴다 — 스키마가 달라지면 복원 후 마이그레이션이 꼬인다) */
export const SECRET_TABLES: readonly string[] = ['auth_tokens']

/**
 * app_settings에서 지우는 키 — safeStorage로 암호화해 저장하는 값만.
 * - `notion_token`: services/notion.ts (TOKEN_KEY, encrypt로 저장)
 * - `jira_api_token`: services/jira.ts (TOKEN_KEY, encrypt로 저장)
 * - `google_client_secret`: services/google-auth.ts saveSettings (encrypt로 저장 — 새 PC에서 다시 입력)
 * - `bitbucket_api_token`: services/bitbucket.ts (TOKEN_KEY, encrypt로 저장)
 * - 기기 전용 키(DEVICE_ONLY_SETTING_KEYS)도 여기에 포함한다 — 연동 자격은 아니지만 다른 PC 로 옮기면 안 된다.
 * google_client_id, jira_site_url 같은 평문 설정은 기기 종속이 아니라 **남긴다**.
 */
export const SECRET_SETTING_KEYS: readonly string[] = [
  'notion_token',
  'jira_api_token',
  'google_client_secret',
  'bitbucket_api_token',
  'mobile_server_token',
  'mobile_server_enabled'
]

/**
 * 연동 자격이 아닌 기기 전용 키(SECRET_SETTING_KEYS 의 부분집합). 백업 사본에서 지우고 복원 때 가져오지 않는다.
 * - `mobile_server_token`: services/mobile/settings.ts 페어링 토큰(safeStorage 암호문)
 * - `mobile_server_enabled`: 휴대폰 열람 서버 켜짐 여부. 새 PC 로 복원했을 때 서버가 저절로 켜지면 안 된다
 */
export const DEVICE_ONLY_SETTING_KEYS: readonly string[] = ['mobile_server_token', 'mobile_server_enabled']

/** work 그룹에 속하는 app_settings 키. 옛 Jira 싱크업이 남긴 값이라 백업·복원 대상으로 유지한다 */
const WORK_SETTING_KEYS: readonly string[] = ['project_sync_created_keys']

type SettingKeyClass = 'work' | 'settings' | 'secret'

/** app_settings 키를 분류한다. 분류되지 않은 키는 모두 settings 다(기본값). */
export function classifySettingKey(key: string): SettingKeyClass {
  if (SECRET_SETTING_KEYS.includes(key)) return 'secret'
  if (WORK_SETTING_KEYS.includes(key)) return 'work'
  return 'settings'
}

export function isBackupGroupId(v: unknown): v is BackupGroupId {
  return typeof v === 'string' && (BACKUP_GROUP_IDS as readonly string[]).includes(v)
}

/**
 * 외부 입력(IPC·manifest)을 그룹 목록으로 정규화한다.
 * 배열이 아니거나, 비었거나, 모르는 id 가 하나라도 있으면 null. 중복은 합치고 고정 순서로 정렬한다.
 */
export function normalizeGroups(v: unknown): BackupGroupId[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  if (!v.every(isBackupGroupId)) return null
  const set = new Set<BackupGroupId>(v)
  return BACKUP_GROUP_IDS.filter((g) => set.has(g))
}

/** 그룹 목록이 고른 테이블 전체 (고정 그룹 순서, 그룹 안 순서 유지) */
export function tablesForGroups(groups: readonly BackupGroupId[]): string[] {
  return BACKUP_GROUP_IDS.filter((g) => groups.includes(g)).flatMap((g) => [...GROUP_TABLES[g]])
}

/** 테이블이 속한 그룹. 그룹에 속하지 않으면 null. */
export function groupOfTable(table: string): BackupGroupId | null {
  for (const g of BACKUP_GROUP_IDS) {
    if (GROUP_TABLES[g].includes(table)) return g
  }
  return null
}

/**
 * 그룹을 넘는 참조 중 복원 때 정리하는 것 (설계 X1~X5).
 * - kind 'fk': 선언된 FOREIGN KEY. 정체성(id + created_at)이 일치하지 않으면 NULL 로 끊는다.
 * - kind 'json-todo': meeting_summaries.action_items JSON 배열 원소의 todo_id. 일치하지 않으면 null.
 * - kind 'candidate': plan_items.candidate_id `action_item:<meetingId>:<i>`. 값을 바꾸지 않고
 *   활성 계획에서 일치하지 않는 건수만 경고로 돌려준다.
 * X6(activity_log.entity_id)·X7(ai 본문 링크)·X8(외부 id)은 처리하지 않는다.
 */
interface CrossGroupRef {
  id: 'X1' | 'X2' | 'X3' | 'X4' | 'X5'
  kind: 'fk' | 'json-todo' | 'candidate'
  childTable: string
  childColumn: string
  childGroup: BackupGroupId
  parentTable: string
  parentGroup: BackupGroupId
}

export const CROSS_GROUP_REFS: readonly CrossGroupRef[] = [
  { id: 'X1', kind: 'fk', childTable: 'meetings', childColumn: 'project_id', childGroup: 'meetings', parentTable: 'projects', parentGroup: 'work' },
  { id: 'X2', kind: 'fk', childTable: 'stt_glossary', childColumn: 'project_id', childGroup: 'meetings', parentTable: 'projects', parentGroup: 'work' },
  { id: 'X3', kind: 'fk', childTable: 'documents', childColumn: 'project_id', childGroup: 'library', parentTable: 'projects', parentGroup: 'work' },
  { id: 'X4', kind: 'json-todo', childTable: 'meeting_summaries', childColumn: 'action_items', childGroup: 'meetings', parentTable: 'todos', parentGroup: 'work' },
  { id: 'X5', kind: 'candidate', childTable: 'plan_items', childColumn: 'candidate_id', childGroup: 'work', parentTable: 'meetings', parentGroup: 'meetings' }
]

/** 부분 백업에서 부모 그룹을 뺐을 때 linkwork_backup_refs 에 (id, created_at) 를 남기는 테이블 */
export const REF_PARENT_TABLES: readonly string[] = Array.from(
  new Set(CROSS_GROUP_REFS.map((r) => r.parentTable))
)

/**
 * 연동 묶음. 복원 때 이 기기의 값을 묶음 단위로 판정한다.
 * - 백업에 식별 키가 하나도 없으면 묶음 전체를 현재 값 그대로 둔다.
 * - 식별 키가 현재와 같으면 식별 키는 백업 값, 자격은 현재 값으로 둔다.
 * - 다르면 식별 키를 백업 값으로 바꾸고 현재 자격(credentialKeys·credentialTables)을 지운다 + "다시 연결" 경고.
 * jira_token_expires_at·jira_account_name 은 평문이지만 현재 토큰을 설명하는 값이라 자격 쪽이다.
 */
interface CredentialBundle {
  id: 'jira' | 'bitbucket' | 'google' | 'notion'
  label: string
  identityKeys: readonly string[]
  credentialKeys: readonly string[]
  credentialTables: readonly string[]
}

export const CREDENTIAL_BUNDLES: readonly CredentialBundle[] = [
  {
    id: 'jira',
    label: 'Jira',
    identityKeys: ['jira_site_url', 'jira_email'],
    credentialKeys: ['jira_api_token', 'jira_token_expires_at', 'jira_account_name'],
    // 프로젝트 보드 캐시와 그 AI 요약은 계정마다 볼 수 있는 이슈가 다르다. 계정이 바뀌면 함께 지운다
    credentialTables: ['jira_board_issues', 'jira_board_sync', 'jira_epic_summaries']
  },
  {
    id: 'bitbucket',
    label: 'Bitbucket',
    identityKeys: ['bitbucket_email'],
    credentialKeys: ['bitbucket_api_token'],
    credentialTables: []
  },
  {
    id: 'google',
    label: 'Google',
    identityKeys: ['google_client_id'],
    credentialKeys: ['google_client_secret'],
    credentialTables: ['auth_tokens']
  },
  {
    id: 'notion',
    label: 'Notion',
    identityKeys: [],
    credentialKeys: ['notion_token'],
    credentialTables: []
  }
]

/** 연동 묶음 규칙이 다루는 app_settings 키 전체(식별 + 자격) */
export const BUNDLE_SETTING_KEYS: readonly string[] = CREDENTIAL_BUNDLES.flatMap((b) => [
  ...b.identityKeys,
  ...b.credentialKeys
])
