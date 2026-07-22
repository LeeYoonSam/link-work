import { useProjectStore } from '../../stores/projectStore'

const viewTitles: Record<string, string> = {
  dashboard: 'Dashboard',
  projects: 'Projects',
  todos: 'TODO',
  documents: 'Documents',
  variables: 'Variables',
  memos: 'Memos',
  calendar: 'Calendar',
  reports: 'Reports',
  ai: 'AI 대화',
  recordings: '녹음'
}

export default function Header(): React.ReactNode {
  const { view } = useProjectStore()

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center px-6">
      <h2 className="text-lg font-semibold text-gray-800">{viewTitles[view]}</h2>
    </header>
  )
}
