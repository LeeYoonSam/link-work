import type { BoardTile, BoardTileKey } from './boardModel'

// 타일마다 뜻에 맞는 색 1개. 진행(파랑) · 리뷰QA(남색) · 할 일(앰버, 상태 배지와 같은 뜻) · 완료(초록).
// 빨강은 마감 지남 글자에만 쓴다
const TONE: Record<BoardTileKey, { box: string; label: string; value: string }> = {
  progress: { box: 'bg-blue-50 border-blue-200', label: 'text-blue-700', value: 'text-blue-900' },
  review: { box: 'bg-indigo-50 border-indigo-200', label: 'text-indigo-700', value: 'text-indigo-900' },
  todo: { box: 'bg-amber-50 border-amber-200', label: 'text-amber-700', value: 'text-amber-900' },
  done: { box: 'bg-green-50 border-green-200', label: 'text-green-700', value: 'text-green-900' }
}

export default function BoardSummaryTiles({ tiles }: { tiles: BoardTile[] }): React.ReactNode {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="티켓 요약">
      {tiles.map((t) => (
        <div key={t.key} data-tile={t.key} className={`rounded-lg border p-4 ${TONE[t.key].box}`}>
          <p className={`text-sm ${TONE[t.key].label}`}>{t.label}</p>
          <p className={`mt-1 text-2xl font-bold tabular-nums ${TONE[t.key].value}`}>{t.value}</p>
          {t.sub || t.alert ? (
            <p className="mt-1 text-sm text-gray-600 break-words">
              {t.sub && t.alert ? `${t.sub} · ` : t.sub}
              {t.alert ? <span className="text-red-600 font-medium">{t.alert}</span> : null}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  )
}
