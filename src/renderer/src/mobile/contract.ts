// 모바일 열람(휴대폰 브라우저) 계약 타입. 데스크톱 렌더러(발행·설정)와 모바일 화면이 함께 쓴다.
// 메인 프로세스의 src/main/services/mobile/types.ts 와 같은 모양이다 — 한쪽을 바꾸면 다른 쪽도 바꾼다.
// 순수 타입 모듈이다. React·스토어·window 를 쓰지 않는다.
import type { Memo, MemoCategory, Todo } from '../types'
import type { TodayDashboard } from '../components/today/todayModel'

/** 데스크톱이 조립해 메인에 올려 두는 오늘 대시보드 스냅샷. 메인은 내용을 해석하지 않는다(크기·date 만 검사) */
export interface MobileTodaySnapshot {
  /** 계약 버전. 모양을 바꾸면 올린다 */
  v: 1
  /** 발행 시각 ISO */
  publishedAt: string
  /** 대시보드의 날짜 YYYY-MM-DD (dashboard.date 와 같다) */
  date: string
  /** '11월 19일 (목)' */
  heading: string
  /** 오늘 화면과 같은 규칙 문구의 대시보드 */
  dashboard: TodayDashboard
  /** 데스크톱이 일정·Jira 를 불러오는 중이었는가 */
  loading: boolean
}

/** 설정 화면이 읽는 서버 상태 (IPC mobile:getStatus / setEnabled / regenerateToken 의 반환) */
export interface MobileServerStatus {
  /** 사용자가 켰는가(저장값) */
  enabled: boolean
  /** 실제로 듣고 있는가 */
  running: boolean
  port: number | null
  /** 휴대폰이 열 주소. 토큰이 든 페어링 URL(http://<LAN IP>:<port>/pair?t=…). 꺼져 있거나 LAN 주소가 없으면 null */
  pairUrl: string | null
  /** pairUrl 의 QR. 'data:image/svg+xml;…' 꺼져 있으면 null */
  qrDataUrl: string | null
  /** 켜기 실패 사유(포트 사용 중 등). 없으면 null */
  error: string | null
  /**
   * 휴대폰이 열 수 있는 주소 전부(주소마다 QR 1개). 꺼져 있으면 빈 배열.
   * 순서: 같은 네트워크(lan, en0 우선) → Tailscale. pairUrl·qrDataUrl 은 addresses[0] 과 같다.
   * 쿠키는 주소(출처)마다 따로라서 주소를 바꾸면 그 주소의 QR 로 한 번 더 스캔해야 한다.
   */
  addresses: MobileAddress[]
  /**
   * Tailscale 상태. 'connected': 이 Mac 에 Tailscale 주소(100.64.0.0/10)가 있다.
   * 'installed': 앱은 있지만 연결되지 않았다. 'not_installed': 앱이 없다.
   */
  tailscale: 'connected' | 'installed' | 'not_installed'
}

export interface MobileAddress {
  /** lan: 같은 Wi-Fi·유선 네트워크. tailscale: Tailscale 사설망(다른 Wi-Fi·LTE 에서도 접속) */
  kind: 'lan' | 'tailscale'
  /** 네트워크 인터페이스 이름(en0, utun4 …). 화면 보조 표기용 */
  iface: string
  ip: string
  /** http://<ip>:<port>/pair?t=… */
  pairUrl: string
  /** pairUrl 의 QR (data:image/svg+xml;…) */
  qrDataUrl: string
}

// ── HTTP API (모두 쿠키 인증 필요, JSON) ───────────────────
// GET  /api/today                 → MobileTodayResponse   (메인이 데스크톱에 재발행도 요청한다)
// GET  /api/todos?completed=0|1   → MobileTodosResponse
// POST /api/todos/:id/complete    → MobileOk
// POST /api/todos/:id/restore     → MobileOk
// GET  /api/memos                 → MobileMemosResponse   (보관하지 않은 메모 전부 + 카테고리)
// POST /api/memos                 → MobileMemoCreated     (본문 MobileMemoCreateBody)
// 실패는 { error: string } 과 4xx/5xx. 401 이면 화면이 "QR 을 다시 스캔하세요" 를 보인다.
// POST 는 헤더 'X-LinkWork-Mobile: 1' 과 'Content-Type: application/json' 이 있어야 한다.

export interface MobileTodayResponse {
  snapshot: MobileTodaySnapshot | null
}

export interface MobileTodosResponse {
  todos: Todo[]
}

export interface MobileMemosResponse {
  memos: Memo[]
  categories: MemoCategory[]
}

export interface MobileMemoCreateBody {
  /** 1~20000자 */
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

