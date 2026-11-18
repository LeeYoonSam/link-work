import { useEffect } from 'react'
import { useNavigationStore, type ProjectsTab } from '../../stores/navigationStore'
import { useMorningSyncStore } from '../../stores/morningSyncStore'
import { useJiraBoardStore } from '../../stores/jiraBoardStore'
import ReleasesView from '../release/ReleasesView'
import ProjectBoardView from './ProjectBoardView'
import DocsTab from './DocsTab'

export const PROJECT_TABS: { id: ProjectsTab; label: string }[] = [
  { id: 'tickets', label: '티켓' },
  { id: 'releases', label: '릴리스' },
  { id: 'docs', label: '문서' }
]

/** APG 탭 패턴: ←/→ 는 순환 이동, Home/End 는 처음·끝. 다루지 않는 키는 null */
export function nextTabId(current: ProjectsTab, key: string): ProjectsTab | null {
  const n = PROJECT_TABS.length
  const i = Math.max(0, PROJECT_TABS.findIndex((x) => x.id === current))
  switch (key) {
    case 'ArrowRight':
      return PROJECT_TABS[(i + 1) % n].id
    case 'ArrowLeft':
      return PROJECT_TABS[(i + n - 1) % n].id
    case 'Home':
      return PROJECT_TABS[0].id
    case 'End':
      return PROJECT_TABS[n - 1].id
    default:
      return null
  }
}

/** 릴리스 탭이 열려 있고 안 본 새 릴리스가 있으면 본 것으로 표시한다(사이드바 진입만으로는 지우지 않는다) */
export function shouldMarkReleasesSeen(tab: ProjectsTab, unseen: number): boolean {
  return tab === 'releases' && unseen > 0
}

/**
 * 프로젝트 페이지: 티켓(Jira 계층 보드) / 릴리스 / 문서 탭.
 * 선택한 탭만 마운트한다. 탭 상태는 navigationStore 에 있어 내부 링크가 탭까지 정할 수 있다.
 */
export default function ProjectsPage(): React.ReactNode {
  const tab = useNavigationStore((s) => s.projectsTab)
  const setTab = useNavigationStore((s) => s.setProjectsTab)
  const unseenRelease = useMorningSyncStore((s) => s.unseenCount('release'))
  const markSeen = useMorningSyncStore((s) => s.markSeen)

  // 릴리스 탭부터 열어도 "보드에서 보기"·문서 탭이 쓸 보드 스냅샷(저장본)을 올려 둔다
  useEffect(() => {
    void useJiraBoardStore.getState().load()
  }, [])

  useEffect(() => {
    if (shouldMarkReleasesSeen(tab, unseenRelease)) markSeen('release')
  }, [tab, unseenRelease, markSeen])

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="프로젝트" className="flex items-end gap-1 border-b border-gray-200">
        {PROJECT_TABS.map((t) => {
          const active = t.id === tab
          const badge = t.id === 'releases' ? unseenRelease : 0
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`projects-tab-${t.id}`}
              aria-selected={active}
              // 선택한 탭만 마운트하므로 패널이 있는 활성 탭만 가리킨다
              aria-controls={active ? `projects-panel-${t.id}` : undefined}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                const next = nextTabId(tab, e.key)
                if (!next) return
                e.preventDefault()
                setTab(next)
                document.getElementById(`projects-tab-${next}`)?.focus()
              }}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
                active
                  ? 'border-blue-600 font-medium text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
              {badge > 0 ? (
                <span
                  aria-label={`새 릴리스 ${badge}건`}
                  className="min-w-[1.25rem] rounded-full bg-blue-500 px-1.5 text-center text-[11px] leading-5 text-white tabular-nums"
                >
                  {badge}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
      <div role="tabpanel" id={`projects-panel-${tab}`} aria-labelledby={`projects-tab-${tab}`}>
        {tab === 'releases' ? <ReleasesView /> : tab === 'docs' ? <DocsTab /> : <ProjectBoardView />}
      </div>
    </div>
  )
}
