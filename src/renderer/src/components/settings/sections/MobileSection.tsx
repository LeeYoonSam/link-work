import { useEffect, useState } from 'react'
import type { MobileAddress, MobileServerStatus } from '../../../mobile/contract'
import { useMobileStore } from '../../../stores/mobileStore'
import { Card, button } from '../../ui'

// 설정 > 모바일. 같은 Wi-Fi 의 휴대폰 브라우저로 오늘·할 일·메모를 보는 서버를 켜고 끈다 (docs/MOBILE_VIEW.md).
// 켜고 끄기·QR 재발급은 메인이 처리하고, 결과 상태(MobileServerStatus)를 그대로 그린다.

export const REGENERATE_CONFIRM =
  'QR 을 다시 만들면 이미 연결한 휴대폰은 접속이 끊기고 새 QR 을 다시 스캔해야 합니다. 계속할까요?'

const COPIED_FLASH_MS = 1500
/** 섹션이 보이는 동안 서버 상태를 다시 읽는 간격. Wi-Fi 가 바뀌면 QR·주소가 바뀐다 */
export const STATUS_REFRESH_MS = 10_000

export interface StatusPollingDeps {
  /** 처리 중(켜기·끄기·재발급)이면 true. 그때는 재조회를 생략한다 */
  isBusy: () => boolean
  refresh: () => void
  /** 창 focus 구독. 해제 함수를 돌려준다 */
  onFocus: (cb: () => void) => () => void
  intervalMs?: number
}

/** 창 focus 때와 일정 간격으로 상태를 다시 읽는다. 해제 함수를 돌려준다 */
export function startStatusPolling(deps: StatusPollingDeps): () => void {
  const tick = (): void => {
    if (!deps.isBusy()) deps.refresh()
  }
  const timer = setInterval(tick, deps.intervalMs ?? STATUS_REFRESH_MS)
  const unsubFocus = deps.onFocus(tick)
  return () => {
    clearInterval(timer)
    unsubFocus()
  }
}

