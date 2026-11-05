import { useEffect, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { formatElapsed, useRecorderStore } from '../../stores/recorderStore'
import { useMorningSyncStore, type MorningSyncPartName } from '../../stores/morningSyncStore'
import MenuIcon from '../icons/MenuIcon'
import { ArchiveIcon } from '../ui'
import BackupModal from './BackupModal'
import { NAV_GROUPS, type ViewId } from './navConfig'

// 아침 자동 동기화의 새 항목 배지를 다는 메뉴다
const MORNING_BADGE_PART: Partial<Record<ViewId, MorningSyncPartName>> = {
  projects: 'project',
  releases: 'release'
}

export default function Sidebar(): React.ReactNode {
  const { view, setView, setProjectView } = useProjectStore()
  const recorderState = useRecorderStore((s) => s.state)
  // 초 단위로만 구독해 리렌더를 1초에 한 번으로 제한
  const elapsedSec = useRecorderStore((s) => Math.floor(s.elapsedMs / 1000))
  const isRecording = recorderState === 'recording' || recorderState === 'paused'
  const unseenProject = useMorningSyncStore((s) => s.unseenCount('project'))
  const unseenRelease = useMorningSyncStore((s) => s.unseenCount('release'))
  const markSeen = useMorningSyncStore((s) => s.markSeen)
  const [backupOpen, setBackupOpen] = useState(false)

  const unseen: Record<MorningSyncPartName, number> = {
    project: unseenProject,
    release: unseenRelease
  }

  // 화면을 열면 새 항목을 본 것으로 친다. 링크·알림으로 열어도 같다
  useEffect(() => {
    const part = MORNING_BADGE_PART[view]
    if (part && unseen[part] > 0) markSeen(part)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, unseenProject, unseenRelease])

  return (
    <aside className="w-56 bg-gray-900 text-white flex flex-col h-screen">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-xl font-bold tracking-tight">LinkWork</h1>
      </div>
      <nav className="flex-1 py-2 overflow-y-auto">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.title ?? `group-${gi}`} className={gi > 0 ? 'mt-2' : undefined}>
            {group.title ? (
              <p className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                {group.title}
              </p>
            ) : null}
            {group.items.map((item) => {
              const part = MORNING_BADGE_PART[item.id]
              const badge = part ? unseen[part] : 0
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setView(item.id)
                    if (item.id === 'projects') setProjectView('list')
                  }}
                  className={`w-full text-left px-4 py-2.5 flex items-center gap-3 text-sm transition-colors ${
                    view === item.id
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                  }`}
                >
                  <MenuIcon name={item.icon} size={18} dimmed={view !== item.id} />
                  {item.label}
                  {badge > 0 && view !== item.id ? (
                    <span
                      className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-blue-500 text-white text-[11px] font-semibold leading-[18px] text-center tabular-nums"
                      title={`아침 자동 동기화로 새 항목 ${badge}개가 생겼어요`}
                    >
                      {badge}
                    </span>
                  ) : null}
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
              )
            })}
          </div>
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
