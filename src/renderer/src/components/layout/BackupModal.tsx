import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import type { BackupManifest, BackupProgress } from '../../types'
import { useBackupStore } from '../../stores/backupStore'
import { useRecorderStore } from '../../stores/recorderStore'
import { AlertTriangleIcon, ProgressBar, XIcon, button, surface, typo } from '../ui'

// 앱 데이터 전체(SQLite + 녹음 파일 + AI 첨부)를 .zip 파일 하나로 내보내고 되돌리는 모달.
// ProjectExportModal의 오버레이/헤더/푸터 구조를 그대로 따른다.

interface BackupModalProps {
  onClose: () => void
  /** 확인 체크가 걸린 백업 경로의 초기값. 테스트에서 체크된 상태를 그려보려고 둔다. */
  initialConfirmedPath?: string | null
}

/**
 * 확인 체크가 지금 고른 백업에 대한 것인지 판정한다.
 *
 * 둘 다 null이면(아무것도 안 골랐고 확인도 없음) 확인된 것이 아니다 — `confirmedPath`가
 * null이 아닐 것을 먼저 요구하는 이유다.
 */
export function isConfirmedFor(confirmedPath: string | null, pickedPath: string | null): boolean {
  return confirmedPath !== null && confirmedPath === pickedPath
}

// 바이트를 사람이 읽는 단위로. GB에서 멈춘다 — 녹음 폴더가 수 GB라 그 위 단위는 쓸 일이 없다.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  // 바이트는 소수점이 의미 없다
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

// 요약 카드에 보여줄 테이블. 전체 테이블은 30개가 넘어 나열하면 오히려 안 읽히므로
// 사용자가 "내 데이터"로 인식하는 다섯 가지만 고른다.
const SUMMARY_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['projects', '프로젝트'],
  ['tasks', '작업'],
  ['todos', 'TODO'],
  ['memos', '메모'],
  ['meetings', '회의']
]

// main이 message를 함께 보내면 그쪽을 쓰고, 없을 때의 기본 문구다.
//
// `files` 단계는 방향에 따라 하는 일이 다르다 — 내보낼 땐 .zip으로 묶고,
// 복원할 땐 풀어서 제자리로 옮긴다(main은 이 구간을 압축 해제 0.05~0.45,
// 파일 복사 0.45~0.98 둘로 나눠 보낸다). 한 문구로 뭉뚱그리면 거짓말이 된다.
const PHASE_LABEL: Record<'export' | 'import', Record<BackupProgress['phase'], string>> = {
  export: {
    db: '데이터베이스 준비 중',
    files: '파일 압축 중',
    done: '마무리 중',
    error: '실패'
  },
  import: {
    db: '데이터베이스 준비 중',
    files: '파일 복원 중',
    done: '마무리 중',
    error: '실패'
  }
}

function formatCreatedAt(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : format(date, 'yyyy-MM-dd HH:mm')
}

function totalBytes(manifest: BackupManifest): number {
  return (
    manifest.db.bytes + manifest.files.recordings.bytes + manifest.files.attachments.bytes
  )
}

function Progress({
  progress,
  direction
}: {
  progress: BackupProgress
  direction: 'export' | 'import'
}): React.ReactNode {
  return (
    <div className="space-y-1.5">
      <ProgressBar percent={Math.round(progress.progress * 100)} color="bg-blue-500" />
      <div className={typo.meta}>
        {progress.message ?? PHASE_LABEL[direction][progress.phase]}
      </div>
    </div>
  )
}

