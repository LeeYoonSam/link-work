import type { JiraConnectionStatus } from '../../types'
import { useSettingsStore } from '../../stores/settingsStore'

// 토큰이 만료되면 동기화가 401로 조용히 실패한다. 만료 전부터 눈에 띄게 알린다.
// 프로젝트 상세 카드와 Releases 화면이 같은 문구를 써야 해서 한 곳에 둔다.
// 문구 끝의 [설정 열기] 는 작업 흐름을 끊지 않는 쪽을 먼저 쓴다.
// 호출부가 그 자리의 Jira 다이얼로그를 여는 콜백을 주면 그것을 부르고, 없을 때만 설정 > 연동으로 이동한다.
export function resolveOpenSettings(onOpenSettings?: () => void): () => void {
  return onOpenSettings ?? (() => useSettingsStore.getState().open('integrations'))
}

function OpenSettingsButton({
  className,
  onClick
}: {
  className: string
  onClick: () => void
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`ml-1 font-medium underline underline-offset-2 ${className}`}
    >
      설정 열기
    </button>
  )
}

export default function JiraTokenWarning({
  status,
  onOpenSettings
}: {
  status: JiraConnectionStatus | null
  /** 주어지면 [설정 열기] 가 화면 이동 대신 이 콜백(그 자리의 Jira 다이얼로그 열기)을 부른다 */
  onOpenSettings?: () => void
}): React.ReactNode {
  if (!status) return null
  const openSettings = resolveOpenSettings(onOpenSettings)

  const suffix = status.expiresAt ? ` (${status.expiresAt})` : ''

  if (status.expired) {
    return (
      <div className="mb-3 px-3 py-2 rounded-md border border-red-200 bg-red-50 text-xs text-red-600">
        Jira 토큰이 만료됐습니다{suffix}. 새 토큰을 등록해야 동기화할 수 있습니다.
        <OpenSettingsButton className="text-red-700 hover:text-red-800" onClick={openSettings} />
      </div>
    )
  }
  if (status.expiringSoon) {
    return (
      <div className="mb-3 px-3 py-2 rounded-md border border-amber-200 bg-amber-50 text-xs text-amber-700">
        Jira 토큰이 곧 만료됩니다{suffix}. 만료되면 동기화가 실패하니 미리 갱신하세요.
        <OpenSettingsButton className="text-amber-800 hover:text-amber-900" onClick={openSettings} />
      </div>
    )
  }
  return null
}
