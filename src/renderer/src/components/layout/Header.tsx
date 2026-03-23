import { useProjectStore } from '../../stores/projectStore'

const viewTitles = {
  dashboard: 'Dashboard',
  projects: 'Projects',
  calendar: 'Calendar'
}

export default function Header(): React.ReactNode {
  const { view } = useProjectStore()

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center px-6">
      <h2 className="text-lg font-semibold text-gray-800">{viewTitles[view]}</h2>
    </header>
  )
}
