import { useProjectStore } from '../../stores/projectStore'

const navItems = [
  { id: 'dashboard' as const, label: 'Dashboard', icon: '□' },
  { id: 'projects' as const, label: 'Projects', icon: '▤' },
  { id: 'todos' as const, label: 'TODO', icon: '☑' },
  { id: 'documents' as const, label: 'Documents', icon: '◫' },
  { id: 'variables' as const, label: 'Variables', icon: '⚙' },
  { id: 'memos' as const, label: 'Memos', icon: '▪' },
  { id: 'calendar' as const, label: 'Calendar', icon: '▦' },
  { id: 'reports' as const, label: 'Reports', icon: '▥' }
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
            <span className="text-lg">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  )
}
