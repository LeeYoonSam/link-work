import type { JiraConnectionStatus } from '../../types'

// 토큰이 만료되면 동기화가 401로 조용히 실패한다. 만료 전부터 눈에 띄게 알린다.
// 프로젝트 상세 카드와 Releases 화면이 같은 문구를 써야 해서 한 곳에 둔다.
export default function JiraTokenWarning({
  status
}: {
  status: JiraConnectionStatus | null
}): React.ReactNode {
  if (!status) return null

  const suffix = status.expiresAt ? ` (${status.expiresAt})` : ''

  if (status.expired) {
    return (
      <div className="mb-3 px-3 py-2 rounded-md border border-red-200 bg-red-50 text-xs text-red-600">
        Jira 토큰이 만료됐습니다{suffix}. 새 토큰을 등록해야 동기화할 수 있습니다.
      </div>
    )
  }
  if (status.expiringSoon) {
    return (
      <div className="mb-3 px-3 py-2 rounded-md border border-amber-200 bg-amber-50 text-xs text-amber-700">
        Jira 토큰이 곧 만료됩니다{suffix}. 만료되면 동기화가 실패하니 미리 갱신하세요.
      </div>
    )
  }
  return null
}
