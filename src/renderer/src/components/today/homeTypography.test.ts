import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// 홈 블록 파일의 최소 글자 크기 (홈 개편 설계 3절, 완료 조건 8).
// 홈 블록은 text-[11px]·text-[10px] 를 쓰지 않는다. 이유: 작은 글자가 가독성을 떨어뜨린다.
// 공용 ui/index.tsx·tokens.ts 는 다른 화면도 쓰므로 대상에서 뺀다

const COMPONENTS = resolve(__dirname, '..')

const HOME_BLOCK_FILES = [
  'today/TodayView.tsx',
  'today/DayHeader.tsx',
  'today/SummaryTiles.tsx',
  'today/Timeline.tsx',
  'today/PlanItemRow.tsx',
  'today/InboxSection.tsx',
  'today/BriefingCard.tsx',
  'today/MeetingBriefingCard.tsx',
  'today/RecoveryCard.tsx',
  'today/ChangeLog.tsx',
  'dashboard/HomeOverview.tsx',
  'dashboard/HomeSchedule.tsx',
  'dashboard/TodaySchedule.tsx'
]

const TINY_TEXT = /text-\[1[01]px\]/

describe('홈 블록 타이포그래피', () => {
  it('대상 파일은 13개다', () => {
    expect(HOME_BLOCK_FILES).toHaveLength(13)
  })

  it.each(HOME_BLOCK_FILES)('%s 에 text-[11px]·text-[10px] 가 없다', (file) => {
    const lines = readFileSync(resolve(COMPONENTS, file), 'utf8').split('\n')
    const hits = lines
      .map((line, i) => `${i + 1}: ${line.trim()}`)
      .filter((_, i) => TINY_TEXT.test(lines[i]))
    expect(hits).toEqual([])
  })
})
