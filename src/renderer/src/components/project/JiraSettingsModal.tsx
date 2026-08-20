import { useEffect, useMemo, useState } from 'react'
import { addDays, addYears, format } from 'date-fns'
import type { JiraConnectionStatus, JiraProjectSummary } from '../../types'
import { Card, XIcon, button } from '../ui'

interface JiraSettingsModalProps {
  status: JiraConnectionStatus | null
  onClose: () => void
  /** 저장·해제 후 상위가 연결 상태를 다시 읽도록 알린다 */
  onChanged: () => void
}

const inputClass =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'

// Jira API 토큰 등록/해제 모달.
// 토큰은 main에서 GET /rest/api/3/myself로 검증에 성공해야만 safeStorage로 암호화 저장된다.
export default function JiraSettingsModal({
  status,
  onClose,
  onChanged
}: JiraSettingsModalProps): React.ReactNode {
  const [siteUrl, setSiteUrl] = useState(status?.siteUrl ?? '')
  const [email, setEmail] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [expiresAt, setExpiresAt] = useState(status?.expiresAt ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedAccount, setSavedAccount] = useState<string | null>(null)

  const [projects, setProjects] = useState<JiraProjectSummary[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [projectsError, setProjectsError] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  const [defaultKey, setDefaultKey] = useState(status?.defaultProjectKey ?? '')
  const [savingDefault, setSavingDefault] = useState(false)

  const connected = status?.connected === true || savedAccount !== null

  const canSave =
    siteUrl.trim() !== '' && email.trim() !== '' && apiToken.trim() !== '' && expiresAt !== ''

  const loadProjects = async (): Promise<void> => {
    setProjectsLoading(true)
    setProjectsError('')
    try {
      const result = await window.api.jira.listProjects()
      if (result.success) {
        setProjects(result.projects ?? [])
      } else {
        setProjectsError(result.error ?? 'Jira 프로젝트를 불러오지 못했습니다')
      }
    } catch (e) {
      setProjectsError(e instanceof Error ? e.message : 'Jira 프로젝트를 불러오지 못했습니다')
    } finally {
      setProjectsLoading(false)
    }
  }

  // 연결돼 있을 때만 목록을 당긴다 — 미연결 상태에서는 401만 돌아온다
  useEffect(() => {
    if (connected) void loadProjects()
  }, [connected])

  const visibleProjects = useMemo(() => {
    const q = projectFilter.trim().toLowerCase()
    if (!q) return projects
    return projects.filter(
      (p) => p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    )
  }, [projects, projectFilter])

  const handleSelectDefault = async (key: string): Promise<void> => {
    setDefaultKey(key)
    setSavingDefault(true)
    setProjectsError('')
    try {
      const result = await window.api.jira.setDefaultProject(key || null)
      if (result.success) {
        onChanged()
      } else {
        setProjectsError(result.error ?? '기본 프로젝트 저장에 실패했습니다')
      }
    } catch (e) {
      setProjectsError(e instanceof Error ? e.message : '기본 프로젝트 저장에 실패했습니다')
    } finally {
      setSavingDefault(false)
    }
  }

  const handleSave = async (): Promise<void> => {
    if (!canSave || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await window.api.jira.saveCredentials({
        siteUrl: siteUrl.trim(),
        email: email.trim(),
        apiToken: apiToken.trim(),
        expiresAt
      })
      if (result.success) {
        setApiToken('')
        setSavedAccount(result.accountName ?? email.trim())
        onChanged()
      } else {
        setError(result.error ?? 'Jira 연동에 실패했습니다')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Jira 연동에 실패했습니다')
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    if (!window.confirm('Jira 연동을 해제할까요? 릴리스 노트를 더 이상 동기화할 수 없습니다.')) {
      return
    }
    await window.api.jira.disconnect()
    setSavedAccount(null)
    setApiToken('')
    onChanged()
  }

  const today = new Date()

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <Card padding="md" className="bg-white max-h-[85vh] overflow-auto">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-base font-semibold text-gray-900">Jira 연동</h3>
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-700 transition-colors"
              title="닫기"
            >
              <XIcon size={16} />
            </button>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            연동하면 프로젝트에 Jira 릴리스를 연결해 릴리스 노트를 가져올 수 있습니다. (읽기 전용)
          </p>

          {connected && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4 flex items-center justify-between gap-2">
              <p className="text-sm text-green-800 min-w-0 break-all">
                연결됨 — {savedAccount ?? status?.accountName ?? 'Jira'}
                {status?.expiresAt && (
                  <span className="block text-xs text-green-700">
                    토큰 만료일 {status.expiresAt}
                  </span>
                )}
              </p>
              <button
                onClick={() => void handleDisconnect()}
                className={`shrink-0 px-3 py-1.5 text-xs ${button.danger}`}
              >
                연동 해제
              </button>
            </div>
          )}

          {/* 전체 동기화가 어느 Jira 프로젝트에서 버전을 찾을지 정한다. 없으면 전체 동기화가 아예 안 돈다. */}
          {connected && (
            <div className="border border-gray-200 rounded-lg p-3 mb-4">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                기본 Jira 프로젝트
              </label>
              <p className="text-[11px] text-gray-500 mb-2">
                전체 동기화가 이 프로젝트의 릴리스 중에서 각 LinkWork 프로젝트의 배포 버전과 이름이
                같은 것을 찾습니다.
              </p>
              <input
                type="text"
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                placeholder="프로젝트 검색 (키 또는 이름)"
                disabled={projectsLoading || projects.length === 0}
                className={`${inputClass} mb-2 disabled:bg-gray-50`}
              />
              <select
                value={defaultKey}
                onChange={(e) => void handleSelectDefault(e.target.value)}
                disabled={projectsLoading || savingDefault || visibleProjects.length === 0}
                className={`${inputClass} disabled:bg-gray-50`}
              >
                <option value="">
                  {projectsLoading ? '프로젝트 불러오는 중…' : '선택 안 함'}
                </option>
                {visibleProjects.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} — {p.name}
                  </option>
                ))}
              </select>
              {savingDefault && <p className="mt-1 text-[11px] text-gray-500">저장 중…</p>}
              {projectsError && (
                <p className="mt-1 text-[11px] text-red-600 break-all">{projectsError}</p>
              )}
              {!projectsLoading && !projectsError && defaultKey === '' && (
                <p className="mt-1 text-[11px] text-amber-700">
                  선택하지 않으면 Releases 화면에서 전체 동기화를 쓸 수 없습니다.
                </p>
              )}
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">사이트 URL</label>
              <input
                type="text"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                placeholder="https://your-site.atlassian.net"
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">이메일</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Atlassian 계정 이메일"
                className={inputClass}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">API 토큰</label>
              <input
                type="password"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder={
                  status?.connected ? '새 토큰으로 교체하려면 입력' : 'Atlassian API 토큰'
                }
                className={inputClass}
              />
              <p className="mt-1 text-[11px] text-gray-500">
                <a
                  href="https://id.atlassian.com/manage-profile/security/api-tokens"
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  id.atlassian.com → 보안 → API 토큰
                </a>
                에서 발급합니다.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">토큰 만료일</label>
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                min={format(addDays(today, 1), 'yyyy-MM-dd')}
                max={format(addYears(today, 1), 'yyyy-MM-dd')}
                className={inputClass}
              />
              <p className="mt-1 text-[11px] text-gray-500">
                Atlassian API 토큰은 최대 1년까지만 유효합니다. 발급할 때 지정한 만료일을 그대로
                입력하면 만료 30일 전부터 갱신 안내를 띄워, 동기화가 조용히 실패하는 상황을 막습니다.
              </p>
            </div>
          </div>

          {error && (
            <p className="mt-3 text-xs text-red-600 break-all" role="alert">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 mt-4">
            <button onClick={onClose} className={`px-4 py-2 text-sm ${button.subtle}`}>
              닫기
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={!canSave || busy}
              className={`px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed ${button.primary}`}
            >
              {busy ? '확인 중…' : '저장'}
            </button>
          </div>
        </Card>
      </div>
    </div>
  )
}
