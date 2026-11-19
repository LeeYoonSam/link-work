// 모바일 열람(휴대폰 브라우저) 계약 타입 — 메인 프로세스 쪽.
// 렌더러의 src/renderer/src/mobile/contract.ts 와 같은 모양이다 — 한쪽을 바꾸면 다른 쪽도 바꾼다.
// 메인은 렌더러 폴더를 import 할 수 없어 따로 둔다. 오늘 스냅샷은 메인이 해석하지 않으므로 opaque 로 둔다.

/**
 * 데스크톱 렌더러가 조립해 올린 오늘 대시보드 스냅샷.
 * 메인은 객체인지·date 가 YYYY-MM-DD 인지·직렬화 크기만 검사하고 그대로 돌려준다.
 */
export interface MobileTodaySnapshot {
  date: string
  [key: string]: unknown
}

/** 설정 화면이 읽는 서버 상태 (IPC mobile:getStatus / setEnabled / regenerateToken 의 반환) */
export interface MobileServerStatus {
  /** 사용자가 켰는가(저장값) */
  enabled: boolean
  /** 실제로 듣고 있는가 */
  running: boolean
  port: number | null
  /** 토큰이 든 페어링 URL(http://<LAN IP>:<port>/pair?t=…). 꺼져 있거나 LAN 주소가 없으면 null */
  pairUrl: string | null
  /** pairUrl 의 QR. 'data:image/svg+xml;…' 꺼져 있으면 null */
  qrDataUrl: string | null
  /** 켜기 실패 사유(포트 사용 중 등). 없으면 null */
  error: string | null
  /**
   * 휴대폰이 열 수 있는 주소 전부(주소마다 QR 1개). 꺼져 있으면 빈 배열.
   * 순서: 같은 네트워크(lan, en0 우선) → Tailscale. pairUrl·qrDataUrl 은 addresses[0] 과 같다.
   */
  addresses: MobileAddress[]
  /** 'connected': Tailscale 주소(100.64.0.0/10)가 있다. 'installed': 앱만 있다. 'not_installed': 없다 */
  tailscale: MobileTailscaleState
}

export type MobileTailscaleState = 'connected' | 'installed' | 'not_installed'

export interface MobileAddress {
  kind: 'lan' | 'tailscale'
  /** 네트워크 인터페이스 이름(en0, utun4 …) */
  iface: string
  ip: string
  /** http://<ip>:<port>/pair?t=… */
  pairUrl: string
  /** pairUrl 의 QR (data:image/svg+xml;…) */
  qrDataUrl: string
}

export interface MobileTodayResponse {
  snapshot: MobileTodaySnapshot | null
}

export interface MobileMemoCreateBody {
  /** trim 후 1~20000자 */
  content: string
  category_id?: number | null
  is_important?: 0 | 1
}

export interface MobileMemoCreated {
  id: number
}

export interface MobileOk {
  success: true
}

export interface MobileError {
  error: string
}

export type MobilePublishResult = { success: boolean; error?: string }

/** 휴대폰 쓰기 뒤 데스크톱 화면에 알리는 엔티티 (기존 'ai:dataChanged' 채널의 payload) */
export type MobileChangedEntity = 'todo' | 'memo'

/** 서버 기본 포트와 대체 포트(사용 중이면 순서대로 시도) */
export const MOBILE_DEFAULT_PORT = 8946
export const MOBILE_PORT_CANDIDATES: readonly number[] = [
  8946, 8947, 8948, 8949, 8950, 8951, 8952, 8953, 8954, 8955
]

/** app_settings 키. 둘 다 기기 종속이라 백업에서 뺀다(backup-groups SECRET_SETTING_KEYS) */
export const MOBILE_TOKEN_KEY = 'mobile_server_token'
export const MOBILE_ENABLED_KEY = 'mobile_server_enabled'
