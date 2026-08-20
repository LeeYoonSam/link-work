import { useEffect, useMemo, useState } from 'react'
import { useReleaseNoteStore } from '../../stores/releaseNoteStore'
import type { JiraProjectSummary, JiraVersionSummary } from '../../types'
import { Badge, EmptyState, XIcon, button } from '../ui'

interface JiraReleaseLinkModalProps {
  projectId: number
  /** 이미 연결된 Jira 버전 id — 같은 릴리스를 두 번 연결할 수 없다 (UNIQUE 제약) */
  linkedVersionIds: string[]
  onClose: () => void
}

// 미출시를 위로 올린다. 릴리스 노트를 붙이는 시점은 대개 아직 나가지 않은 버전이다.
// 같은 그룹 안에서는 릴리스일 최신순, 날짜가 없으면 뒤로 민다.
function sortVersions(versions: JiraVersionSummary[]): JiraVersionSummary[] {
  return [...versions].sort((a, b) => {
    if (a.released !== b.released) return a.released ? 1 : -1
    if (a.releaseDate && b.releaseDate) return b.releaseDate.localeCompare(a.releaseDate)
    if (a.releaseDate) return -1
    if (b.releaseDate) return 1
    return a.name.localeCompare(b.name)
  })
}

export default function JiraReleaseLinkModal({
  projectId,
  linkedVersionIds,
  onClose
}: JiraReleaseLinkModalProps): React.ReactNode {
  const { linkNote } = useReleaseNoteStore()

  const [projects, setProjects] = useState<JiraProjectSummary[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [selectedKey, setSelectedKey] = useState('')
  const [filter, setFilter] = useState('')

  const [versions, setVersions] = useState<JiraVersionSummary[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)

  const [error, setError] = useState('')
  const [linkingId, setLinkingId] = useState<string | null>(null)

  const loadProjects = async (): Promise<void> => {
    setProjectsLoading(true)
    setError('')
    try {
      const result = await window.api.jira.listProjects()
      if (result.success) {
        setProjects(result.projects ?? [])
      } else {
        setError(result.error ?? 'Jira 프로젝트를 불러오지 못했습니다')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Jira 프로젝트를 불러오지 못했습니다')
    } finally {
      setProjectsLoading(false)
    }
  }

  const loadVersions = async (projectKey: string): Promise<void> => {
    setVersionsLoading(true)
    setVersions([])
    setError('')
    try {
      const result = await window.api.jira.listVersions(projectKey)
      if (result.success) {
        setVersions(sortVersions(result.versions ?? []))
      } else {
        setError(result.error ?? 'Jira 릴리스를 불러오지 못했습니다')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Jira 릴리스를 불러오지 못했습니다')
    } finally {
      setVersionsLoading(false)
    }
  }

  useEffect(() => {
    void loadProjects()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const visibleProjects = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(
      (p) => p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    )
  }, [projects, filter])

  const handleSelectProject = (key: string): void => {
    setSelectedKey(key)
    if (key) void loadVersions(key)
  }

  const handleLink = async (version: JiraVersionSummary): Promise<void> => {
    if (linkingId) return
    setLinkingId(version.id)
    setError('')
    const result = await linkNote(projectId, selectedKey, version)
    setLinkingId(null)
    if (result.success) {
      onClose()
    } else {
      setError(result.error ?? '릴리스 연결에 실패했습니다')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg w-full max-w-lg max-h-[85vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Jira 릴리스 연결</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              Jira 프로젝트를 고르고 연결할 릴리스(버전)를 선택하세요
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-700 transition-colors"
            title="닫기"
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="px-6 py-3 border-b border-gray-200 space-y-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="프로젝트 검색 (키 또는 이름)"
            disabled={projectsLoading || projects.length === 0}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50"
          />
          <select
            value={selectedKey}
            onChange={(e) => handleSelectProject(e.target.value)}
            disabled={projectsLoading || visibleProjects.length === 0}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50"
          >
            <option value="">
              {projectsLoading ? '프로젝트 불러오는 중…' : 'Jira 프로젝트 선택'}
            </option>
            {visibleProjects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.key} — {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 overflow-auto px-6 py-2 min-h-[8rem]">
          {!selectedKey ? (
            <EmptyState compact>
              {projectsLoading
                ? 'Jira에서 프로젝트를 불러오는 중입니다…'
                : projects.length === 0
                  ? '접근 가능한 Jira 프로젝트가 없습니다'
                  : '먼저 Jira 프로젝트를 선택하세요'}
            </EmptyState>
          ) : versionsLoading ? (
            <EmptyState compact>릴리스를 불러오는 중입니다…</EmptyState>
          ) : versions.length === 0 ? (
            <EmptyState compact>이 프로젝트에는 릴리스(버전)가 없습니다</EmptyState>
          ) : (
            <div className="divide-y divide-gray-100">
              {versions.map((v) => {
                const linked = linkedVersionIds.includes(v.id)
                return (
                  <div key={v.id} className="flex items-center gap-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-900 truncate">{v.name}</span>
                        <Badge
                          color={v.released ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'}
                          size="xs"
                        >
                          {v.released ? '출시됨' : '미출시'}
                        </Badge>
                        {v.archived && (
                          <Badge color="bg-gray-100 text-gray-600" size="xs">
                            보관됨
                          </Badge>
                        )}
                      </div>
                      {v.releaseDate && (
                        <span className="text-xs text-gray-400 tabular-nums">
                          릴리스일 {v.releaseDate}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => void handleLink(v)}
                      disabled={linked || linkingId !== null}
                      className={`shrink-0 px-3 py-1.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed ${
                        linked ? button.subtle : button.primary
                      }`}
                    >
                      {linked ? '연결됨' : linkingId === v.id ? '연결 중…' : '연결'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-200">
          <span className="min-w-0 text-xs text-red-600 break-all">{error}</span>
          <div className="flex items-center gap-2 shrink-0">
            {error !== '' && !projectsLoading && (
              <button
                onClick={() => void (selectedKey ? loadVersions(selectedKey) : loadProjects())}
                className={`px-4 py-2 text-sm ${button.subtle}`}
              >
                다시 시도
              </button>
            )}
            <button onClick={onClose} className={`px-4 py-2 text-sm ${button.subtle}`}>
              닫기
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
