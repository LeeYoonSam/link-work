import { useState } from 'react'
import type { SyncAllResult } from '../../types'
import { ChevronDownIcon, IconButton, XIcon, typo } from '../ui'

// 전체 동기화 결과 요약.
// 성공·매칭 실패·오류가 한 번에 섞여 나오므로 토스트 한 줄로 뭉뚱그리지 않는다.
// 특히 unmatched를 감추면 "동기화했는데 왜 릴리스가 없지" 상태로 방치된다.
export default function SyncAllSummary({
  result,
  onDismiss
}: {
  result: SyncAllResult
  onDismiss?: () => void
}): React.ReactNode {
  const [open, setOpen] = useState(true)

  const counts = [
    { label: '동기화', n: result.synced.length, tone: 'text-green-700' },
    { label: '매칭 실패', n: result.unmatched.length, tone: 'text-amber-700' },
    { label: '오류', n: result.failed.length, tone: 'text-red-600' },
    { label: '배포 버전 없음', n: result.skipped, tone: 'text-gray-500' }
  ]

  return (
    <div className="mb-4 border border-gray-200 rounded-lg bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          title={open ? '접기' : '펼치기'}
          className="shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
        >
          <ChevronDownIcon size={14} className={open ? '' : '-rotate-90'} />
        </button>
        <span className="text-sm font-medium text-gray-800">전체 동기화 결과</span>
        <div className="flex items-center gap-2 text-xs">
          {counts.map(({ label, n, tone }) => (
            <span key={label} className={n > 0 ? tone : 'text-gray-300'}>
              {label} {n}건
            </span>
          ))}
        </div>
        {onDismiss && (
          <div className="ml-auto shrink-0">
            <IconButton title="요약 닫기" onClick={onDismiss}>
              <XIcon size={14} />
            </IconButton>
          </div>
        )}
      </div>

      {open && (
        <div className="border-t border-gray-100 px-3 py-3 space-y-3">
          {result.synced.length > 0 && (
            <div>
              <div className={`${typo.microLabel} mb-1`}>동기화됨</div>
              <ul className="space-y-0.5">
                {result.synced.map((s) => (
                  <li key={s.projectId} className="text-xs text-gray-700">
                    {s.projectName} — {s.version} · 이슈 {s.itemCount}건
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 어떤 프로젝트의 어떤 버전이 안 맞았는지 반드시 이름으로 보여준다 */}
          {result.unmatched.length > 0 && (
            <div>
              <div className={`${typo.microLabel} mb-1`}>Jira에서 같은 이름의 릴리스를 찾지 못함</div>
              <ul className="space-y-0.5">
                {result.unmatched.map((u) => (
                  <li key={u.projectId} className="text-xs text-amber-700">
                    {u.projectName} ({u.version})
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-gray-500">
                Jira 릴리스 이름이 배포 버전과 정확히 같은지 확인하거나, 프로젝트 상세에서 직접
                연결하세요.
              </p>
            </div>
          )}

          {result.failed.length > 0 && (
            <div>
              <div className={`${typo.microLabel} mb-1`}>실패</div>
              <ul className="space-y-0.5">
                {result.failed.map((f) => (
                  <li key={f.projectId} className="text-xs text-red-600 break-all">
                    {f.projectName} ({f.version}) — {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.skipped > 0 && (
            <p className="text-xs text-gray-500">
              배포 버전이 비어 있어 건너뛴 프로젝트 {result.skipped}개 — 프로젝트 수정에서 배포
              버전을 채우면 다음 전체 동기화에 포함됩니다.
            </p>
          )}

          {result.synced.length === 0 &&
            result.unmatched.length === 0 &&
            result.failed.length === 0 && (
              <p className="text-xs text-gray-500">동기화 대상 프로젝트가 없었습니다.</p>
            )}
        </div>
      )}
    </div>
  )
}
