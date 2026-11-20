const INK = '#1e2235'

export type MenuIconName =
  | 'today'
  | 'projects'
  | 'todos'
  | 'variables'
  | 'memos'
  | 'calendar'
  | 'ai'
  | 'recordings'
  | 'notes'
  | 'settings'

const PATHS: Record<MenuIconName, React.ReactNode> = {
  // 오늘 화면 전용 해 모양. 캘린더 아이콘과 겹치지 않게 따로 둔다
  today: (
    <>
      <g stroke={INK} strokeWidth="2.2" strokeLinecap="round">
        <path d="M12 1.8v2.4" />
        <path d="M12 19.8v2.4" />
        <path d="M1.8 12h2.4" />
        <path d="M19.8 12h2.4" />
        <path d="m4.8 4.8 1.7 1.7" />
        <path d="m17.5 17.5 1.7 1.7" />
        <path d="m4.8 19.2 1.7-1.7" />
        <path d="m17.5 6.5 1.7-1.7" />
      </g>
      <circle cx="12" cy="12" r="5.6" fill="#FFD43B" stroke={INK} strokeWidth="1.9" />
      <path d="M9.3 10.4a3.2 3.2 0 0 1 1.6-1.6" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  projects: (
    <>
      <path
        d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
        fill="#FFD43B"
        stroke={INK}
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path d="M4.6 9.5l3-1.2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  todos: (
    <>
      <rect x="2.5" y="2.5" width="19" height="19" rx="4" fill="#63E6BE" stroke={INK} strokeWidth="1.9" />
      <path
        d="m8 12.4 2.8 2.8 5.6-6.2"
        fill="none"
        stroke={INK}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5 6.4l2.2-1.2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  variables: (
    <>
      <g stroke={INK} strokeWidth="2" strokeLinecap="round">
        <path d="M3 4.5h18" />
        <path d="M3 12h18" />
        <path d="M3 19.5h18" />
      </g>
      <g stroke={INK} strokeWidth="1.8">
        <circle cx="14.5" cy="4.5" r="3" fill="#FFD43B" />
        <circle cx="8" cy="12" r="3" fill="#FF8787" />
        <circle cx="16" cy="19.5" r="3" fill="#4DABF7" />
      </g>
    </>
  ),
  memos: (
    <>
      <path
        d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2Z"
        fill="#FFD43B"
        stroke={INK}
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M14.6 21.4 22 14h-5a2 2 0 0 0-2 2Z"
        fill="#F59F00"
        stroke={INK}
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <g stroke={INK} strokeWidth="1.8" strokeLinecap="round">
        <path d="M7.5 9h9" />
        <path d="M7.5 13h5.5" />
      </g>
    </>
  ),
  calendar: (
    <>
      <rect x="2.5" y="4" width="19" height="17.5" rx="3" fill="#F8F9FA" stroke={INK} strokeWidth="1.9" />
      <path d="M2.5 7a3 3 0 0 1 3-3h13a3 3 0 0 1 3 3v3h-19Z" fill="#FF8787" stroke={INK} strokeWidth="1.9" />
      <g stroke={INK} strokeWidth="2.2" strokeLinecap="round">
        <path d="M8 2v4" />
        <path d="M16 2v4" />
      </g>
      <g fill={INK}>
        <circle cx="8" cy="14.5" r="1.4" />
        <circle cx="12" cy="14.5" r="1.4" />
        <circle cx="16" cy="14.5" r="1.4" />
        <circle cx="8" cy="18.2" r="1.4" />
        <circle cx="12" cy="18.2" r="1.4" />
      </g>
    </>
  ),
  ai: (
    <>
      <path
        d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
        fill="#FFD43B"
        stroke={INK}
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M19.5 2.2l1 2.3 2.3 1-2.3 1-1 2.3-1-2.3-2.3-1 2.3-1Z"
        fill="#FAA2C1"
        stroke={INK}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="4.5" cy="18.5" r="1.3" fill="#4DABF7" stroke={INK} strokeWidth="1.4" />
    </>
  ),
  recordings: (
    <>
      <rect x="8.3" y="2.5" width="7.4" height="12" rx="3.7" fill="#FF8787" stroke={INK} strokeWidth="1.9" />
      <path d="M5 11a7 7 0 0 0 14 0" fill="none" stroke={INK} strokeWidth="1.9" strokeLinecap="round" />
      <path d="M12 18v3.2" stroke={INK} strokeWidth="1.9" strokeLinecap="round" />
      <path d="M8.6 21.4h6.8" stroke={INK} strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="12" cy="6" r="1.5" fill="#fff" />
    </>
  ),
  notes: (
    <>
      <path
        d="M6 2.5h9l4.5 4.5v12.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2Z"
        fill="#F8F9FA"
        stroke={INK}
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path d="M15 2.5V7h4.5" fill="#63E6BE" stroke={INK} strokeWidth="1.9" strokeLinejoin="round" />
      <g stroke={INK} strokeWidth="1.8" strokeLinecap="round">
        <path d="M7.8 11h8" />
        <path d="M7.8 14.5h8" />
        <path d="M7.8 18h5" />
      </g>
    </>
  ),
  // 톱니바퀴. 사이드바 하단의 설정 항목
  settings: (
    <>
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        fill="#ADB5BD"
        stroke={INK}
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" fill="#fff" stroke={INK} strokeWidth="1.9" />
    </>
  )
}

interface MenuIconProps {
  name: MenuIconName
  size?: number
  dimmed?: boolean
}

export default function MenuIcon({ name, size = 18, dimmed = false }: MenuIconProps): React.ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="shrink-0 transition-[filter] duration-150"
      style={dimmed ? { filter: 'grayscale(0.55) opacity(0.62)' } : undefined}
    >
      {PATHS[name]}
    </svg>
  )
}
