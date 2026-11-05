import { useProjectStore } from '../../stores/projectStore'
import { VIEW_LABELS } from './navConfig'

export default function Header(): React.ReactNode {
  const { view } = useProjectStore()

  return (
    <header className="h-14 bg-white border-b border-gray-200 flex items-center px-6">
      <h2 className="text-lg font-semibold text-gray-800">{VIEW_LABELS[view]}</h2>
    </header>
  )
}
