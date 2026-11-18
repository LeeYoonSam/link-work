import { useState } from 'react'
import type { SyncAllResult } from '../../types'
import { ChevronDownIcon, IconButton, XIcon, typo } from '../ui'

// 전체 동기화 결과 요약.
// 성공·이슈 보류·오류가 한 번에 섞여 나오므로 토스트 한 줄로 뭉뚱그리지 않는다.
// 특히 이슈 보류를 감추면 "가져왔는데 왜 내용이 비었지" 상태로 방치된다.
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
    { label: '이슈 보류', n: result.metaOnly.length, tone: 'text-blue-700' },
    { label: '오류', n: result.failed.length, tone: 'text-red-600' }
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
                  <li key={s.noteId} className="text-xs text-gray-700">
                    {s.version} · 이슈 {s.itemCount}건
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 상한에 걸려 이슈를 안 받은 릴리스 — 빈 릴리스로 오해하지 않도록 이유를 밝힌다 */}
          {result.metaOnly.length > 0 && (
            <div>
              <div className={`${typo.microLabel} mb-1`}>릴리스만 가져옴 (이슈는 아직)</div>
              <ul className="space-y-0.5">
                {result.metaOnly.map((m) => (
                  <li key={m.noteId} className="text-xs text-blue-700">
                    {m.version}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-gray-500">
                한 번에 버전이 높은 것부터만 이슈를 받습니다. 목록에서 해당 릴리스의 동기화 버튼을
                누르면 이슈를 가져옵니다.
              </p>
            </div>
          )}

          {result.failed.length > 0 && (
            <div>
              <div className={`${typo.microLabel} mb-1`}>실패</div>
              <ul className="space-y-0.5">
                {result.failed.map((f) => (
                  <li key={f.version} className="text-xs text-red-600 break-all">
                    {f.version} — {f.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.synced.length === 0 &&
            result.metaOnly.length === 0 &&
            result.failed.length === 0 && (
              <p className="text-xs text-gray-500">Jira에서 가져올 릴리스가 없었습니다.</p>
            )}
        </div>
      )}
    </div>
  )
}
