// 디자인 시스템 프리미티브 — tokens.ts의 클래스 맵을 소비하는 얇은 래퍼들
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode, MouseEventHandler } from 'react'
import { typo, surface, taskTag } from './tokens'
import { parseTaskLabel, isIssueKey } from '../../utils/taskLabel'
import { placeTooltip, TOOLTIP_MARGIN } from '../../utils/tooltipPosition'

export * from './tokens'
export * from './icons'

// 아이콘 전용 버튼 — hover 시에만 색이 드러나는 조용한 액션
export function IconButton({
  children,
  title,
  onClick,
  tone = 'default',
  active = false
}: {
  children: ReactNode
  title?: string
  onClick?: MouseEventHandler
  tone?: 'default' | 'danger' | 'primary' | 'star'
  active?: boolean
}): React.ReactNode {
  const tones: Record<string, string> = {
    default: 'text-gray-400 hover:text-gray-600 hover:bg-gray-100',
    danger: 'text-gray-400 hover:text-red-500 hover:bg-red-50',
    primary: 'text-gray-400 hover:text-blue-600 hover:bg-blue-50',
    star: active
      ? 'text-amber-400 hover:text-amber-500 hover:bg-amber-50'
      : 'text-gray-300 hover:text-amber-400 hover:bg-amber-50'
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`p-1 rounded-md transition-colors ${tones[tone]}`}
    >
      {children}
    </button>
  )
}

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

// 서버 렌더(테스트의 renderToStaticMarkup)에서 useLayoutEffect 경고가 나지 않도록 갈라 쓴다
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

// 트리거와 말풍선 사이 간격. 마우스로 건너가는 동안 닫히면 안 되므로 CLOSE_DELAY와 짝이다.
const TIP_GAP = 6
const CLOSE_DELAY = 120

// 네이티브 title 속성 대체 툴팁.
// title은 표시까지 1초 가까이 걸리고 스타일도 키보드 접근도 불가하다.
// WCAG 1.4.13 3요건을 지킨다 — Escape로 닫히고(dismissible),
// 툴팁 위로 마우스를 옮겨도 유지되며(hoverable), 스스로 사라지지 않는다(persistent).
//
// body로 portal한다. absolute로 띄우면 overflow 조상에 잘리는데, 실제로
// TaskList의 목록 컨테이너(padding 없는 overflow-hidden)와 대시보드 TODO 패널
// (overflow-auto 스크롤 영역)에서 첫 행 말풍선이 잘려 원문을 볼 수단이 사라졌다.
export function Tooltip({
  content,
  children,
  className,
  focusable = true
}: {
  content: string
  children: ReactNode
  /** 래퍼의 display·폭 지정. 주면 기본값(inline-block max-w-full)을 대체한다 */
  className?: string
  /** 조상이 이미 포커스 가능하면 false로 꺼서 탭 정지점 중첩을 막는다 */
  focusable?: boolean
}): React.ReactNode {
  const id = useId()
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const tipRef = useRef<HTMLSpanElement | null>(null)
  const [open, setOpen] = useState(false)
  // below는 투명 다리를 붙일 방향을 정한다
  const [pos, setPos] = useState<{ top: number; left: number; below: boolean } | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = (): void => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  // 트리거를 벗어나도 곧장 닫지 않는다 — TIP_GAP을 건너 말풍선에 도달할 틈을 준다
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY)
  }
  const openNow = (): void => {
    cancelClose()
    setOpen(true)
  }

  // 말풍선을 숨긴 채 먼저 렌더해 실제 크기를 재고 뷰포트 안으로 배치한다.
  // 위가 모자라면 아래로 뒤집는다 — 스크롤 컨테이너에서는 한쪽만 고정하면 반대편이 잘린다.
  useBrowserLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const trigger = triggerRef.current
    const tip = tipRef.current
    if (!trigger || !tip) return
    const t = trigger.getBoundingClientRect()
    // height에는 TIP_GAP을 덮는 투명 다리가 이미 포함돼 있다
    const { width, height } = tip.getBoundingClientRect()
    setPos(
      placeTooltip(
        t,
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
        TOOLTIP_MARGIN
      )
    )
  }, [open, content])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    const close = (): void => setOpen(false)
    document.addEventListener('keydown', onKeyDown)
    // fixed로 띄우므로 트리거가 움직이면 말풍선만 제자리에 남는다. capture여야
    // 내부 스크롤 컨테이너(TODO 패널 등)의 스크롤도 잡힌다.
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  useEffect(() => cancelClose, [])

  const bubble =
    open && typeof document !== 'undefined'
      ? createPortal(
          <span
            ref={tipRef}
            className="fixed z-50"
            style={{
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              // 측정 전 한 프레임이 엉뚱한 자리에 깜빡이지 않게 감춘다
              visibility: pos ? 'visible' : 'hidden',
              // 트리거와의 간격을 덮는 투명 다리. 마우스가 이 위를 지나므로 끊기지 않는다.
              // 측정 단계(pos === null)에도 높이에 잡혀야 배치 계산이 맞는다.
              paddingTop: pos?.below ? TIP_GAP : 0,
              paddingBottom: pos?.below ? 0 : TIP_GAP
            }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            // portal이라도 React 트리에서는 트리거의 자식이라 클릭이 행까지 올라간다
            onClick={(e) => e.stopPropagation()}
          >
            {/* w-max가 없으면 배치 좌표에 따라 줄바꿈이 달라져 측정 높이가 어긋난다 */}
            <span
              id={id}
              role="tooltip"
              className="block w-max max-w-xs whitespace-pre-wrap break-words rounded-md bg-gray-900 px-2 py-1 text-xs text-white shadow-lg"
            >
              {content}
            </span>
          </span>,
          document.body
        )
      : null

  return (
    <span
      ref={triggerRef}
      className={className ?? 'inline-block max-w-full'}
      {...(focusable ? { tabIndex: 0 } : {})}
      aria-describedby={open ? id : undefined}
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onFocus={openNow}
      onBlur={scheduleClose}
    >
      {children}
      {bubble}
    </span>
  )
}

