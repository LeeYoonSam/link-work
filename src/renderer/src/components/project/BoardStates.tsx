// 프로젝트 화면의 비어 있음·연결 안내·오류·상한 안내 조각
import { AlertTriangleIcon, Card, EmptyState, button } from '../ui'
import { clockTime } from './boardModel'

/** Jira 미연결 / 기본 프로젝트 미설정. 둘 다 설정 화면으로 보낸다 */
export function ConnectPrompt({
  kind,
  message,
  onGoSettings
}: {
  kind: 'not_connected' | 'no_default_project'
  message?: string | null
  onGoSettings: () => void
}): React.ReactNode {
  const title = kind === 'not_connected' ? 'Jira가 연결되지 않았어요' : '기본 Jira 프로젝트가 정해지지 않았어요'
  const hint =
    kind === 'not_connected'
      ? '설정 > 연동에서 Jira를 연결하면 할 일 이상 상태의 티켓을 에픽별로 모아 보여줘요.'
      : '설정 > 연동에서 기본 프로젝트를 고르면 그 프로젝트의 티켓을 보여줘요.'
  return (
    <Card>
      <EmptyState>
        <p className="text-base font-medium text-gray-700">{title}</p>
        <p className="mt-1">{hint}</p>
        {message ? <p className="mt-1 text-xs text-gray-400">{message}</p> : null}
        <button type="button" onClick={onGoSettings} className={`mt-4 px-4 py-2 text-sm ${button.primary}`}>
          설정에서 연결
        </button>
      </EmptyState>
    </Card>
  )
}

/** 오류 배너. 캐시된 결과가 있으면 마지막 성공 시각을 함께 보여준다 */
export function ErrorBanner({
  error,
  lastSuccessAt,
  retrying,
  onRetry,
  onDismiss
}: {
  error: string
  lastSuccessAt: string | null
  retrying: boolean
  onRetry: () => void
  onDismiss?: () => void
}): React.ReactNode {
  return (
    <div role="alert" className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-2.5">
      <p className="text-sm text-red-700 min-w-0 break-words">
        티켓을 불러오지 못했어요 — {error}
        {lastSuccessAt ? <span className="text-red-500"> · 마지막 성공 {clockTime(lastSuccessAt)}</span> : null}
      </p>
      <div className="flex items-center gap-3 flex-shrink-0">
        <button type="button" onClick={onRetry} disabled={retrying} className="text-sm text-red-600 hover:text-red-800 font-medium disabled:opacity-50">
          {retrying ? '다시 시도 중…' : '다시 시도'}
        </button>
        {onDismiss ? (
          <button type="button" onClick={onDismiss} className="text-sm text-red-500 hover:text-red-700">
            닫기
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** 조회 상한에 걸려 일부만 보인다는 안내 */
export function TruncatedNotice(): React.ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
      <AlertTriangleIcon size={14} className="flex-shrink-0" />
      티켓이 많아 일부만 가져왔어요. 필터로 좁혀 보거나 Jira에서 확인해 주세요.
    </div>
  )
}
