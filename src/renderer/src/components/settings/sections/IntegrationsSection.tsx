import { useEffect, useState } from 'react'
import type { IntegrationId } from '../../../types'
import { useSettingsStore, INTEGRATION_IDS } from '../../../stores/settingsStore'
import { button } from '../../ui'
import IntegrationCard from '../IntegrationCard'
import {
  DISCONNECT_CONFIRM,
  INTEGRATION_LABELS,
  toCardState,
  type CardActionId,
  type IntegrationStatusInput
} from '../integrationStatus'
import GoogleCalendarConnectDialog from '../integrations/GoogleCalendarConnectDialog'
import JiraConnectDialog from '../integrations/JiraConnectDialog'
import JiraDefaultProjectSelect from '../integrations/JiraDefaultProjectSelect'
import CalendarPicker from '../integrations/CalendarPicker'
import BitbucketConnectDialog from '../integrations/BitbucketConnectDialog'
import NotionConnectDialog from '../integrations/NotionConnectDialog'

// 설정 > 연동. 카드 4장과 [모두 다시 확인].
// 화면에 들어올 때는 저장된 상태만 읽는다. 외부 API 확인은 버튼을 눌렀을 때만 한다.

async function disconnect(id: IntegrationId): Promise<void> {
  const api = window.api
  if (id === 'google') await api.calendar.disconnect()
  else if (id === 'jira') await api.jira.disconnect()
  else if (id === 'bitbucket') await api.ai.bitbucketDisconnect()
  else await api.ai.notionDisconnect()
}

export default function IntegrationsSection(): React.ReactNode {
  const statuses = useSettingsStore((s) => s.statuses)
  const statusErrors = useSettingsStore((s) => s.statusErrors)
  const verifyResults = useSettingsStore((s) => s.verifyResults)
  const verifying = useSettingsStore((s) => s.verifying)
  const refreshStatuses = useSettingsStore((s) => s.refreshStatuses)
  const verify = useSettingsStore((s) => s.verify)
  const verifyAll = useSettingsStore((s) => s.verifyAll)
  const clearVerify = useSettingsStore((s) => s.clearVerify)

  const [dialog, setDialog] = useState<IntegrationId | null>(null)
  const [checkingAll, setCheckingAll] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    void refreshStatuses()
  }, [refreshStatuses])

  const changed = (id: IntegrationId): void => {
    clearVerify(id)
    void refreshStatuses()
  }

  const handleAction = async (id: IntegrationId, action: CardActionId): Promise<void> => {
    setActionError('')
    try {
      switch (action) {
        case 'test':
          await verify(id)
          return
        case 'disconnect':
          if (!window.confirm(DISCONNECT_CONFIRM[id])) return
          await disconnect(id)
          changed(id)
          return
        case 'google_login': {
          const r = await window.api.calendar.auth()
          if (!r.success)
            setActionError(r.error ? `Google 로그인에 실패했습니다: ${r.error}` : 'Google 로그인에 실패했습니다')
          changed(id)
          return
        }
        default:
          setDialog(id)
      }
    } catch (e) {
      // 해제·로그인이 throw 해도 화면에 원인을 보이고, 카드 상태는 다시 읽는다
      setActionError(e instanceof Error ? e.message : '작업을 완료하지 못했습니다')
      void refreshStatuses()
    }
  }

  const handleCheckAll = async (): Promise<void> => {
    setCheckingAll(true)
    try {
      await verifyAll()
    } finally {
      setCheckingAll(false)
    }
  }

  const inputs: Record<IntegrationId, IntegrationStatusInput> = {
    google: { id: 'google', status: statuses.google },
    jira: { id: 'jira', status: statuses.jira },
    bitbucket: { id: 'bitbucket', status: statuses.bitbucket },
    notion: { id: 'notion', status: statuses.notion }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">
          각 연동의 저장된 토큰으로 실제 접속을 확인하려면 [연결 테스트]를 누르세요.
        </p>
        <button
          type="button"
          onClick={() => void handleCheckAll()}
          disabled={checkingAll}
          className={`shrink-0 px-3 py-1.5 text-xs ${button.subtle} disabled:opacity-50`}
        >
          {checkingAll ? '확인 중…' : '모두 다시 확인'}
        </button>
      </div>
      {actionError ? <p className="text-xs text-red-600">{actionError}</p> : null}

      {INTEGRATION_IDS.map((id) => {
        const state = toCardState(inputs[id], verifyResults[id])
        return (
          <IntegrationCard
            key={id}
            title={INTEGRATION_LABELS[id].title}
            purpose={INTEGRATION_LABELS[id].purpose}
            state={state}
            verifying={verifying[id] === true}
            statusError={statusErrors[id] ?? null}
            onAction={(a) => void handleAction(id, a)}
          >
            {id === 'google' && statuses.google?.connected ? <CalendarPicker connected /> : null}
            {id === 'jira' && statuses.jira?.connected ? (
              <JiraDefaultProjectSelect status={statuses.jira} onChanged={() => void refreshStatuses()} />
            ) : null}
          </IntegrationCard>
        )
      })}

      {dialog === 'google' ? (
        <GoogleCalendarConnectDialog onClose={() => setDialog(null)} onConnected={() => changed('google')} />
      ) : null}
      {dialog === 'jira' ? (
        <JiraConnectDialog
          status={statuses.jira}
          suggestedEmail={statuses.bitbucket?.email ?? null}
          onClose={() => setDialog(null)}
          onChanged={() => changed('jira')}
        />
      ) : null}
      {dialog === 'bitbucket' ? (
        <BitbucketConnectDialog
          status={statuses.bitbucket ?? { connected: false, email: null }}
          suggestedEmail={statuses.jira?.email ?? null}
          onClose={() => setDialog(null)}
          onChanged={() => changed('bitbucket')}
        />
      ) : null}
      {dialog === 'notion' ? (
        <NotionConnectDialog
          connected={statuses.notion?.connected === true}
          onClose={() => setDialog(null)}
          onChanged={() => changed('notion')}
        />
      ) : null}
    </div>
  )
}
