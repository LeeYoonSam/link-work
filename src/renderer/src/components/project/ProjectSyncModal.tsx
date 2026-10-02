import { useEffect, useState } from 'react'
import { isExistingItem, useProjectSyncStore } from '../../stores/projectSyncStore'
import type {
  JiraConnectionStatus,
  ProjectSyncPlanItem,
  ProjectSyncResult,
  ProjectSyncSkipped
} from '../../types'
import { Badge, EmptyState, XIcon, button, typo } from '../ui'
import JiraSettingsModal from './JiraSettingsModal'
import JiraTokenWarning from './JiraTokenWarning'

// 업데이트 항목이 어떤 근거로 기존 프로젝트에 붙었는지. 이름 매칭은 오매칭 여지가 있어
// 사용자가 적용 전에 눈으로 확인할 수 있어야 한다.
const MATCHED_BY_LABEL: Record<NonNullable<ProjectSyncPlanItem['matchedBy']>, string> = {
  jira_key: 'Jira 키로 연결됨',
  document_url: '문서 링크로 매칭',
  name: '이름으로 매칭'
}

export function skipReasonLabel(s: ProjectSyncSkipped): string {
  switch (s.reason) {
    case 'qa':
      return 'QA 티켓 제외'
    case 'no_epic':
      return '에픽 없음'
    case 'tracked_in_project':
      return s.detail ? `이미 '${s.detail}' 프로젝트에서 추적 중` : '이미 다른 프로젝트에서 추적 중'
  }
}

function PlanItemRow({
  item,
  checked,
  disabled,
  onToggle
}: {
  item: ProjectSyncPlanItem
  checked: boolean
  disabled: boolean
  onToggle: () => void
}): React.ReactNode {
  const existing = isExistingItem(item)
  const counts = [
    { label: '작업 추가', n: item.newTasks },
    { label: '작업 갱신', n: item.updatedTasks },
    { label: '문서 추가', n: item.newDocuments }
  ]
  return (
    <li className="py-2">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={disabled}
          aria-label={`${item.jiraKey} 선택`}
          className="mt-0.5 w-4 h-4 accent-blue-600 shrink-0"
        />
        {/* 기존 프로젝트는 고르기 전까지 흐리게 둔다 — 기본은 손대지 않는 대상이다 */}
        <div className={`min-w-0 flex-1 ${existing && !checked ? 'opacity-60' : ''}`}>
          <div className="flex items-center gap-2 min-w-0">
            <Badge color="bg-slate-100 text-slate-700" size="xs">
              {item.jiraKey}
            </Badge>
            {item.kind === 'sustain' && (
              <Badge color="bg-amber-100 text-amber-700" size="xs">
                Sustain
              </Badge>
            )}
            <span className="min-w-0 truncate text-sm text-gray-900">{item.projectName}</span>
            {item.matchedBy && (
              <span className="shrink-0 text-[11px] text-gray-400">
                {MATCHED_BY_LABEL[item.matchedBy]}
              </span>
            )}
            {existing && checked && (
              <Badge color="bg-red-100 text-red-700" size="xs">
                강제 업데이트
              </Badge>
            )}
          </div>
          {existing && (
            <p className="mt-0.5 text-xs text-amber-700">이미 추가된 프로젝트입니다</p>
          )}
          {/* 이름이 다르면 Jira 쪽 요약을 함께 보여 매칭이 맞는지 확인하게 한다 */}
          {item.projectName !== item.summary && (
            <p className="mt-0.5 text-xs text-gray-500 truncate">Jira: {item.summary}</p>
          )}
          <div className="mt-1 flex gap-3 text-xs">
            {counts.map(({ label, n }) => (
              <span key={label} className={n > 0 ? 'text-gray-700' : 'text-gray-300'}>
                {label} {n}
              </span>
            ))}
          </div>
        </div>
      </label>
    </li>
  )
}

