import { useEffect, useState } from 'react'
import { useReleaseNoteStore } from '../../stores/releaseNoteStore'
import JiraReleaseLinkModal from './JiraReleaseLinkModal'
import JiraSettingsModal from './JiraSettingsModal'
import JiraTokenWarning from './JiraTokenWarning'
import ReleaseNoteRow from './ReleaseNoteRow'
import { Card, EmptyState, SectionTitle, button } from '../ui'

interface ReleaseNotesCardProps {
  projectId: number
  projectName: string
}

// 프로젝트 상세의 Release Notes 카드 — 이 프로젝트에 연결된 Jira 릴리스만 보여준다.
// 전체 목록은 사이드바의 Releases 화면(ReleasesView)이 담당한다.
export default function ReleaseNotesCard({
  projectId,
  projectName
}: ReleaseNotesCardProps): React.ReactNode {
  const { notes, jiraStatus, loading, fetchJiraStatus, fetchReleaseNotes } = useReleaseNoteStore()

  const [showSettings, setShowSettings] = useState(false)
  const [showLink, setShowLink] = useState(false)

  useEffect(() => {
    void fetchJiraStatus()
    void fetchReleaseNotes(projectId)
  }, [projectId])

  // 동기화는 main에서 끝나고 알림만 온다 — AI 대화가 돌린 동기화도 화면에 반영돼야 한다
  useEffect(() => {
    return window.api.ai.onDataChanged(({ entity }) => {
      if (entity === 'release_note') void fetchReleaseNotes(projectId)
    })
  }, [projectId])

  const connected = jiraStatus?.connected === true

  return (
    <>
      <Card className="mt-6">
        <div className="flex items-center justify-between mb-4">
          <SectionTitle>Release Notes</SectionTitle>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSettings(true)}
              className={`px-3 py-1.5 text-xs ${button.subtle}`}
            >
              Jira 연동 설정
            </button>
            {connected && (
              <button
                onClick={() => setShowLink(true)}
                className={`px-3 py-1.5 text-xs ${button.primary}`}
              >
                + 릴리스 연결
              </button>
            )}
          </div>
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
        ) : loading && notes.length === 0 ? (
          <EmptyState compact>불러오는 중입니다…</EmptyState>
        ) : notes.length === 0 ? (
          <EmptyState>
            <p>연결된 Jira 릴리스가 없습니다.</p>
            <button
              onClick={() => setShowLink(true)}
              className={`mt-3 px-3 py-1.5 text-xs ${button.primary}`}
            >
              Jira 릴리스 연결
            </button>
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {notes.map((note) => (
              <ReleaseNoteRow key={note.id} note={note} projectName={projectName} />
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
            void fetchReleaseNotes(projectId)
          }}
        />
      )}

      {showLink && (
        <JiraReleaseLinkModal
          projectId={projectId}
          linkedVersionIds={notes.map((n) => n.jira_version_id)}
          onClose={() => setShowLink(false)}
        />
      )}
    </>
  )
}
