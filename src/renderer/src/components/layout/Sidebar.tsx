import { useNavigationStore } from '../../stores/navigationStore'
import { formatElapsed, useRecorderStore } from '../../stores/recorderStore'
import { useMorningSyncStore, type MorningSyncPartName } from '../../stores/morningSyncStore'
import MenuIcon from '../icons/MenuIcon'
import { NAV_FOOTER, NAV_GROUPS, type ViewId } from './navConfig'

// 아침 자동 동기화의 새 항목 배지를 다는 메뉴다. 릴리스는 프로젝트 페이지의 탭이라 프로젝트 메뉴에 단다.
// 본 것으로 치는 처리는 여기서 하지 않는다. 릴리스 탭이 열릴 때 한다(티켓 탭만 봐도 지워지면 안 된다)
const MORNING_BADGE_PART: Partial<Record<ViewId, MorningSyncPartName>> = {
  projects: 'release'
}

export default function Sidebar(): React.ReactNode {
  const { view, setView } = useNavigationStore()
  const recorderState = useRecorderStore((s) => s.state)
  // 초 단위로만 구독해 리렌더를 1초에 한 번으로 제한
  const elapsedSec = useRecorderStore((s) => Math.floor(s.elapsedMs / 1000))
  const isRecording = recorderState === 'recording' || recorderState === 'paused'
  const unseenRelease = useMorningSyncStore((s) => s.unseenCount('release'))

  const unseen: Record<MorningSyncPartName, number> = {
    release: unseenRelease
  }

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
                  onClick={() => setView(item.id)}
                  className={`w-full text-left px-4 py-2.5 flex items-center gap-3 text-sm transition-colors ${
                    view === item.id
                      ? 'bg-gray-700 text-white'
                      : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                  }`}
                >
                  <MenuIcon name={item.icon} size={18} dimmed={view !== item.id} />
                  {item.label}
                  {badge > 0 ? (
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

      {/* 하루에 몇 번 쓰지 않는 화면이라 nav 목록에 섞지 않고 하단에 따로 둔다 */}
      <div className="mt-auto border-t border-gray-700">
        {NAV_FOOTER.map((item) => (
          <button
            key={item.id}
            onClick={() => setView(item.id)}
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
      </div>
    </aside>
  )
}
