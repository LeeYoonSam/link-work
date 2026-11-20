import { create } from 'zustand'
import type {
  AiBitbucketStatus,
  AiNotionStatus,
  AiStatus,
  CalendarStatus,
  IntegrationId,
  IntegrationVerifyResult,
  JiraConnectionStatus
} from '../types'
import { useNavigationStore } from './navigationStore'
import {
  DEFAULT_SETTINGS_SECTION,
  normalizeSettingsSection,
  type SettingsSectionId
} from '../components/settings/settingsCatalog'

// 설정 화면 전역 상태 (docs/SETTINGS.md).
//
// 연동 상태는 기존 IPC 5개(calendar·jira·notion·bitbucket·ai status)를 병렬로 읽어 모은다.
// 한 연동이 실패해도 나머지는 채운다 — 실패한 것만 `statusErrors`에 남긴다.
// 상태 조회는 외부 API를 부르지 않는다. 외부 검증은 verify 버튼을 눌렀을 때만 한다.
//
// verify 결과와 checkedAt 은 이 스토어 메모리에만 둔다. DB 키를 늘리지 않는다.

interface IntegrationStatuses {
  google: CalendarStatus | null
  jira: JiraConnectionStatus | null
  bitbucket: AiBitbucketStatus | null
  notion: AiNotionStatus | null
}

type StatusKey = IntegrationId | 'claude'

export const INTEGRATION_IDS: IntegrationId[] = ['google', 'jira', 'bitbucket', 'notion']

interface SettingsStore {
  section: SettingsSectionId
  statuses: IntegrationStatuses
  claude: AiStatus | null
  /** 상태 조회에 실패한 항목의 오류 문구 */
  statusErrors: Partial<Record<StatusKey, string>>
  verifyResults: Partial<Record<IntegrationId, IntegrationVerifyResult>>
  verifying: Partial<Record<IntegrationId, boolean>>

  /** 설정 화면으로 이동한다. section 을 주면 그 섹션을 고른다 */
  open: (section?: SettingsSectionId) => void
  setSection: (section: SettingsSectionId) => void
  refreshStatuses: () => Promise<void>
  /** Claude Code 상태만 다시 읽는다 */
  refreshClaude: () => Promise<void>
  verify: (id: IntegrationId) => Promise<IntegrationVerifyResult>
  verifyAll: () => Promise<void>
  /** 다시 연결·해제 뒤 이전 검증 결과를 지운다 */
  clearVerify: (id: IntegrationId) => void
}

const message = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message ? err.message : fallback

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  section: DEFAULT_SETTINGS_SECTION,
  statuses: { google: null, jira: null, bitbucket: null, notion: null },
  claude: null,
  statusErrors: {},
  verifyResults: {},
  verifying: {},

  open: (section) => {
    if (section !== undefined) set({ section: normalizeSettingsSection(section) })
    useNavigationStore.getState().setView('settings')
  },

  setSection: (section) => set({ section: normalizeSettingsSection(section) }),

  refreshStatuses: async () => {
    const api = window.api
    const [google, jira, bitbucket, notion, claude] = await Promise.allSettled([
      api.calendar.status(),
      api.jira.status(),
      api.ai.bitbucketStatus(),
      api.ai.notionStatus(),
      api.ai.status()
    ])
    const errors: Partial<Record<StatusKey, string>> = {}
    const pick = <T>(key: StatusKey, r: PromiseSettledResult<T>, prev: T | null): T | null => {
      if (r.status === 'fulfilled') return r.value
      errors[key] = message(r.reason, '상태를 읽지 못했습니다')
      return prev
    }
    const prev = get()
    set({
      statuses: {
        google: pick('google', google, prev.statuses.google),
        jira: pick('jira', jira, prev.statuses.jira),
        bitbucket: pick('bitbucket', bitbucket, prev.statuses.bitbucket),
        notion: pick('notion', notion, prev.statuses.notion)
      },
      claude: pick('claude', claude, prev.claude),
      statusErrors: errors
    })
  },

  refreshClaude: async () => {
    try {
      const claude = await window.api.ai.status()
      set((s) => {
        const statusErrors = { ...s.statusErrors }
        delete statusErrors.claude
        return { claude, statusErrors }
      })
    } catch (err) {
      set((s) => ({
        statusErrors: { ...s.statusErrors, claude: message(err, '상태를 읽지 못했습니다') }
      }))
    }
  },

  verify: async (id) => {
    set((s) => ({ verifying: { ...s.verifying, [id]: true } }))
    let result: IntegrationVerifyResult
    try {
      result = await window.api.settings.verifyIntegration(id)
    } catch (err) {
      // IPC 는 throw 하지 않기로 했지만 브리지가 끊긴 경우를 대비한다
      result = {
        ok: false,
        code: 'unknown',
        error: message(err, '연결을 확인하지 못했습니다'),
        checkedAt: new Date().toISOString()
      }
    }
    set((s) => ({
      verifyResults: { ...s.verifyResults, [id]: result },
      verifying: { ...s.verifying, [id]: false }
    }))
    return result
  },

  verifyAll: async () => {
    await get().refreshStatuses()
    await Promise.all(INTEGRATION_IDS.map((id) => get().verify(id)))
  },

  clearVerify: (id) =>
    set((s) => {
      const verifyResults = { ...s.verifyResults }
      delete verifyResults[id]
      return { verifyResults }
    })
}))
