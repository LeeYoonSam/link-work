import { useProjectStore } from '../../stores/projectStore'
import MenuIcon, { MenuIconName } from '../icons/MenuIcon'

const navItems = [
  { id: 'dashboard' as const, label: 'Dashboard', icon: 'dashboard' as MenuIconName },
  { id: 'projects' as const, label: 'Projects', icon: 'projects' as MenuIconName },
  { id: 'todos' as const, label: 'TODO', icon: 'todos' as MenuIconName },
  { id: 'documents' as const, label: 'Documents', icon: 'documents' as MenuIconName },
  { id: 'variables' as const, label: 'Variables', icon: 'variables' as MenuIconName },
  { id: 'memos' as const, label: 'Memos', icon: 'memos' as MenuIconName },
  { id: 'calendar' as const, label: 'Calendar', icon: 'calendar' as MenuIconName },
  { id: 'reports' as const, label: 'Reports', icon: 'reports' as MenuIconName },
  { id: 'ai' as const, label: 'AI 대화', icon: 'ai' as MenuIconName }
]

export default function Sidebar(): React.ReactNode {
  const { view, setView, setProjectView } = useProjectStore()

  return (
    <aside className="w-56 bg-gray-900 text-white flex flex-col h-screen">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-xl font-bold tracking-tight">LinkWork</h1>
      </div>
      <nav className="flex-1 py-2">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              setView(item.id)
              if (item.id === 'projects') setProjectView('list')
            }}
            className={`w-full text-left px-4 py-3 flex items-center gap-3 text-sm transition-colors ${
              view === item.id
                ? 'bg-gray-700 text-white'
                : 'text-gray-400 hover:bg-gray-800 hover:text-white'
            }`}
          >
            <MenuIcon name={item.icon} size={18} dimmed={view !== item.id} />
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  )
}
