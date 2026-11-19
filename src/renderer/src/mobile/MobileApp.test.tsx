import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { collect, click, findButton } from '../components/today/testTree'
import { createMobileApi } from './api'
import { connectionAfterError } from './mobileModel'
import { EXPIRED_TEXT, MobileFrame, OFFLINE_TEXT } from './MobileApp'

const noop = (): void => {}

describe('MobileFrame', () => {
  it('401 응답이면 화면 전체가 재스캔 안내로 바뀐다', async () => {
    const api = createMobileApi(async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }))
    const err = await api.getToday().catch((e: unknown) => e)
    const connection = connectionAfterError('online', err)
    expect(connection).toBe('expired')
    const html = renderToStaticMarkup(
      <MobileFrame connection={connection} tab="today" onTab={noop} onRetry={noop}>
        <p>마지막 내용</p>
      </MobileFrame>
    )
    expect(html).toContain('연결이 만료되었어요')
    expect(html).toContain(EXPIRED_TEXT)
    expect(html).toContain('Mac 의 LinkWork 설정 → 모바일에서 QR 을 다시 스캔하세요')
    // 탭·본문은 보이지 않는다
    expect(html).not.toContain('마지막 내용')
    expect(html).not.toContain('<nav')
  })

  it('네트워크 실패면 배너 + 다시 시도, 마지막 내용은 계속 보인다', async () => {
    const api = createMobileApi(async () => {
      throw new TypeError('Failed to fetch')
    })
    const err = await api.getMemos().catch((e: unknown) => e)
    const connection = connectionAfterError('online', err)
    expect(connection).toBe('offline')
    const onRetry = vi.fn()
    const tree = MobileFrame({ connection, tab: 'memos', onTab: noop, onRetry, children: <p>마지막 내용</p> })
    const html = renderToStaticMarkup(tree)
    expect(html).toContain(OFFLINE_TEXT)
    expect(html).toContain('마지막 내용')
    click(findButton(tree, '다시 시도'))
    expect(onRetry).toHaveBeenCalled()
  })

  it('하단 탭 3개, 현재 탭 표시, 누르면 onTab', () => {
    const onTab = vi.fn()
    const tree = MobileFrame({ connection: 'online', tab: 'todos', onTab, onRetry: noop, children: null })
    const links = collect(tree).filter((e) => e.type === 'a')
    expect(links.map((a) => a.props.href)).toEqual(['#today', '#todos', '#memos'])
    expect(links[1].props['aria-current']).toBe('page')
    click(links[2])
    expect(onTab).toHaveBeenCalledWith('memos')
  })
})
