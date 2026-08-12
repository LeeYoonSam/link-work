import { describe, it, expect } from 'vitest'
import { placeTooltip, TOOLTIP_MARGIN } from './tooltipPosition'

// 툴팁이 overflow 조상에 잘리던 문제를 portal + fixed로 고치면서 좌표 계산이 새로 생겼다.
// 실제로 뒤집기 판정이 깨진 적이 있어 경계를 단위 테스트로 고정한다.

const tip = { width: 200, height: 44 }
const VIEWPORT = { width: 1000, height: 800 }

describe('placeTooltip', () => {
  it('위 공간이 충분하면 트리거 위에 놓는다', () => {
    const p = placeTooltip({ top: 300, bottom: 320, left: 100 }, tip, VIEWPORT)
    expect(p.below).toBe(false)
    // height에 투명 다리가 포함돼 있으므로 간격을 더하지 않는다
    expect(p.top).toBe(300 - 44)
    expect(p.left).toBe(100)
  })

  it('위 공간이 모자라면 트리거 아래로 뒤집는다', () => {
    const p = placeTooltip({ top: 20, bottom: 40, left: 100 }, tip, VIEWPORT)
    expect(p.below).toBe(true)
    expect(p.top).toBe(40)
  })

  it('뒤집기 경계는 여백만큼이다', () => {
    // top - height === margin → 위에 딱 들어간다
    const fits = placeTooltip({ top: 44 + TOOLTIP_MARGIN, bottom: 80, left: 0 }, tip, VIEWPORT)
    expect(fits.below).toBe(false)

    // 1px만 모자라도 아래로 간다
    const flips = placeTooltip({ top: 44 + TOOLTIP_MARGIN - 1, bottom: 80, left: 0 }, tip, VIEWPORT)
    expect(flips.below).toBe(true)
  })

  it('오른쪽으로 넘치면 뷰포트 안으로 당긴다', () => {
    const p = placeTooltip({ top: 300, bottom: 320, left: 950 }, tip, VIEWPORT)
    expect(p.left).toBe(VIEWPORT.width - 200 - TOOLTIP_MARGIN)
  })

  it('왼쪽 여백보다 안쪽으로 들어가지 않는다', () => {
    const p = placeTooltip({ top: 300, bottom: 320, left: -50 }, tip, VIEWPORT)
    expect(p.left).toBe(TOOLTIP_MARGIN)
  })

  it('말풍선이 뷰포트보다 넓으면 왼쪽 여백에 붙인다', () => {
    const wide = { width: 1200, height: 44 }
    const p = placeTooltip({ top: 300, bottom: 320, left: 100 }, wide, VIEWPORT)
    expect(p.left).toBe(TOOLTIP_MARGIN)
  })

  it('화면 최상단 트리거도 좌표가 뷰포트 안에 남는다', () => {
    const p = placeTooltip({ top: 0, bottom: 20, left: 0 }, tip, VIEWPORT)
    expect(p.below).toBe(true)
    expect(p.top).toBe(20)
    expect(p.left).toBe(TOOLTIP_MARGIN)
  })

  // 아래로 뒤집은 뒤 하단이 잘리던 경우. 가로만 clamp하던 시절의 빈틈이다.
  it('아래로 뒤집었을 때 하단이 넘치면 위로 당긴다', () => {
    // 트리거가 화면 맨 아래에 있고 위에도 공간이 없어 아래로 뒤집히는 상황
    const p = placeTooltip({ top: 4, bottom: 790, left: 100 }, tip, VIEWPORT)
    expect(p.below).toBe(true)
    expect(p.top).toBe(VIEWPORT.height - tip.height - TOOLTIP_MARGIN)
    expect(p.top + tip.height).toBeLessThanOrEqual(VIEWPORT.height - TOOLTIP_MARGIN)
  })

  it('말풍선이 뷰포트보다 높으면 위쪽 여백에 붙인다', () => {
    const tall = { width: 200, height: 900 }
    const p = placeTooltip({ top: 400, bottom: 420, left: 100 }, tall, VIEWPORT)
    expect(p.top).toBe(TOOLTIP_MARGIN)
  })

  it('위로 배치한 경우에도 좌표가 여백 아래로 내려가지 않는다', () => {
    const p = placeTooltip({ top: 300, bottom: 320, left: 100 }, tip, VIEWPORT)
    expect(p.top).toBeGreaterThanOrEqual(TOOLTIP_MARGIN)
  })
})
