const INK = '#1e2235'

export type MenuIconName =
  | 'dashboard'
  | 'projects'
  | 'todos'
  | 'documents'
  | 'variables'
  | 'memos'
  | 'calendar'
  | 'reports'
  | 'ai'

const PATHS: Record<MenuIconName, React.ReactNode> = {
  dashboard: (
    <>
      <g stroke={INK} strokeWidth="1.9" strokeLinejoin="round">
        <rect x="2.5" y="2.5" width="8" height="10" rx="2" fill="#FFD43B" />
        <rect x="13.8" y="2.5" width="8" height="6" rx="2" fill="#4DABF7" />
        <rect x="13.8" y="11.8" width="8" height="9.7" rx="2" fill="#FF8787" />
        <rect x="2.5" y="15.8" width="8" height="5.7" rx="2" fill="#63E6BE" />
      </g>
      <path d="M4.6 5.2l2.4-1" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
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
  documents: (
    <>
      <path
        d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"
        fill="#F8F9FA"
        stroke={INK}
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path d="M14 2v5h6" fill="#CED4DA" stroke={INK} strokeWidth="1.9" strokeLinejoin="round" />
      <g stroke="#4DABF7" strokeWidth="2" strokeLinecap="round">
        <path d="M15.5 13H8" />
        <path d="M13 17H8" />
      </g>
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
  reports: (
    <>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" fill="none" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
      <g stroke={INK} strokeWidth="1.8" strokeLinejoin="round">
        <rect x="6.8" y="12" width="3.6" height="6" rx="1.2" fill="#FFD43B" />
        <rect x="11.9" y="8.5" width="3.6" height="9.5" rx="1.2" fill="#63E6BE" />
        <rect x="17" y="5" width="3.6" height="13" rx="1.2" fill="#4DABF7" />
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
