import { useEffect, useMemo, useState } from 'react'
import type { JiraConnectionStatus, JiraProjectSummary } from '../../../types'
import { inputClass } from '../ConnectDialog'

// 기본 Jira 프로젝트 선택. 고르는 즉시 저장한다.
// 전체 동기화는 이 프로젝트의 릴리스 중에서 배포 버전과 이름이 같은 것을 찾는다.
// 프로젝트 목록은 연결돼 있으면 처음 그릴 때 한 번 당긴다. 포커스 때 당기면 열린 select 가 로딩 중 비활성으로 바뀌어 한 번 더 눌러야 한다.

interface JiraDefaultProjectSelectProps {
  status: JiraConnectionStatus | null
  onChanged: () => void
}

export default function JiraDefaultProjectSelect({
  status,
  onChanged
}: JiraDefaultProjectSelectProps): React.ReactNode {
  const connected = status?.connected === true
  const [projects, setProjects] = useState<JiraProjectSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(status?.defaultProjectKey ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setSelected(status?.defaultProjectKey ?? '')
  }, [status?.defaultProjectKey])

  // 연결돼 있을 때만 당긴다 — 미연결이면 401만 돌아온다
  useEffect(() => {
    if (!connected) return
    let alive = true
    setLoading(true)
    setError('')
    window.api.jira
      .listProjects()
      .then((r) => {
        if (!alive) return
        if (r.success) setProjects(r.projects ?? [])
        else setError(r.error ?? 'Jira 프로젝트를 불러오지 못했습니다')
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'Jira 프로젝트를 불러오지 못했습니다')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [connected])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return projects
    return projects.filter((p) => p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
  }, [projects, filter])

  if (!connected) return null

  const handleSelect = async (key: string): Promise<void> => {
    const previous = selected
    setSelected(key)
    setSaving(true)
    setError('')
    try {
      const r = await window.api.jira.setDefaultProject(key || null)
      if (r.success) {
        onChanged()
      } else {
        // 저장하지 못했으면 칸을 저장된 값으로 되돌린다
        setSelected(previous)
        setError(r.error ?? '기본 프로젝트를 저장하지 못했습니다')
      }
    } catch (e) {
      setSelected(previous)
      setError(e instanceof Error ? e.message : '기본 프로젝트를 저장하지 못했습니다')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border border-gray-200 rounded-lg p-3">
      <p className="text-xs font-medium text-gray-700 mb-1">기본 Jira 프로젝트</p>
      <p className="text-[11px] text-gray-500 mb-2">
        전체 동기화가 이 프로젝트의 릴리스 중에서 각 LinkWork 프로젝트의 배포 버전과 이름이 같은 것을
        찾습니다.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="검색 (키 또는 이름)"
          aria-label="Jira 프로젝트 검색"
          disabled={loading || projects.length === 0}
          className={`${inputClass} w-40 disabled:bg-gray-50`}
        />
        <select
          value={selected}
          onChange={(e) => void handleSelect(e.target.value)}
          aria-label="기본 Jira 프로젝트"
          disabled={loading || saving}
          className={`${inputClass} flex-1 disabled:bg-gray-50`}
        >
          <option value="">{loading ? '프로젝트 불러오는 중…' : '선택 안 함'}</option>
          {selected && !visible.some((p) => p.key === selected) ? (
            <option value={selected}>{selected}</option>
          ) : null}
          {visible.map((p) => (
            <option key={p.key} value={p.key}>
              {p.key} — {p.name}
            </option>
          ))}
        </select>
      </div>
      {saving ? <p className="mt-1 text-[11px] text-gray-500">저장 중…</p> : null}
      {error ? <p className="mt-1 text-[11px] text-red-600 break-all">{error}</p> : null}
      {!loading && !error && selected === '' ? (
        <p className="mt-1 text-[11px] text-amber-700">
          선택하지 않으면 프로젝트 페이지의 릴리스 탭에서 전체 동기화를 쓸 수 없습니다.
        </p>
      ) : null}
    </div>
  )
}
