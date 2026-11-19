// 모바일 화면 공용 작은 조각. 훅을 쓰지 않는다(테스트가 함수로 직접 펼친다).
// 색·글자는 mobile.css 의 토큰 클래스(m-*)로만 정한다 — 다크 모드가 토큰만 바꿔 따라오게.
import type { ReactNode } from 'react'

/** 화면 맨 위 sticky 헤더. 대형 타이틀(h1) 1개와 오른쪽 동작 */
export function PageHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }): React.ReactNode {
  return (
    <header className="m-header">
      <h1 className="m-title">{title}</h1>
      {actions}
    </header>
  )
}

/** 카드. 섹션 제목(h2) + 오른쪽 메타 */
export function Section({
  id,
  title,
  meta,
  children
}: {
  id?: string
  title: ReactNode
  meta?: ReactNode
  children: ReactNode
}): React.ReactNode {
  return (
    <section id={id} className="m-card" aria-labelledby={id ? `${id}-title` : undefined}>
      <div className="m-card-head">
        <h2 id={id ? `${id}-title` : undefined} className="m-h2 min-w-0">
          {title}
        </h2>
        {meta ? <span className="m-meta shrink-0">{meta}</span> : null}
      </div>
      {children}
    </section>
  )
}

export type EmptyKind = 'calm' | 'link' | 'wait' | 'error'

const EMPTY_ICON: Record<EmptyKind, ReactNode> = {
  // 체크 원: 할 일·신호 없음
  calm: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 2.6 2.5L16 9.5" />
    </>
  ),
  // 끊긴 고리: 미연결
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  // 시계: 불러오는 중
  wait: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  // 느낌표: 실패
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </>
  )
}

/** 빈 상태·미연결·불러오는 중: 아이콘 + 한 줄 */
export function Empty({ kind = 'calm', children }: { kind?: EmptyKind; children: ReactNode }): React.ReactNode {
  return (
    <p className="m-empty" data-empty={kind}>
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {EMPTY_ICON[kind]}
      </svg>
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** 오류 문구. role=alert 로 읽어 준다 */
export function ErrorNote({ text }: { text: string | null }): React.ReactNode {
  if (!text) return null
  return (
    <p role="alert" data-testid="error-note" className="m-alert">
      {text}
    </p>
  )
}

/** 큰 원형 체크(보이는 원 26px, 터치 영역 44px) */
export function CheckButton({
  checked,
  label,
  disabled,
  onClick
}: {
  checked: boolean
  label: string
  disabled?: boolean
  onClick: () => void
}): React.ReactNode {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onClick} className="m-check">
      <span aria-hidden className="m-check-dot">
        {checked ? (
          <svg width="14" height="14" viewBox="0 0 12 12">
            <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
    </button>
  )
}

/** 로딩 자리 표시(카드 모양) */
export function Skeleton({ lines = 3 }: { lines?: number }): React.ReactNode {
  return (
    <div aria-busy="true" aria-label="불러오는 중" className="m-stack">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="m-skel" aria-hidden>
          <div className="m-skel-line" style={{ width: '38%' }} />
          <div className="m-skel-line" style={{ width: '92%' }} />
          <div className="m-skel-line" style={{ width: '70%' }} />
        </div>
      ))}
    </div>
  )
}

export function RefreshIcon({ spinning = false }: { spinning?: boolean }): React.ReactNode {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden className={spinning ? 'animate-spin' : ''}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 새로고침 아이콘 버튼(44px) */
export function RefreshButton({ busy, onClick }: { busy: boolean; onClick: () => void }): React.ReactNode {
  return (
    <button type="button" onClick={onClick} disabled={busy} aria-label="새로고침" className="m-icon-btn">
      <RefreshIcon spinning={busy} />
    </button>
  )
}