// 기존 프로젝트를 고를 때만 뜨는 덮어쓰기 확인. 기존 삭제 확인(MeetingDetail)과 같은 인앱 팝업 형태다.
// 무엇이 바뀌고 무엇이 남는지 적어 둬야 "수동으로 정리한 내용이 날아갔다"는 오해가 없다.
export function ForceConfirmDialog({
  item,
  onConfirm,
  onCancel
}: {
  item: ProjectSyncPlanItem
  onConfirm: () => void
  onCancel: () => void
}): React.ReactNode {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30"
      onClick={(e) => {
        e.stopPropagation()
        onCancel()
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="project-sync-force-title"
        className="bg-white rounded-xl shadow-xl p-6 w-96 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p id="project-sync-force-title" className="text-sm font-semibold text-gray-800">
          기존 프로젝트 덮어쓰기
        </p>
        <div className="space-y-2 text-sm text-gray-600">
          <p>
            <span className="font-medium">&quot;{item.projectName}&quot;</span>은(는) 이미 있는
            프로젝트입니다. 선택하면 Jira 내용으로 덮어씌워집니다.
          </p>
          <ul className="list-disc pl-5 space-y-1 text-xs">
            <li>
              바뀌는 것: 프로젝트 이름·설명, 연결된 작업의 이름·상태·마감일 (Jira 값으로)
            </li>
            <li>유지되는 것: 프로젝트 일정·우선순위, Jira에 없는 수동 작업·문서</li>
          </ul>
          {item.forceChanges > 0 && (
            <p className="text-xs font-medium text-red-600">덮어써질 항목 {item.forceChanges}건</p>
          )}
          {/* 어떤 작업이 바뀌는지 직접 보여야 확인이 의미가 있다. 이름이 같으면 상태·마감일만 바뀐다 */}
          {item.forceTasks.length > 0 && (
            <div>
              <div className={`${typo.microLabel} mb-1`}>
                덮어써질 작업 ({item.forceTasks.length})
              </div>
              <ul className="max-h-40 overflow-auto rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 space-y-1 text-xs">
                {item.forceTasks.map((t, i) => (
                  <li key={i} className="break-all">
                    {t.before === t.after ? (
                      <>
                        {t.before} <span className="text-gray-400">(상태·마감일)</span>
                      </>
                    ) : (
                      <>
                        <span className="text-gray-400 line-through">{t.before}</span> →{' '}
                        <span className="text-gray-800">{t.after}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
          >
            취소
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
          >
            덮어쓰기 선택
          </button>
        </div>
      </div>
    </div>
  )
}

function SkippedList({ skipped }: { skipped: ProjectSyncSkipped[] }): React.ReactNode {
  if (skipped.length === 0) return null
  return (
    <div>
      <div className={`${typo.microLabel} mb-1`}>건너뜀 ({skipped.length})</div>
      <ul className="space-y-0.5">
        {skipped.map((s) => (
          <li key={`${s.jiraKey}-${s.reason}`} className="text-xs text-gray-500 break-all">
            <span className="font-medium text-gray-600">{s.jiraKey}</span> {s.summary} —{' '}
            {skipReasonLabel(s)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ResultSummary({ result }: { result: ProjectSyncResult }): React.ReactNode {
  const rows = [
    { label: '프로젝트 생성', n: result.created },
    { label: '프로젝트 업데이트', n: result.updated },
    { label: '작업 추가', n: result.tasksAdded },
    { label: '작업 갱신', n: result.tasksUpdated },
    { label: '문서 추가', n: result.documentsAdded }
  ]
  return (
    <div className="space-y-4">
      <p className="text-sm text-green-700">싱크업을 적용했습니다.</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        {rows.map(({ label, n }) => (
          <div key={label} className="flex justify-between">
            <dt className="text-gray-500">{label}</dt>
            <dd className={n > 0 ? 'font-medium text-gray-900' : 'text-gray-300'}>{n}건</dd>
          </div>
        ))}
      </dl>
      <SkippedList skipped={result.skipped} />
    </div>
  )
}

// 프로젝트 목록의 "Jira 싱크업" 모달.
// 미리보기 → 적용 두 단계로만 진행한다. 적용 전에 생성/업데이트될 프로젝트와
// 건너뛴 이슈(사유 포함)를 모두 보여준다 — 조용히 빠진 이슈가 있으면 "왜 안 생겼지"가 된다.
export default function ProjectSyncModal({ onClose }: { onClose: () => void }): React.ReactNode {
  const {
    phase,
    plan,
    result,
    error,
    selectedKeys,
    pendingForceKey,
    preview,
    toggle,
    confirmForce,
    cancelForce,
    setAllNew,
    apply,
    reset
  } = useProjectSyncStore()
  const [jiraStatus, setJiraStatus] = useState<JiraConnectionStatus | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  const applying = phase === 'applying'

  const loadJiraStatus = async (): Promise<void> => {
    try {
      setJiraStatus(await window.api.jira.status())
    } catch {
      setJiraStatus(null)
    }
  }

  useEffect(() => {
    void loadJiraStatus()
    void preview()
    return () => reset()
  }, [])

  // 적용 중에 닫으면 DB 쓰기는 계속되는데 결과를 볼 곳이 사라진다 — 끝날 때까지 막는다
  const close = (): void => {
    if (applying) return
    onClose()
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 덮어쓰기 확인이 떠 있으면 Esc는 그 팝업만 닫는다(=선택 안 함)
      if (pendingForceKey !== null) cancelForce()
      // 연동 설정 모달이 위에 떠 있으면 Esc는 그쪽 몫이다
      else if (!showSettings) close()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [onClose, showSettings, applying, pendingForceKey])

  const items = plan?.items ?? []
  const newItems = items.filter((i) => !isExistingItem(i))
  const existingItems = items.filter(isExistingItem)
  const selectedCount = items.filter((i) => selectedKeys.includes(i.jiraKey)).length
  const allNewSelected =
    newItems.length > 0 && newItems.every((i) => selectedKeys.includes(i.jiraKey))
  const someNewSelected = newItems.some((i) => selectedKeys.includes(i.jiraKey))
  const canApply = phase === 'preview' && selectedCount > 0
  const pendingItem = items.find((i) => i.jiraKey === pendingForceKey) ?? null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-sync-title"
        className="bg-white rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h3 id="project-sync-title" className="text-base font-semibold text-gray-900">
              Jira 싱크업
            </h3>
            <p className="mt-0.5 text-xs text-gray-500">
              내게 할당된 &lsquo;할 일&rsquo; 이슈를 프로젝트·작업·문서로 가져옵니다. Jira에는
              아무것도 쓰지 않습니다.
            </p>
          </div>
          <button
            onClick={close}
            disabled={applying}
            className="p-1 text-gray-400 hover:text-gray-700 transition-colors disabled:opacity-40"
            title="닫기"
            aria-label="닫기"
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4 space-y-4">
          <JiraTokenWarning status={jiraStatus} />

          {(phase === 'idle' || phase === 'loading') && (
            <EmptyState>Jira에서 할 일 이슈를 불러오는 중입니다…</EmptyState>
          )}

          {phase === 'error' && (
            <div className="space-y-3">
              <div
                role="alert"
                className="px-3 py-2 rounded-md border border-red-200 bg-red-50 text-xs text-red-600 break-all"
              >
                {error}
              </div>
              {/* 미연결·기본 프로젝트 미설정이 대부분이라 설정으로 바로 갈 길을 둔다 (Releases 화면과 같은 방식) */}
              <button
                onClick={() => setShowSettings(true)}
                className={`px-3 py-1.5 text-xs ${button.subtle}`}
              >
                Jira 연동 설정
              </button>
            </div>
          )}

          {phase === 'done' && result && <ResultSummary result={result} />}

          {(phase === 'preview' || phase === 'applying') && plan && (
            <>
              {plan.truncated && (
                <div className="px-3 py-2 rounded-md border border-amber-200 bg-amber-50 text-xs text-amber-700">
                  Jira 조회 상한에 걸려 최근 이슈 일부만 가져왔습니다. 오래된 할 일 이슈는 목록에
                  없을 수 있습니다.
                </div>
              )}

              <p className="text-xs text-gray-500">
                Jira에서 내게 할당된 &lsquo;할 일&rsquo; 이슈 {plan.triggerCount}건을 찾았습니다
                (하위 작업 제외).
              </p>

              {items.length === 0 ? (
                <p className="text-sm text-gray-500">
                  {plan.triggerCount === 0
                    ? '동기화할 변경이 없습니다. Jira에 내게 할당된 ‘할 일’ 이슈가 없습니다.'
                    : '동기화할 변경이 없습니다.'}
                </p>
              ) : (
                newItems.length === 0 && (
                  <p className="text-sm text-gray-500">
                    새로 추가할 프로젝트가 없습니다. 기존 프로젝트를 Jira 내용으로 덮어쓰려면
                    선택하세요.
                  </p>
                )
              )}

              {newItems.length > 0 && (
                <section>
                  <div className="flex items-center gap-2 mb-1">
                    {/* 전체 선택은 새 프로젝트에만 — 기존 프로젝트는 하나씩 확인을 거쳐야 한다 */}
                    <input
                      type="checkbox"
                      checked={allNewSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someNewSelected && !allNewSelected
                      }}
                      onChange={() => setAllNew(!allNewSelected)}
                      disabled={applying}
                      aria-label="새 프로젝트 전체 선택"
                      className="w-4 h-4 accent-blue-600"
                    />
                    <Badge color="bg-green-100 text-green-700" size="xs">
                      새 프로젝트
                    </Badge>
                    <span className="text-xs text-gray-400">{newItems.length}건</span>
                  </div>
                  <ul className="divide-y divide-gray-100">
                    {newItems.map((item) => (
                      <PlanItemRow
                        key={item.jiraKey}
                        item={item}
                        checked={selectedKeys.includes(item.jiraKey)}
                        disabled={applying}
                        onToggle={() => toggle(item.jiraKey)}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {existingItems.length > 0 && (
                <section>
                  <div className="flex items-center gap-2 mb-1">
                    <Badge color="bg-gray-100 text-gray-600" size="xs">
                      이미 있는 프로젝트
                    </Badge>
                    <span className="text-xs text-gray-400">{existingItems.length}건</span>
                  </div>
                  <ul className="divide-y divide-gray-100">
                    {existingItems.map((item) => (
                      <PlanItemRow
                        key={item.jiraKey}
                        item={item}
                        checked={selectedKeys.includes(item.jiraKey)}
                        disabled={applying}
                        onToggle={() => toggle(item.jiraKey)}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {items.length === 0 && plan.skipped.length === 0 && (
                <p className="text-xs text-gray-500">Jira에 내게 할당된 할 일 이슈가 없습니다.</p>
              )}

              <SkippedList skipped={plan.skipped} />
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-200">
          {phase === 'error' && (
            <button
              onClick={() => void preview()}
              className={`px-4 py-2 text-sm ${button.subtle}`}
            >
              다시 시도
            </button>
          )}
          <button
            onClick={close}
            disabled={applying}
            className={`px-4 py-2 text-sm disabled:opacity-40 ${button.subtle}`}
          >
            닫기
          </button>
          {(phase === 'preview' || phase === 'applying') && (
            <button
              onClick={() => void apply()}
              disabled={!canApply}
              aria-label="싱크업 적용"
              title={selectedCount === 0 ? '적용할 항목을 선택하세요' : undefined}
              className={`px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed ${button.primary}`}
            >
              {applying ? '적용 중…' : `적용 (선택 ${selectedCount}건)`}
            </button>
          )}
        </div>
      </div>

      {pendingItem && (
        <ForceConfirmDialog item={pendingItem} onConfirm={confirmForce} onCancel={cancelForce} />
      )}

      {showSettings && (
        // 바깥 오버레이 클릭으로 싱크업 모달까지 닫히지 않도록 전파를 끊는다
        <div onClick={(e) => e.stopPropagation()}>
          <JiraSettingsModal
            status={jiraStatus}
            onClose={() => setShowSettings(false)}
            onChanged={() => {
              void loadJiraStatus()
              void preview()
            }}
          />
        </div>
      )}
    </div>
  )
}
