// 모바일 서버 수명 관리 — IPC(mobile.ipc.ts)와 앱 시작·종료(index.ts)가 쓰는 Electron 쪽 접착부.
import { BrowserWindow } from 'electron'
import { join } from 'path'
import { getDatabase } from '../../db/database'
import { logActivity } from '../../utils/activity-logger'
import { createMobileServer, type MobileServer } from './server'
import { createSnapshotStore } from './snapshot'
import { allowedHostNames, detectTailscale, listPairAddresses } from './network'
import { buildMobileStatus, createQrCache } from './status'
import { getOrCreateToken, isMobileEnabled, regenerateToken, setMobileEnabled } from './settings'
import {
  MOBILE_PORT_CANDIDATES,
  type MobileChangedEntity,
  type MobilePublishResult,
  type MobileServerStatus
} from './types'

const snapshots = createSnapshotStore()
let server: MobileServer | null = null
let lastError: string | null = null
/** 시작·중지가 겹치지 않게 순서대로 처리한다 */
let queue: Promise<unknown> = Promise.resolve()
const qrCache = createQrCache()

let hostCache: { at: number; hosts: string[] } | null = null
function cachedAllowedHosts(): string[] {
  const t = Date.now()
  if (!hostCache || t - hostCache.at > 5000) hostCache = { at: t, hosts: allowedHostNames() }
  return hostCache.hosts
}

function sendToAllWindows(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (payload === undefined) win.webContents.send(channel)
    else win.webContents.send(channel, payload)
  }
}

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  queue = next.catch(() => undefined)
  return next
}

function describeListenError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE') {
    return `포트 ${MOBILE_PORT_CANDIDATES[0]}~${MOBILE_PORT_CANDIDATES[MOBILE_PORT_CANDIDATES.length - 1]} 이 모두 사용 중입니다.`
  }
  return `서버를 시작하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`
}

async function startInternal(): Promise<void> {
  if (server?.running) return
  const s = createMobileServer({
    db: getDatabase(),
    getToken: () => getOrCreateToken(),
    // 빌드 산출물: out/main/index.js 기준 out/renderer (mobile.html, assets/*)
    staticRoot: join(__dirname, '../renderer'),
    getAllowedHosts: cachedAllowedHosts,
    getTodaySnapshot: snapshots.get,
    onDataChanged: (entity: MobileChangedEntity) => sendToAllWindows('ai:dataChanged', { entity }),
    onPublishRequested: () => sendToAllWindows('mobile:publishRequested'),
    logActivity: (entityType, action, entityId, entityName) =>
      logActivity(entityType, action, entityId, entityName)
  })
  try {
    getOrCreateToken()
    await s.listen(MOBILE_PORT_CANDIDATES)
    server = s
    lastError = null
  } catch (err) {
    server = null
    lastError = describeListenError(err)
    console.error('[mobile-server] start', err)
  }
}

async function stopInternal(): Promise<void> {
  const s = server
  server = null
  if (s) await s.close()
}

export function getMobileStatus(): MobileServerStatus {
  const running = server?.running ?? false
  const addresses = listPairAddresses()
  return buildMobileStatus({
    enabled: isMobileEnabled(),
    running,
    port: running ? server!.port : null,
    getToken: getOrCreateToken,
    lastError,
    addresses,
    tailscale: detectTailscale(addresses),
    qr: qrCache.get
  })
}

/** 앱 준비 뒤: 저장값이 켜짐이면 서버를 띄운다 */
export function startMobileServerIfEnabled(): Promise<void> {
  return serialize(async () => {
    if (isMobileEnabled()) await startInternal()
  })
}

export function setMobileServerEnabled(enabled: boolean): Promise<MobileServerStatus> {
  return serialize(async () => {
    setMobileEnabled(enabled)
    if (enabled) {
      await startInternal()
    } else {
      await stopInternal()
      lastError = null
      snapshots.clear()
    }
    return getMobileStatus()
  })
}

export function regenerateMobileToken(): Promise<MobileServerStatus> {
  return serialize(async () => {
    regenerateToken()
    return getMobileStatus()
  })
}

export function publishMobileToday(snapshot: unknown): MobilePublishResult {
  return snapshots.publish(snapshot)
}

/**
 * 앱 종료(will-quit). 큐를 기다리지 않고 즉시 듣기를 멈추고 연결을 끊는다 —
 * 호출 직후 DB 를 닫으므로 동기적으로 멈춰야 한다(close() 는 첫 await 전에 listen 소켓을 닫는다).
 */
export function stopMobileServer(): void {
  const s = server
  server = null
  if (s) void s.close()
}
