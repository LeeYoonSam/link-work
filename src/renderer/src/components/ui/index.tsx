// 디자인 시스템 프리미티브 — tokens.ts의 클래스 맵을 소비하는 얇은 래퍼들
import type { ReactNode, MouseEventHandler } from 'react'
import { typo, surface } from './tokens'

export * from './tokens'

// 파스텔 필 뱃지. color에 tokens의 badge 클래스를 그대로 전달한다.
export function Badge({
  color,
  children,
  onClick,
  title,
  size = 'sm'
}: {
  color: string
  children: ReactNode
  onClick?: MouseEventHandler
  title?: string
  size?: 'sm' | 'xs'
}): React.ReactNode {
  const sizeCls = size === 'xs' ? 'px-1.5 py-0.5 text-[11px]' : 'px-2 py-0.5 text-xs'
  const base = `inline-flex items-center rounded-full font-medium whitespace-nowrap ${sizeCls} ${color}`
  if (onClick) {
    return (
      <button
        onClick={onClick}
        title={title}
        className={`${base} cursor-pointer hover:opacity-70 transition-opacity`}
      >
        {children}
      </button>
    )
  }
  return (
    <span className={base} title={title}>
      {children}
    </span>
  )
}

// 상태 도트. color에 tokens의 dot 클래스를 전달한다.
export function StatusDot({
  color,
  size = 'sm',
  title
}: {
  color: string
  size?: 'sm' | 'md'
  title?: string
}): React.ReactNode {
  const sizeCls = size === 'md' ? 'w-3 h-3' : 'w-2 h-2'
  return <span className={`inline-block rounded-full flex-shrink-0 ${sizeCls} ${color}`} title={title} />
}

// 화이트 카드 컨테이너
export function Card({
  children,
  padding = 'md',
  hover = false,
  onClick,
  className = ''
}: {
  children: ReactNode
  padding?: 'none' | 'sm' | 'md'
  hover?: boolean
  onClick?: MouseEventHandler
  className?: string
}): React.ReactNode {
  const padCls = padding === 'md' ? 'p-6' : padding === 'sm' ? 'p-4' : ''
  return (
    <div
      onClick={onClick}
      className={`${surface.card} ${padCls} ${hover ? surface.cardHover : ''} ${className}`}
    >
      {children}
    </div>
  )
}

// 섹션 타이틀: page(화면 섹션) / card(카드 내부) / micro(컬럼 헤더 등 마이크로 라벨)
export function SectionTitle({
  variant = 'card',
  children,
  className = ''
}: {
  variant?: 'page' | 'card' | 'micro'
  children: ReactNode
  className?: string
}): React.ReactNode {
  const cls =
    variant === 'page' ? typo.pageTitle : variant === 'micro' ? typo.microLabel : typo.cardTitle
  return <h3 className={`${cls} ${className}`}>{children}</h3>
}

// 진행률 바
export function ProgressBar({
  percent,
  color = 'bg-green-500',
  height = 'h-2'
}: {
  percent: number
  color?: string
  height?: string
}): React.ReactNode {
  const clamped = Math.min(100, Math.max(0, percent))
  return (
    <div className={`w-full bg-gray-200 rounded-full ${height}`}>
      <div
        className={`${height} rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

// 비어있는 상태 안내
export function EmptyState({
  children,
  compact = false
}: {
  children: ReactNode
  compact?: boolean
}): React.ReactNode {
  return (
    <div className={`text-center text-gray-400 text-sm ${compact ? 'py-4' : 'py-8'}`}>
      {children}
    </div>
  )
}
