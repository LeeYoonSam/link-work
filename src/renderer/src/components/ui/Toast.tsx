// 토스트 표시. App 에 한 번 마운트한다. 화면 아래 가운데에 쌓인다.
import { dismissToast, useToastStore } from './toastStore'

export function ToastHost(): React.ReactNode {
  const toasts = useToastStore((s) => s.toasts)
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex max-w-[min(480px,100%)] items-center gap-3 rounded-lg bg-gray-900 px-4 py-2.5 text-sm text-white shadow-lg"
        >
          <span className="min-w-0 flex-1 break-keep [overflow-wrap:anywhere]">{t.message}</span>
          {t.actionLabel ? (
            <button
              type="button"
              onClick={() => dismissToast(t.id, 'action')}
              className="shrink-0 rounded px-1.5 py-0.5 text-sm font-semibold text-blue-300 hover:bg-white/10 hover:text-blue-200"
            >
              {t.actionLabel}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="알림 닫기"
            onClick={() => dismissToast(t.id, 'expire')}
            className="shrink-0 rounded px-1 text-gray-400 hover:bg-white/10 hover:text-white"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
