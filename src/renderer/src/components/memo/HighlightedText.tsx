import { toSegments, type Range } from './memoSearch'

// 검색 일치 하이라이트. 노랑은 검색 일치 전용 뜻이다.
// <mark> 라서 보조기술에도 강조로 전달되고, 색 외에 굵기로도 구분한다
export const MARK_CLASS = 'bg-yellow-100 text-gray-900 font-semibold rounded-sm px-0.5'

export default function HighlightedText({
  text,
  ranges
}: {
  text: string
  ranges: Range[]
}): React.ReactNode {
  if (ranges.length === 0) return text
  return toSegments(text, ranges).map((seg, i) =>
    seg.hit ? (
      <mark key={i} className={MARK_CLASS}>
        {seg.text}
      </mark>
    ) : (
      <span key={i}>{seg.text}</span>
    )
  )
}