// Tailwind는 클래스명을 정적으로 스캔하므로 `line-clamp-${lines}` 조합은 빌드에서 누락된다
const CLAMP: Record<1 | 2 | 3, string> = {
  1: 'line-clamp-1',
  2: 'line-clamp-2',
  3: 'line-clamp-3'
}

// 자르기는 CSS로만 한다. JS로 문자열을 잘라 넣으면 보조기술이 원문에 영영 접근할 수 없다.
// 실제로 잘렸을 때만 툴팁을 달아 불필요한 탭 정지점을 만들지 않는다.
export function ClampedText({
  text,
  lines = 2,
  className = '',
  children,
  focusable = true
}: {
  /** 툴팁에 쓸 원문 */
  text: string
  lines?: 1 | 2 | 3
  /**
   * 잘리는 span에 적용된다. 폭은 부모가 정한다.
   * display 유틸리티(block·flex 등)는 넘기지 말 것 — line-clamp의 -webkit-box를
   * 덮어써서 자르기가 조용히 풀린다.
   */
  className?: string
  children?: ReactNode
  /** 조상이 이미 포커스 가능하면 false로 넘긴다 */
  focusable?: boolean
}): React.ReactNode {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [clamped, setClamped] = useState(false)

  // clamped가 바뀌면 반환 트리가 Tooltip 래핑으로 바뀌어 span이 재마운트된다.
  // deps에 clamped가 없으면 observer가 분리된 옛 노드를 계속 봐서, 창을 넓혀
  // 한 줄에 들어가도 툴팁과 여분의 탭 정지점이 영영 남는다.
  useBrowserLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = (): void => setClamped(el.scrollHeight > el.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, lines, clamped])

  const body = (
    <span ref={ref} className={`${CLAMP[lines]} ${className}`}>
      {children ?? text}
    </span>
  )
  // 측정 전(SSR 포함) 기본값은 "안 잘림" — 서버와 첫 클라이언트 렌더 결과를 같게 둔다
  if (!clamped) return body
  return (
    <Tooltip content={text} className="block min-w-0" focusable={focusable}>
      {body}
    </Tooltip>
  )
}

// 작업명 선두의 `[ICA-8681] [검색홈]` 같은 접두사를 칩으로 떼어내 제목이 쓸 폭을 넓힌다.
// 칩은 inline-flex라야 제목과 한 흐름에 놓여 line-clamp가 전체에 걸린다.
export function TaskLabel({
  name,
  lines = 2,
  className = '',
  leading,
  focusable = true
}: {
  name: string
  lines?: 1 | 2
  className?: string
  /** 행 높이 제어용 line-height 클래스 (예: 'leading-[14px]') */
  leading?: string
  /** 조상이 이미 포커스 가능하면 false로 넘긴다 */
  focusable?: boolean
}): React.ReactNode {
  const { tags, title } = parseTaskLabel(name)
  return (
    <ClampedText
      text={name}
      lines={lines}
      focusable={focusable}
      className={`${leading ?? ''} ${className}`}
    >
      {tags.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          className={`mr-1 inline-flex items-center align-baseline whitespace-nowrap rounded px-1 py-0 text-[10px] ${
            isIssueKey(tag) ? taskTag.issue : taskTag.domain
          }`}
        >
          {tag}
        </span>
      ))}
      {title}
    </ClampedText>
  )
}
