import { useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { formatElapsed, useRecorderStore } from '../../stores/recorderStore'
import MenuIcon, { MenuIconName } from '../icons/MenuIcon'
import { ArchiveIcon } from '../ui'
import BackupModal from './BackupModal'

const navItems = [
  { id: 'dashboard' as const, label: 'Dashboard', icon: 'dashboard' as MenuIconName },
  { id: 'projects' as const, label: 'Projects', icon: 'projects' as MenuIconName },
  { id: 'todos' as const, label: 'TODO', icon: 'todos' as MenuIconName },
  { id: 'documents' as const, label: 'Documents', icon: 'documents' as MenuIconName },
  { id: 'variables' as const, label: 'Variables', icon: 'variables' as MenuIconName },
  { id: 'memos' as const, label: 'Memos', icon: 'memos' as MenuIconName },
  { id: 'calendar' as const, label: 'Calendar', icon: 'calendar' as MenuIconName },
  { id: 'recordings' as const, label: '녹음', icon: 'recordings' as MenuIconName },
  { id: 'releases' as const, label: 'Releases', icon: 'releases' as MenuIconName },
  { id: 'reports' as const, label: 'Reports', icon: 'reports' as MenuIconName },
  { id: 'ai' as const, label: 'AI 대화', icon: 'ai' as MenuIconName }
]

export default function Sidebar(): React.ReactNode {
  const { view, setView, setProjectView } = useProjectStore()
  const recorderState = useRecorderStore((s) => s.state)
  // 초 단위로만 구독해 리렌더를 1초에 한 번으로 제한
  const elapsedSec = useRecorderStore((s) => Math.floor(s.elapsedMs / 1000))
  const isRecording = recorderState === 'recording' || recorderState === 'paused'
  const [backupOpen, setBackupOpen] = useState(false)

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
            {item.id === 'recordings' && isRecording && (
              <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-red-400 tabular-nums">
                <span
                  className={`w-1.5 h-1.5 rounded-full bg-red-500 ${
                    recorderState === 'recording' ? 'animate-pulse' : ''
                  }`}
                />
                {formatElapsed(elapsedSec * 1000)}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* 하루에 한 번 쓸 일도 없는 기능이라 nav 목록에 섞지 않고 하단에 따로 둔다 */}
      <div className="mt-auto border-t border-gray-700">
        <button
          onClick={() => setBackupOpen(true)}
          className="w-full text-left px-4 py-3 flex items-center gap-3 text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition-colors"
        >
          <ArchiveIcon size={18} className="shrink-0" />
          데이터 백업 · 복원
        </button>
      </div>

      {backupOpen && <BackupModal onClose={() => setBackupOpen(false)} />}
    </aside>
  )
}
