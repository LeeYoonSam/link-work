import { ipcMain } from 'electron'
import { verifyIntegration, type IntegrationProbe, type IntegrationId } from '../services/integration-verify'
import { getJiraStatus, isJiraConnected, verifyStoredJira } from '../services/jira'
import { isBitbucketConnected, verifyStoredBitbucket } from '../services/bitbucket'
import { isNotionConnected, verifyStoredNotion } from '../services/notion'
import { hasCredentials, isConnected as isGoogleConnected } from '../services/google-auth'
import { verifyGoogleCalendar } from '../services/google-calendar'

// 설정 화면 IPC. 이 층은 비밀값을 직접 읽지 않는다 — 서비스의 연결 여부·검증 함수만 조합한다.
// verifyIntegration 은 throw 하지 않고 비밀값 없는 결과만 돌려준다.

const PROBES: Record<IntegrationId, IntegrationProbe> = {
  google: {
    isConnected: () => hasCredentials() && isGoogleConnected(),
    verify: verifyGoogleCalendar
  },
  jira: {
    isConnected: isJiraConnected,
    isExpired: () => getJiraStatus().expired,
    verify: verifyStoredJira
  },
  bitbucket: {
    isConnected: isBitbucketConnected,
    verify: verifyStoredBitbucket
  },
  notion: {
    isConnected: isNotionConnected,
    verify: verifyStoredNotion
  }
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:verifyIntegration', (_event, id: unknown) =>
    verifyIntegration(id, { probes: PROBES })
  )
}
