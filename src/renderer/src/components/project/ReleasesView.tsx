import { useEffect, useState } from 'react'
import { useReleaseNoteStore } from '../../stores/releaseNoteStore'
import type { ReleaseNoteSummary } from '../../types'
import JiraSettingsModal from './JiraSettingsModal'
import JiraTokenWarning from './JiraTokenWarning'
import ReleaseNoteRow from './ReleaseNoteRow'
import SyncAllSummary from './SyncAllSummary'
import { Badge, Card, EmptyState, SectionTitle, button } from '../ui'

interface ProjectGroup {
  projectId: number
  projectName: string
  notes: ReleaseNoteSummary[]
}

// 프로젝트별로 묶되 순서는 main이 준 목록 순서를 그대로 따른다.
// 이름이 아니라 project_id로 묶어야 동명 프로젝트가 한 덩어리로 합쳐지지 않는다.
export function groupNotesByProject(notes: ReleaseNoteSummary[]): ProjectGroup[] {
  const groups: ProjectGroup[] = []
  const byProject = new Map<number, ProjectGroup>()
  for (const note of notes) {
    let group = byProject.get(note.project_id)
    if (!group) {
      // project_name은 main이 조인해 내려준다. 비어 있어도 'undefined'가 제목에 뜨지는 않게 둔다.
      group = { projectId: note.project_id, projectName: note.project_name || '이름 없는 프로젝트', notes: [] }
      byProject.set(note.project_id, group)
      groups.push(group)
    }
    group.notes.push(note)
  }
  return groups
}