/** 접속 주소의 토큰(t=…)을 가린다. 화면에는 토큰 원문을 텍스트로 보이지 않는다 */
export function maskPairUrl(url: string): string {
  return url.replace(/([?&]t=)[^&#]*/g, '$1••••••')
}

/** 확인을 받은 뒤에만 재발급한다. 취소하면 false */
export async function confirmAndRegenerate(
  confirmFn: (message: string) => boolean,
  regenerate: () => Promise<void>
): Promise<boolean> {
  if (!confirmFn(REGENERATE_CONFIRM)) return false
  await regenerate()
  return true
}

export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'

/**
 * 휴대폰이 열 수 있는 주소 목록. 옛 상태(addresses 가 없는 응답)는 pairUrl·qrDataUrl 로 같은 네트워크 주소 1개를 만든다
 */
export function statusAddresses(status: MobileServerStatus | null): MobileAddress[] {
  if (!status) return []
  const list = Array.isArray(status.addresses) ? status.addresses : []
  if (list.length > 0) return list
  if (status.pairUrl && status.qrDataUrl) {
    let ip = ''
    try {
      ip = new URL(status.pairUrl).hostname
    } catch {
      // 주소를 해석하지 못해도 QR 은 보인다
    }
    return [{ kind: 'lan', iface: '', ip, pairUrl: status.pairUrl, qrDataUrl: status.qrDataUrl }]
  }
  return []
}

/** 주소 선택의 식별 키. 토큰이 든 pairUrl 은 쓰지 않는다 */
export function addressKey(a: MobileAddress): string {
  return `${a.kind}|${a.iface}|${a.ip}`
}

/** 고른 주소. 없거나 사라졌으면 첫 주소, 주소가 없으면 null */
export function resolveSelectedAddress(addresses: MobileAddress[], selectedKey: string | null): MobileAddress | null {
  if (addresses.length === 0) return null
  return addresses.find((a) => addressKey(a) === selectedKey) ?? addresses[0]
}

/** 선택 버튼 이름. 같은 종류가 2개 이상이면 인터페이스·IP 로 구분한다 */
export function addressLabel(a: MobileAddress, addresses: MobileAddress[]): string {
  const sameKind = addresses.filter((x) => x.kind === a.kind).length
  const detail = [a.iface, a.ip].filter(Boolean).join(' · ')
  if (a.kind === 'tailscale') return sameKind > 1 && detail ? `어디서나 (Tailscale · ${detail})` : '어디서나 (Tailscale)'
  return sameKind > 1 && detail ? `Wi-Fi·유선 (${detail})` : '같은 네트워크'
}

function TailscaleGuide({ state }: { state: MobileServerStatus['tailscale'] }): React.ReactNode {
  if (state === 'connected') {
    return (
      <p className="text-[11px] text-gray-600" data-tailscale="connected">
        휴대폰에서도 Tailscale 이 켜져 있어야 열려요. 주소가 달라 &quot;어디서나&quot; QR 로 한 번 더 스캔해야 해요
      </p>
    )
  }
  return (
    <details open className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700" data-tailscale={state}>
      <summary className="cursor-pointer font-medium text-gray-800">다른 Wi-Fi·LTE 에서 보기 (Tailscale)</summary>
      {state === 'installed' ? (
        <p className="mt-1.5">
          Tailscale 이 꺼져 있어요. Mac 메뉴 막대의 Tailscale 에서 연결하면 여기에 &quot;어디서나&quot; QR 이 나타나요.
        </p>
      ) : (
        <div className="mt-1.5 space-y-1">
          <p>다른 Wi-Fi 나 LTE 에서도 보려면 Tailscale 이 필요해요</p>
          <ol className="list-decimal space-y-1 pl-4 text-gray-600">
            <li>
              Mac 에 Tailscale 을 설치하고 로그인합니다 —{' '}
              <a href={TAILSCALE_DOWNLOAD_URL} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                tailscale.com/download
              </a>
            </li>
            <li>휴대폰에도 Tailscale 앱을 설치하고 같은 계정으로 로그인합니다</li>
            <li>두 기기에서 Tailscale 을 켠 뒤 이 화면에 &quot;어디서나&quot; QR 이 나타나면 스캔합니다</li>
          </ol>
        </div>
      )}
    </details>
  )
}

export interface MobileSectionViewProps {
  status: MobileServerStatus | null
  loaded: boolean
  busy: boolean
  /** IPC 실패 문구 */
  error: string | null
  copied?: boolean
  /** 고른 주소의 addressKey. null 이면 첫 주소 */
  selectedKey?: string | null
  onSelect?: (key: string) => void
  onToggle: (enabled: boolean) => void
  onRegenerate: () => void
  /** 고른 주소의 전체 pairUrl 을 복사한다 */
  onCopy: (pairUrl: string) => void
}

export function MobileSectionView({
  status,
  loaded,
  busy,
  error,
  copied = false,
  selectedKey = null,
  onSelect = () => {},
  onToggle,
  onRegenerate,
  onCopy
}: MobileSectionViewProps): React.ReactNode {
  const enabled = status?.enabled ?? false
  const running = enabled && (status?.running ?? false)
  const warning = error ?? status?.error ?? null
  const addresses = statusAddresses(status)
  const selected = resolveSelectedAddress(addresses, selectedKey)
  const tailscale = status?.tailscale ?? null

  return (
    <div className="space-y-3">
      <Card padding="sm" className="space-y-2">
        <h4 className="text-sm font-semibold text-gray-900">휴대폰 열람</h4>
        <label className="flex items-start gap-2 py-1.5">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!loaded || busy}
            onChange={(e) => onToggle(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm text-gray-800">
              휴대폰에서 보기 켜기
              {busy ? <span className="ml-2 text-[11px] font-normal text-gray-500">처리 중…</span> : null}
            </span>
            <span className="block text-[11px] text-gray-500">
              휴대폰에서는 오늘 대시보드·할 일·메모를 보고, 할 일 완료·되돌리기와 메모 작성만 할 수 있습니다
            </span>
          </span>
        </label>
        {warning ? <p className="text-xs text-red-600">{warning}</p> : null}
      </Card>

      {running ? (
        <Card padding="sm" className="space-y-3">
          <h4 className="text-sm font-semibold text-gray-900">휴대폰 연결</h4>
          {addresses.length > 1 ? (
            <div role="tablist" aria-label="접속 주소" className="flex flex-wrap gap-1">
              {addresses.map((a) => {
                const key = addressKey(a)
                const active = selected !== null && addressKey(selected) === key
                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-address={key}
                    onClick={() => onSelect(key)}
                    className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                      active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {addressLabel(a, addresses)}
                  </button>
                )
              })}
            </div>
          ) : null}
          {selected ? (
            <>
              <div className="flex flex-wrap items-start gap-4">
                <img
                  src={selected.qrDataUrl}
                  alt="휴대폰 연결 QR"
                  width={176}
                  height={176}
                  className="h-44 w-44 rounded-md border border-gray-200 bg-white p-2"
                />
                <ol className="min-w-0 flex-1 list-decimal space-y-1 pl-4 text-xs text-gray-700">
                  {selected.kind === 'tailscale' ? (
                    <li>휴대폰에서 Tailscale 을 켭니다(이 Mac 과 같은 계정)</li>
                  ) : (
                    <li>휴대폰을 이 Mac 과 같은 Wi-Fi 에 연결합니다</li>
                  )}
                  <li>휴대폰 카메라로 QR 을 스캔해 주소를 엽니다</li>
                  <li>
                    브라우저 메뉴에서 &quot;홈 화면에 추가&quot;를 하면 앱처럼 열 수 있어요. 열었을 때 QR 을 다시
                    스캔하라고 나오면 Safari 책갈피를 쓰세요
                  </li>
                </ol>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 break-all rounded bg-gray-50 px-2 py-1 text-[11px] text-gray-600">
                  {maskPairUrl(selected.pairUrl)}
                </code>
                <button
                  type="button"
                  onClick={() => onCopy(selected.pairUrl)}
                  className={`px-3 py-1.5 text-xs ${button.subtle}`}
                >
                  {copied ? '복사됨' : '주소 복사'}
                </button>
              </div>
            </>
          ) : (
            <p className="text-xs text-amber-700">
              Wi-Fi 주소를 찾지 못했어요. Mac 이 Wi-Fi 에 연결돼 있는지 확인한 뒤 다시 켜 보세요.
            </p>
          )}
          {tailscale ? <TailscaleGuide state={tailscale} /> : null}
          <div>
            <button
              type="button"
              onClick={onRegenerate}
              disabled={busy}
              className={`px-3 py-1.5 text-xs ${button.subtle} disabled:opacity-50`}
            >
              QR 다시 만들기
            </button>
            <span className="ml-2 text-[11px] text-gray-500">이미 연결한 휴대폰은 새 QR 을 다시 스캔해야 합니다</span>
          </div>
        </Card>
      ) : null}

      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-gray-500">
        <li>Mac 이 잠자기 상태이거나 LinkWork 가 꺼져 있으면 휴대폰에서 접속되지 않습니다</li>
        <li>
          같은 네트워크 주소는 암호화되지 않은 HTTP 연결입니다. 카페·공항 같은 공용 Wi-Fi 에서는 켜지 마세요
        </li>
        <li>Tailscale 주소(어디서나)는 기기 사이 구간이 Tailscale 로 암호화됩니다</li>
        <li>처음 켤 때 macOS 가 &quot;들어오는 연결 허용&quot;을 물으면 허용하세요</li>
        <li>회사 Wi-Fi 가 기기 간 통신을 막으면 접속되지 않을 수 있습니다</li>
      </ul>
    </div>
  )
}

export default function MobileSection(): React.ReactNode {
  const status = useMobileStore((s) => s.status)
  const loaded = useMobileStore((s) => s.loaded)
  const busy = useMobileStore((s) => s.busy)
  const error = useMobileStore((s) => s.error)
  const [copied, setCopied] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const addresses = statusAddresses(status)

  // 재조회로 고른 주소가 사라지면 첫 주소로 돌아간다
  const addressKeys = addresses.map(addressKey).join('\n')
  useEffect(() => {
    if (selectedKey !== null && !addressKeys.split('\n').includes(selectedKey)) setSelectedKey(null)
  }, [addressKeys, selectedKey])

  useEffect(() => {
    void useMobileStore.getState().load()
    return startStatusPolling({
      isBusy: () => useMobileStore.getState().busy,
      refresh: () => void useMobileStore.getState().refresh(),
      onFocus: (cb) => {
        window.addEventListener('focus', cb)
        return () => window.removeEventListener('focus', cb)
      }
    })
  }, [])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), COPIED_FLASH_MS)
    return () => clearTimeout(t)
  }, [copied])

  const onCopy = async (url: string): Promise<void> => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // 클립보드를 못 쓰면 아무것도 하지 않는다
    }
  }

  return (
    <MobileSectionView
      status={status}
      loaded={loaded}
      busy={busy}
      error={error}
      copied={copied}
      selectedKey={selectedKey}
      onSelect={(key) => {
        setSelectedKey(key)
        setCopied(false)
      }}
      onToggle={(v) => void useMobileStore.getState().setEnabled(v)}
      onRegenerate={() =>
        void confirmAndRegenerate(
          (m) => window.confirm(m),
          () => useMobileStore.getState().regenerate()
        )
      }
      onCopy={(url) => void onCopy(url)}
    />
  )
}
