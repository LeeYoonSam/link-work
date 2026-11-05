import { useEffect, useState } from 'react'
import { useReleaseNoteStore } from '../../stores/releaseNoteStore'
import { useMorningSyncStore } from '../../stores/morningSyncStore'
import { useFocusRequest, useFocusStore } from '../../stores/focusStore'
import { useFlash } from '../../hooks/useFocusFlash'
import { format } from 'date-fns'
import type { ReleaseNoteSummary } from '../../types'
import JiraSettingsModal from './JiraSettingsModal'
import JiraTokenWarning from './JiraTokenWarning'
import ReleaseNoteRow from './ReleaseNoteRow'
import SyncAllSummary from './SyncAllSummary'
import { morningStatusLine, parseMorningPart } from '../today/ChangeLog'
import { Badge, Card, EmptyState, SearchIcon, XIcon, button } from '../ui'

// 검색 — 버전 이름과 Jira 프로젝트 키를 한 상자에서 찾는다.
// 공백으로 나눈 토큰을 모두 만족(AND)해야 통과한다: "PROJ 4.16"처럼 좁혀 가는 게 자연스럽다.
// 이슈 본문은 대상이 아니다 — 항목은 펼칠 때만 받아오므로 목록만으로는 검색할 수 없다.
export function filterReleaseNotes(
  notes: ReleaseNoteSummary[],
  query: string
): ReleaseNoteSummary[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return notes
  return notes.filter((note) => {
    const haystack = `${note.version_name} ${note.jira_project_key}`.toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}

// 사이드바 Releases — 기본 Jira 프로젝트의 릴리스를 버전 내림차순으로 늘어놓는다.
// LinkWork 프로젝트로 묶지 않는다: 릴리스 노트는 Jira 릴리스의 미러라 릴리스 하나당 한 줄이면
// 충분하고, 프로젝트로 묶으면 같은 배포 버전을 쓰는 프로젝트 수만큼 같은 버전이 중복으로 뜬다.
// 릴리스가 0건이어도 전체 동기화 버튼이 보여야 한다 — 버튼이 행 안에만 있으면 막다른 상태가 된다.
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
  const [query, setQuery] = useState('')
  // 아침 자동 릴리스 동기화 결과 (RELEASE_NOTES §1). 자동 갱신이 sync_status 로 다시 읽는다
  const morningStatus = useMorningSyncStore((s) => s.status)
  const loadMorning = useMorningSyncStore((s) => s.load)
  const markMorningSeen = useMorningSyncStore((s) => s.markSeen)
  const morningPart = parseMorningPart(morningStatus?.release)
  const morningLine = morningStatusLine(
    '아침 동기화',
    'release',
    morningPart,
    format(new Date(), 'yyyy-MM-dd')
  )

  useEffect(() => {
    void fetchJiraStatus()
    void fetchAllReleaseNotes()
    void loadMorning()
  }, [])

  // 이 화면이 열려 있으면 아침 동기화의 새 항목을 본 것으로 표시한다. 사이드바 배지가 사라진다
  useEffect(() => {
    if (morningStatus) markMorningSeen('release')
  }, [morningStatus])

  // 동기화는 main에서 끝나고 알림만 온다 — AI 대화가 돌린 동기화도 화면에 반영돼야 한다
  // 아침 자동 동기화도 변경이 있으면 release_note 이벤트를 보낸다. 그래서 이 리스너 하나로 다시 읽는다
  useEffect(() => {
    return window.api.ai.onDataChanged(({ entity }) => {
      if (entity === 'release_note') void fetchAllReleaseNotes()
    })
  }, [])

  // 앱 내 링크(linkwork://release/{id})로 들어온 릴리스를 강조하고 펼친다.
  // 검색어가 행을 숨길 수 있어 검색어를 비운다. 목록이 아직 오지 않았으면 기다린다
  const focusRequest = useFocusRequest('release')
  const [flashNoteId, flashNote] = useFlash<number>()
  const pendingFocusId =
    focusRequest && allNotes.some((n) => n.id === focusRequest.id) ? focusRequest.id : null
  useEffect(() => {
    if (!focusRequest || pendingFocusId === null) return
    setQuery('')
    flashNote(pendingFocusId)
    useFocusStore.getState().consume(focusRequest.nonce)
  }, [focusRequest, pendingFocusId])
  // 소비 전 첫 렌더부터 강조해 깜빡임 없이 이어지게 한다
  const focusedNoteId = pendingFocusId ?? flashNoteId

  const connected = jiraStatus?.connected === true
  const defaultProjectKey = jiraStatus?.defaultProjectKey ?? null
  const canSyncAll = connected && defaultProjectKey !== null
  const searching = query.trim().length > 0
  const visibleNotes = filterReleaseNotes(allNotes, query)

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
        <div className="flex items-center gap-2 min-w-0">
          {/* 아침 동기화 상태 1줄. 실패면 빨간 글자다. 긴 사유는 말줄임하고 title 로 보인다 */}
          {morningLine ? (
            <span
              className={`max-w-[18rem] truncate text-[11px] ${
                morningPart?.status === 'failed' ? 'text-red-600' : 'text-gray-500'
              }`}
              title={morningLine}
            >
              {morningLine}
            </span>
          ) : null}
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
                  : '기본 Jira 프로젝트의 릴리스를 모두 가져와 동기화합니다'
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
            Jira에서 릴리스와 이슈를 가져오는 중입니다. 릴리스 수에 따라 수십 초가 걸릴 수
            있습니다.
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
            기본 Jira 프로젝트를 선택하면 전체 동기화를 쓸 수 있습니다. 그 프로젝트의 릴리스를
            모두 가져옵니다.
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
      ) : allNotes.length === 0 ? (
        <EmptyState>
          <p>아직 가져온 릴리스가 없습니다.</p>
          <p className="mt-1 text-xs">
            전체 동기화를 누르면 기본 Jira 프로젝트의 릴리스를 모두 가져옵니다.
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
          {/* 릴리스가 쌓이면 프로젝트 헤딩을 눈으로 훑기 어렵다 — 버전 번호로 바로 찾을 수 있어야 한다 */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <SearchIcon
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="버전 검색 (예: 4.16)..."
                aria-label="릴리스 검색"
                className="w-full pl-9 pr-8 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 transition-colors"
              />
              {searching && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  title="검색어 지우기"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <XIcon size={14} />
                </button>
              )}
            </div>
            {/* 걸러낸 뒤에도 전체가 몇 건인지 함께 보여야 "다 사라졌다"로 읽히지 않는다 */}
            <span className="shrink-0 text-xs text-gray-400">
              {searching
                ? `${visibleNotes.length} / ${allNotes.length}건`
                : `릴리스 ${allNotes.length}건`}
            </span>
          </div>

          {visibleNotes.length === 0 ? (
            <EmptyState>
              <div className="flex justify-center mb-3 text-gray-300">
                <SearchIcon size={28} />
              </div>
              <div className="text-sm">검색 결과가 없습니다</div>
              <p className="mt-1 text-xs">버전 이름과 Jira 프로젝트 키로 찾습니다.</p>
            </EmptyState>
          ) : (
            <Card padding="none">
              <div className="px-3 py-3 space-y-2">
                {visibleNotes.map((note) => (
                  <ReleaseNoteRow key={note.id} note={note} focused={note.id === focusedNoteId} />
                ))}
              </div>
            </Card>
          )}
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
