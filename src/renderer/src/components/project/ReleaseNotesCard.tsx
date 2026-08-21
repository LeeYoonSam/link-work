import { useEffect, useState } from 'react'
import { useReleaseNoteStore } from '../../stores/releaseNoteStore'
import JiraSettingsModal from './JiraSettingsModal'
import JiraTokenWarning from './JiraTokenWarning'
import ReleaseNoteRow from './ReleaseNoteRow'
import { Card, EmptyState, SectionTitle, button } from '../ui'

interface ReleaseNotesCardProps {
  /** 이 프로젝트의 배포 버전. 비어 있으면 짝지을 릴리스를 찾을 수 없다 */
  deployVersion: string | null
}

// 프로젝트 상세의 Release Notes 카드 — 이 프로젝트의 **배포 버전과 이름이 같은** Jira 릴리스를
// 찾아 읽기 전용으로 보여준다.
//
// 릴리스 노트는 프로젝트에 저장된 연결을 갖지 않는다. 그래서 여기서 릴리스를 연결하거나 끊는
// 조작은 없고, 배포 버전을 바꾸면 짝지어 보이는 릴리스도 따라 바뀐다.
// 전체 목록은 사이드바의 Releases 화면(ReleasesView)이 담당한다.
export default function ReleaseNotesCard({ deployVersion }: ReleaseNotesCardProps): React.ReactNode {
  const { notes, jiraStatus, loading, fetchJiraStatus, fetchReleaseNotes } = useReleaseNoteStore()

  const [showSettings, setShowSettings] = useState(false)
  const version = deployVersion?.trim() ?? ''

  useEffect(() => {
    void fetchJiraStatus()
    if (version) void fetchReleaseNotes(version)
  }, [version])

  // 동기화는 main에서 끝나고 알림만 온다 — AI 대화가 돌린 동기화도 화면에 반영돼야 한다
  useEffect(() => {
    return window.api.ai.onDataChanged(({ entity }) => {
      if (entity === 'release_note' && version) void fetchReleaseNotes(version)
    })
  }, [version])

  const connected = jiraStatus?.connected === true

  return (
    <>
      <Card className="mt-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <SectionTitle>Release Notes</SectionTitle>
            {version && <span className="text-xs text-gray-400">배포 버전 {version}</span>}
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className={`px-3 py-1.5 text-xs ${button.subtle}`}
          >
            Jira 연동 설정
          </button>
        </div>

        <JiraTokenWarning status={jiraStatus} />

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
        ) : !version ? (
          // 배포 버전이 짝을 찾는 유일한 단서다. 비어 있으면 무엇을 채워야 하는지 못 박는다.
          <EmptyState>
            <p>이 프로젝트의 배포 버전이 비어 있습니다.</p>
            <p className="mt-1 text-xs">
              프로젝트 수정에서 배포 버전을 채우면 같은 이름의 Jira 릴리스를 여기에 보여줍니다.
            </p>
          </EmptyState>
        ) : loading && notes.length === 0 ? (
          <EmptyState compact>불러오는 중입니다…</EmptyState>
        ) : notes.length === 0 ? (
          <EmptyState>
            <p>배포 버전 {version}과 이름이 같은 Jira 릴리스가 없습니다.</p>
            <p className="mt-1 text-xs">
              Releases 화면에서 전체 동기화를 하면 Jira의 릴리스를 모두 가져옵니다.
            </p>
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {notes.map((note) => (
              <ReleaseNoteRow key={note.id} note={note} />
            ))}
          </div>
        )}
      </Card>

      {showSettings && (
        <JiraSettingsModal
          status={jiraStatus}
          onClose={() => setShowSettings(false)}
          onChanged={() => {
            void fetchJiraStatus()
            if (version) void fetchReleaseNotes(version)
          }}
        />
      )}
    </>
  )
}