export default function BackupModal({
  onClose,
  initialConfirmedPath = null
}: BackupModalProps): React.ReactNode {
  const {
    exporting,
    importing,
    progress,
    lastExport,
    pickedSummary,
    error,
    exportToFile,
    pickBackup,
    importBackup,
    reset,
    subscribeProgress
  } = useBackupStore()
  const recorderState = useRecorderStore((s) => s.state)

  // 확인 체크는 boolean이 아니라 **"어느 백업을 확인했는가"**로 들고 있는다.
  // 백업 A를 체크한 뒤 B를 고르면 boolean은 켜진 채 남아, B 요약을 읽지도 않고
  // 되돌릴 수 없는 복원이 즉시 눌린다. 경로를 담아두면 대상이 바뀌는 순간
  // 저절로 어긋나 풀리므로 동기화가 필요 없다(effect 없이 렌더 중 파생).
  const pickedPath = pickedSummary?.path ?? null
  const [confirmedPath, setConfirmedPath] = useState<string | null>(initialConfirmedPath)
  const confirmed = isConfirmedFor(confirmedPath, pickedPath)

  // 작업이 도는 동안 닫으면 진행 상황을 볼 방법이 사라진다
  const busy = exporting || importing

  useEffect(() => subscribeProgress(), [subscribeProgress])

  // 모달을 닫을 때 이전 세션의 요약·에러가 남지 않게 한다
  useEffect(() => () => reset(), [reset])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [onClose, busy])

  const requestClose = (): void => {
    if (busy) return
    onClose()
  }

  const isRecording = recorderState !== 'idle'
  const restoreBlockedReason = isRecording
    ? '녹음 중에는 복원할 수 없습니다. 녹음을 멈춘 뒤 다시 시도하세요.'
    : importing
      ? '복원 중입니다. 끝나면 앱이 스스로 다시 시작됩니다.'
      : !confirmed
        ? '위 확인란에 체크해야 복원할 수 있습니다.'
        : null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={requestClose}
    >
      <div
        className="bg-white rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-200">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900">데이터 백업 · 복원</h3>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">
              녹음 파일·전사·요약·프로젝트·TODO·메모·용어집 등 앱 데이터 전체를 파일 하나(.zip)로
              내보냅니다. Google/Notion/Jira 인증 정보는 기기에 묶여 있어 제외되며 새 PC에서 다시
              연결해야 합니다. 음성 모델은 자동으로 다시 내려받습니다.
            </p>
          </div>
          <button
            onClick={requestClose}
            disabled={busy}
            className="p-1 text-gray-400 hover:text-gray-700 transition-colors disabled:opacity-30 shrink-0"
            title={busy ? '작업이 끝난 뒤 닫을 수 있습니다' : '닫기'}
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4 space-y-6">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertTriangleIcon size={14} className="mt-0.5 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}

          {/* ── 내보내기 ── */}
          <section className="space-y-3">
            <div>
              <h4 className="text-sm font-semibold text-gray-900">내보내기</h4>
              <p className={`mt-0.5 ${typo.meta}`}>
                저장할 위치를 고르면 LinkWork-backup-날짜.zip 파일 하나로 담습니다.
              </p>
            </div>
            <button
              onClick={() => void exportToFile()}
              disabled={busy}
              className={`px-4 py-2 text-sm disabled:opacity-40 ${button.primary}`}
            >
              {exporting ? '내보내는 중...' : '백업 파일(.zip) 저장…'}
            </button>

            {progress && !importing && <Progress progress={progress} direction="export" />}

            {lastExport && (
              <div className={`${surface.subtle} px-3 py-2.5 space-y-1 text-xs text-gray-600`}>
                <div className="text-gray-700 break-all">저장 위치: {lastExport.path}</div>
                <div className="tabular-nums">
                  회의 {lastExport.manifest.db.tables.meetings ?? 0}건 · 녹음 파일{' '}
                  {lastExport.manifest.files.recordings.count}개 ·{' '}
                  {formatBytes(lastExport.manifest.files.recordings.bytes)}
                </div>
                {/* manifest는 압축 **전** 원본 바이트를 적는다. .zip 파일 자체 크기와 다르므로
                    "전체"가 아니라 "담긴 데이터"로 부른다 — 사용자가 파일 크기로 오해하면 안 된다. */}
                <div className="tabular-nums">
                  담긴 데이터 {formatBytes(totalBytes(lastExport.manifest))}
                </div>
              </div>
            )}
          </section>

          <div className="border-t border-gray-200" />

          {/* ── 가져오기 ── */}
          <section className="space-y-3">
            <div>
              <h4 className="text-sm font-semibold text-gray-900">가져오기</h4>
              <p className={`mt-0.5 ${typo.meta}`}>
                내보내둔 백업 파일(.zip)을 고르면 내용을 확인한 뒤 복원할 수 있습니다.
              </p>
            </div>
            <button
              onClick={() => void pickBackup()}
              disabled={busy}
              className={`px-4 py-2 text-sm disabled:opacity-40 ${button.subtle}`}
            >
              백업 파일(.zip) 선택…
            </button>

            {pickedSummary && (
              <>
                <div className={`${surface.subtle} px-3 py-2.5 space-y-2 text-xs text-gray-600`}>
                  <div className="text-gray-700 break-all">{pickedSummary.path}</div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    <span>생성일 {formatCreatedAt(pickedSummary.manifest.createdAt)}</span>
                    <span>앱 버전 {pickedSummary.manifest.appVersion}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
                    {SUMMARY_ROWS.map(([key, label]) => (
                      <span key={key}>
                        {label} {pickedSummary.manifest.db.tables[key] ?? 0}건
                      </span>
                    ))}
                  </div>
                  <div className="tabular-nums">
                    녹음 파일 {pickedSummary.manifest.files.recordings.count}개 ·{' '}
                    {formatBytes(pickedSummary.manifest.files.recordings.bytes)} · 담긴 데이터{' '}
                    {formatBytes(totalBytes(pickedSummary.manifest))}
                  </div>
                  {pickedSummary.warnings.length > 0 && (
                    <ul className="list-disc pl-4 space-y-0.5 text-amber-700">
                      {pickedSummary.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-relaxed text-red-700">
                  <AlertTriangleIcon size={14} className="mt-0.5 shrink-0" />
                  <span>
                    현재 앱 데이터가 이 백업으로 <strong className="font-semibold">모두 대체</strong>
                    되고 앱이 다시 시작됩니다. 현재 DB는{' '}
                    <code className="font-mono">linkwork.db.bak-&lt;시각&gt;</code>으로 보관됩니다.
                  </span>
                </div>

                <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmedPath(e.target.checked ? pickedPath : null)}
                    disabled={importing}
                    className="mt-0.5 w-4 h-4 accent-red-600 shrink-0"
                  />
                  위 내용을 확인했으며 현재 데이터가 대체되어도 좋습니다.
                </label>

                {importing && progress && <Progress progress={progress} direction="import" />}

                <div className="space-y-1.5">
                  <button
                    onClick={() => void importBackup(pickedSummary.path)}
                    disabled={!confirmed || busy || isRecording}
                    className={`px-4 py-2 text-sm disabled:opacity-40 ${button.danger}`}
                  >
                    {importing ? '재시작 중...' : '복원 후 재시작'}
                  </button>
                  {restoreBlockedReason && (
                    <div className={typo.metaFaint}>{restoreBlockedReason}</div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>

        <div className="flex items-center justify-end px-6 py-4 border-t border-gray-200">
          <button
            onClick={requestClose}
            disabled={busy}
            className={`px-4 py-2 text-sm disabled:opacity-40 ${button.subtle}`}
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  )
}
