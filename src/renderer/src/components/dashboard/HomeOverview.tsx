import { useEffect } from 'react'
import { useMemoStore } from '../../stores/memoStore'
import MarkdownContent from '../memo/MarkdownContent'
import { formatUtcDbTime } from '../../utils/date'
import { SectionTitle, StarIcon } from '../ui'

// 오늘 화면 아래의 중요 메모 구역 (docs/ASSISTANT.md §11.3). 중요 메모만 읽는다.
// 중요 메모가 0건이면 아무것도 그리지 않는다
export function HomeMemos(): React.ReactNode {
  const { importantMemos, fetchImportantMemos } = useMemoStore()

  useEffect(() => {
    fetchImportantMemos().catch(() => undefined)
  }, [])

  if (importantMemos.length === 0) return null
  return (
    <section id="home-overview">
      <SectionTitle variant="page" className="mb-3">
        <span className="inline-flex items-center gap-1.5">
          <StarIcon size={16} filled className="text-amber-400" />
          중요 메모
        </span>
      </SectionTitle>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {importantMemos.map((memo) => (
          <div key={memo.id} className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            {/* 메모 전문을 보인다. 이유: 홈 카드는 말줄임 없이 다 보인다 (사용자 피드백 2026-11-05) */}
            <div className="break-words">
              <MarkdownContent content={memo.content} compact />
            </div>
            {/* 오늘 화면은 ISO 날짜를 보이지 않는다. 그래서 'M/d HH:mm' 으로 줄인다 */}
            <div className="text-xs text-gray-500 mt-2 tabular-nums">
              {formatUtcDbTime(memo.created_at, 'M/d HH:mm')}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
