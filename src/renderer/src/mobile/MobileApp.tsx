// 모바일 열람 화면의 뼈대: 하단 탭(오늘·할 일·메모), 연결 상태(만료·오프라인) 안내.
// 탭은 URL hash(#today|#todos|#memos)에 반영해 새로고침해도 유지한다.
// 401 이면 화면 전체를 재스캔 안내로 바꾸고, 네트워크 실패면 배너 + 다시 시도를 보이되 마지막 데이터는 계속 보인다.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createMobileApi, type MobileApi } from './api'
import {
  TABS,
  connectionAfterError,
  connectionAfterSuccess,
  parseTabHash,
  readDraft,
  writeDraft,
  type Connection,
  type MemoDraft,
  type MobileTab
} from './mobileModel'
import TodayTab from './TodayTab'
import TodosTab from './TodosTab'
import MemosTab from './MemosTab'

export const EXPIRED_TITLE = '연결이 만료되었어요'
export const EXPIRED_TEXT = 'Mac 의 LinkWork 설정 → 모바일에서 QR 을 다시 스캔하세요.'
export const OFFLINE_TEXT = 'Mac 에 연결할 수 없어요'

/** 401: 화면 전체를 대신한다 */
export function ExpiredScreen(): ReactNode {
  return (
    <main data-testid="expired" className="m-center">
      <span className="m-center-icon" aria-hidden>
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <rect x="5" y="11" width="14" height="9" rx="2.5" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3M12 15v2" />
        </svg>
      </span>
      <h1 className="m-title m-title-free">{EXPIRED_TITLE}</h1>
      <p data-primary className="m-body m-c2 max-w-[22rem]">
        {EXPIRED_TEXT}
      </p>
    </main>
  )
}

/** 네트워크 실패 배너 */
export function OfflineBanner({ onRetry }: { onRetry: () => void }): ReactNode {
  return (
    <div role="alert" data-testid="offline" className="m-banner">
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
        <path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01M3 3l18 18" />
      </svg>
      <span className="min-w-0 flex-1">
        <strong className="font-semibold">{OFFLINE_TEXT}</strong>
        <span className="m-meta block">마지막으로 받은 내용을 보여 드려요.</span>
      </span>
      <button type="button" onClick={onRetry} className="m-text-btn shrink-0">
        다시 시도
      </button>
    </div>
  )
}

const TAB_ICON: Record<MobileTab, ReactNode> = {
  today: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="3" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  todos: (
    <>
      <path d="m4 7 1.5 1.5L8 6M4 13l1.5 1.5L8 12" />
      <path d="M11 7.5h9M11 13.5h9M11 19h9M4.5 19h2" />
    </>
  ),
  memos: (
    <>
      <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  )
}

export function TabBar({ tab, onTab }: { tab: MobileTab; onTab: (t: MobileTab) => void }): ReactNode {
  return (
    <nav aria-label="탭" className="m-tabbar">
      <ul>
        {TABS.map((t) => {
          const active = t.key === tab
          return (
            <li key={t.key} className="flex-1">
              <a
                href={`#${t.key}`}
                aria-current={active ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault()
                  onTab(t.key)
                }}
                className="m-tab"
              >
                <span className="m-tab-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
                    {TAB_ICON[t.key]}
                  </svg>
                </span>
                {t.label}
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/** 연결 상태에 따라 화면 틀을 고른다. 훅을 쓰지 않는다 */
export function MobileFrame({
  connection,
  tab,
  onTab,
  onRetry,
  children
}: {
  connection: Connection
  tab: MobileTab
  onTab: (t: MobileTab) => void
  onRetry: () => void
  children: ReactNode
}): ReactNode {
  if (connection === 'expired') return <ExpiredScreen />
  return (
    <>
      <main className="m-page">
        {connection === 'offline' ? (
          <div className="pt-[max(8px,env(safe-area-inset-top))]">
            <OfflineBanner onRetry={onRetry} />
          </div>
        ) : null}
        {children}
      </main>
      <TabBar tab={tab} onTab={onTab} />
    </>
  )
}

const readHash = (): MobileTab => parseTabHash(typeof window === 'undefined' ? '' : window.location.hash)

/** sessionStorage. 접근 자체가 막힌 브라우저(사생활 보호 등)면 null */
function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

export default function MobileApp({ api: injected }: { api?: MobileApi }): ReactNode {
  const api = useMemo(() => injected ?? createMobileApi(), [injected])
  const [tab, setTab] = useState<MobileTab>(readHash)
  const [connection, setConnection] = useState<Connection>('online')
  const [reloadKey, setReloadKey] = useState(0)
  // 메모 초안은 탭을 바꿔 MemosTab 이 내려가도 남도록 여기서 갖고, sessionStorage 에도 보관한다.
  // 401 만료 화면으로 바뀌었다가 같은 브라우저 탭에서 QR 을 다시 스캔해 돌아와도 되살아난다
  const [memoDraft, setMemoDraftState] = useState<MemoDraft | null>(() => readDraft(sessionStore()))
  const setMemoDraft = useCallback((d: MemoDraft | null) => {
    setMemoDraftState(d)
    writeDraft(sessionStore(), d)
  }, [])

  useEffect(() => {
    const onHash = (): void => setTab(readHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const selectTab = (t: MobileTab): void => {
    if (t === tab) {
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    // replaceState 로 바꿔 뒤로 가기 기록을 쌓지 않는다
    history.replaceState(null, '', `#${t}`)
    setTab(t)
    window.scrollTo(0, 0)
  }

  // 탭이 바뀌어도 같은 함수여야 탭의 effect 가 다시 돌지 않는다
  const onOk = useCallback(() => setConnection((c) => connectionAfterSuccess(c)), [])
  const onFail = useCallback((e: unknown) => setConnection((c) => connectionAfterError(c, e)), [])

  const tabProps = { api, reloadKey, onOk, onFail }
  return (
    <MobileFrame connection={connection} tab={tab} onTab={selectTab} onRetry={() => setReloadKey((k) => k + 1)}>
      {tab === 'today' ? <TodayTab {...tabProps} /> : tab === 'todos' ? <TodosTab {...tabProps} /> : <MemosTab {...tabProps} draft={memoDraft} onDraft={setMemoDraft} />}
    </MobileFrame>
  )
}