// 사이드바 Releases — 전체 프로젝트의 릴리스 노트를 한 화면에 모은다.
// 연결이 0건이어도 전체 동기화 버튼이 보여야 한다. 프로젝트를 하나씩 연결하는 건 현실적이지 않고,
// 버튼이 행 안에만 있으면 "연결이 없어서 버튼도 없는" 막다른 상태가 된다.
export default function ReleasesView(): React.ReactNode {
  const {
    allNotes,
    allLoading,
    jiraStatus,
    syncAllRunning,
    syncAllResult,
    syncAllError,
    fetchJiraStatus,
    fetchAllReleaseNotes,
    syncAll,
    clearSyncAllResult
  } = useReleaseNoteStore()
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    void fetchJiraStatus()
    void fetchAllReleaseNotes()
  }, [])

  // 동기화는 main에서 끝나고 알림만 온다 — AI 대화가 돌린 동기화도 화면에 반영돼야 한다
  useEffect(() => {
    return window.api.ai.onDataChanged(({ entity }) => {
      if (entity === 'release_note') void fetchAllReleaseNotes()
    })
  }, [])

  const connected = jiraStatus?.connected === true
  const defaultProjectKey = jiraStatus?.defaultProjectKey ?? null
  const canSyncAll = connected && defaultProjectKey !== null
  const groups = groupNotesByProject(allNotes)

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold text-gray-900">Releases</h2>
          <Badge
            color={connected ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}
            size="xs"
          >
            {connected
              ? `Jira 연결됨${jiraStatus?.accountName ? ` — ${jiraStatus.accountName}` : ''}`
              : 'Jira 미연결'}
          </Badge>
          {defaultProjectKey && (
            <Badge color="bg-slate-100 text-slate-700" size="xs">
              기본 프로젝트 {defaultProjectKey}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSettings(true)}
            className={`px-4 py-2 text-sm ${button.subtle}`}
          >
            Jira 연동 설정
          </button>
          {/* 연결된 릴리스가 0건이어도 이 버튼은 보여야 한다 */}
          <button
            onClick={() => void syncAll()}
            disabled={!canSyncAll || syncAllRunning}
            title={
              !connected
                ? 'Jira 연동 설정을 먼저 완료하세요'
                : !defaultProjectKey
                  ? '기본 Jira 프로젝트를 먼저 선택하세요'
                  : '모든 프로젝트의 배포 버전으로 Jira 릴리스를 찾아 연결·동기화합니다'
            }
            className={`px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed ${button.primary}`}
          >
            {syncAllRunning ? '동기화 중…' : '전체 동기화'}
          </button>
        </div>
      </div>

      <JiraTokenWarning status={jiraStatus} />

      {/* 프로젝트를 순차 처리하므로 수십 초가 걸린다. 멈춘 것처럼 보이면 사용자가 다시 누른다. */}
      {syncAllRunning && (
        <div className="mb-4 px-3 py-3 rounded-lg border border-blue-200 bg-blue-50">
          <p className="text-xs text-blue-800">
            프로젝트마다 Jira에서 릴리스를 찾아 이슈를 가져오는 중입니다. 프로젝트 수에 따라 수십
            초가 걸릴 수 있습니다.
          </p>
          <div className="mt-2 h-1.5 w-full rounded-full bg-blue-100 overflow-hidden">
            <div className="h-full w-1/3 rounded-full bg-blue-500 animate-pulse" />
          </div>
        </div>
      )}

      {syncAllError && (
        <div className="mb-4 px-3 py-2 rounded-md border border-red-200 bg-red-50 text-xs text-red-600 break-all">
          전체 동기화 실패 — {syncAllError}
        </div>
      )}

      {syncAllResult && <SyncAllSummary result={syncAllResult} onDismiss={clearSyncAllResult} />}

      {/* 버튼을 눌렀다가 실패 메시지를 보는 것보다, 먼저 무엇이 빠졌는지 알려주는 게 낫다 */}
      {connected && !defaultProjectKey && (
        <div className="mb-4 px-3 py-3 rounded-lg border border-amber-200 bg-amber-50 flex items-center justify-between gap-3">
          <p className="text-xs text-amber-800">
            기본 Jira 프로젝트를 선택하면 전체 동기화를 쓸 수 있습니다. 각 프로젝트의 배포 버전과
            이름이 같은 릴리스를 그 프로젝트에서 찾습니다.
          </p>
          <button
            onClick={() => setShowSettings(true)}
            className={`shrink-0 px-3 py-1.5 text-xs ${button.primary}`}
          >
            기본 프로젝트 선택
          </button>
        </div>
      )}

      {!connected ? (
        <EmptyState>
          <p>Jira를 연동하면 릴리스에 묶인 작업 내용을 릴리스 노트로 가져올 수 있습니다.</p>
          <button
            onClick={() => setShowSettings(true)}
            className={`mt-3 px-3 py-1.5 text-xs ${button.primary}`}
          >
            Jira 연동 설정
          </button>
        </EmptyState>
      ) : allLoading && allNotes.length === 0 ? (
        <EmptyState compact>불러오는 중입니다…</EmptyState>
      ) : groups.length === 0 ? (
        <EmptyState>
          <p>아직 연결된 릴리스가 없습니다.</p>
          <p className="mt-1 text-xs">
            전체 동기화를 누르면 각 프로젝트의 배포 버전과 이름이 같은 Jira 릴리스를 자동으로 찾아
            연결하고 동기화합니다.
          </p>
          <button
            onClick={() => void syncAll()}
            disabled={!canSyncAll || syncAllRunning}
            className={`mt-3 px-3 py-1.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed ${button.primary}`}
          >
            {syncAllRunning ? '동기화 중…' : '전체 동기화'}
          </button>
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <Card key={group.projectId} padding="none">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
                <SectionTitle>{group.projectName}</SectionTitle>
                <span className="text-xs text-gray-400">({group.notes.length})</span>
              </div>
              <div className="px-3 py-3 space-y-2">
                {group.notes.map((note) => (
                  <ReleaseNoteRow key={note.id} note={note} projectName={group.projectName} />
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {showSettings && (
        <JiraSettingsModal
          status={jiraStatus}
          onClose={() => setShowSettings(false)}
          onChanged={() => {
            void fetchJiraStatus()
            void fetchAllReleaseNotes()
          }}
        />
      )}
    </div>
  )
}
