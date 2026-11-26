import { useEffect, useRef, useState } from 'react'
import { formatElapsed, useRecorderStore } from '../../stores/recorderStore'
import { cancelSession, retrySave, startSession, stopAndSave } from '../../stores/recorderSession'
import { useRecognitionAidsStore } from '../../stores/recognitionAidsStore'
import { useRecordingStore } from '../../stores/recordingStore'
import type { MeetingKind, MeetingSource, MeetingTemplateId, SummaryTemplateOption } from '../../types'
import { button } from '../ui'

interface Props {
  onDone: () => void
}

const KIND_LABEL: Record<MeetingKind, string> = {
  meeting: '회의',
  interview: '면접'
}

// 요약 형식 칩. main 목록을 못 읽으면 이 고정 목록을 쓴다('default'는 '자동' 칩과 겹쳐 뺀다).
const FALLBACK_TEMPLATES: SummaryTemplateOption[] = [
  { id: 'one_on_one', name: '1:1' },
  { id: 'standup', name: '스탠드업' },
  { id: 'review', name: '리뷰·회고' }
]

const HEADCOUNT_CHIPS = [2, 3, 4, 5, 6]

// 종료 시 참석 인원을 물을지(#8). 회의인데 참석 인원을 비워 두고 시작했을 때만 묻는다.
export function shouldAskHeadcountOnStop(input: {
  kind: MeetingKind
  speakersInput: string
}): boolean {
  return input.kind === 'meeting' && input.speakersInput.trim() === ''
}

// 녹음 중 남긴 메모(화면 표시용 최근 목록)
interface LiveMark {
  id: number
  raw_ms: number
  text: string
}

// 포커스가 글 입력 중인 요소인지 — B 단축키가 타이핑을 가로채지 않게 한다
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export default function RecorderControls({ onDone }: Props): React.ReactNode {
  // 녹음 상태는 화면(View) 언마운트에도 유지되도록 전역 스토어에 있다.
  // 다른 메뉴로 이동해도 녹음은 계속되고, 돌아오면 이 컴포넌트가 이어서 표시한다.
  const {
    state,
    elapsedMs,
    level,
    error,
    saving,
    saveError,
    draftId,
    pause,
    resume,
    setSaveError
  } = useRecorderStore()
  // 녹음 중인 draft 회의 행. 화면을 다시 열어 지역 상태(종류·참석 인원)가 초기화돼도
  // 종료 시 참석 인원 질문은 실제 회의 값으로 판단한다.
  const draftMeeting = useRecordingStore((st) =>
    draftId == null ? undefined : st.meetings.find((m) => m.id === draftId)
  )

  const { members, fetchAll } = useRecognitionAidsStore()

  const [source, setSource] = useState<MeetingSource>('mic')
  const [kind, setKind] = useState<MeetingKind>('meeting')
  // 참석 인원(화자분리 클러스터 수). 빈 값이면 자동 추정. 면접 기본 2, 회의 기본 자동.
  const [speakerCount, setSpeakerCount] = useState('')
  // 참석 인원 입력에 우리가 마지막으로 자동으로 넣은 값.
  // 사용자가 직접 고쳐 넣은 숫자는 참석자를 더 골라도 덮지 않기 위해 구분한다.
  const [autoFilledCount, setAutoFilledCount] = useState('')
  // 참석자로 지정할 구성원 id
  const [attendeeIds, setAttendeeIds] = useState<number[]>([])
  // 처리 전 긴 침묵을 잘라낼지. 기본 on — 전사·화자분리 시간이 눈에 띄게 줄어든다.
  const [compactAudio, setCompactAudio] = useState(true)
  // 면접 녹음은 지원자 동의가 전제다. 고지를 확인해야만 시작 버튼이 활성화된다.
  const [consent, setConsent] = useState(false)
  // 시작 진행 중(권한 팝업·화면 선택창 대기) — 버튼 중복 클릭을 막는다
  const [starting, setStarting] = useState(false)
  // 요약 형식(#10). null=제목으로 자동 판별
  const [summaryTemplate, setSummaryTemplate] = useState<MeetingTemplateId | null>(null)
  const [templateOptions, setTemplateOptions] = useState<SummaryTemplateOption[]>(FALLBACK_TEMPLATES)
  // 녹음 중 메모·북마크(#11)
  const [memoText, setMemoText] = useState('')
  // 입력란이 빈 상태에서 첫 글자가 들어온 순간의 녹음 경과 — 메모 시각은 쓰기 시작한 시점이다
  const memoAtRef = useRef<number | null>(null)
  const [liveMarks, setLiveMarks] = useState<LiveMark[]>([])
  const [markError, setMarkError] = useState(false)
  // 종료 시 참석 인원 확인 패널(#8)
  const [askingHeadcount, setAskingHeadcount] = useState(false)
  const [headcountInput, setHeadcountInput] = useState('')

  // 참석자 칩에 쓸 구성원 목록. 인식 보조 패널에서 방금 추가했을 수도 있으니 열 때마다 읽는다.
  useEffect(() => {
    void fetchAll()
  }, [])

  // 요약 형식 이름은 main 목록에서 읽는다. 실패하면 고정 목록 그대로.
  useEffect(() => {
    let alive = true
    window.api.recording
      .listSummaryTemplates()
      .then((list) => {
        const opts = list.filter((t) => t.id !== 'default')
        if (alive && opts.length > 0) setTemplateOptions(opts)
      })
      .catch((e) => console.warn('[RecorderControls] 요약 형식 목록 실패', e))
    return () => {
      alive = false
    }
  }, [])

  // 녹음(draft)이 바뀌면 이전 녹음의 메모 표시·질문 패널을 비운다
  useEffect(() => {
    setLiveMarks([])
    setMemoText('')
    memoAtRef.current = null
    setMarkError(false)
    setAskingHeadcount(false)
    setHeadcountInput('')
  }, [draftId])

  const enabledMembers = members.filter((m) => m.enabled === 1)

  // 레벨 미터 바 개수
  const BAR_COUNT = 20
  const activeBars = Math.round(level * BAR_COUNT)

  const isInterview = kind === 'interview'

  // 종류를 바꾸면 참석 인원 기본값도 리셋한다(면접=2, 회의=자동).
  // 이 기본값도 "우리가 넣은 값"이므로, 뒤이어 참석자를 고르면 그 수로 덮인다.
  const handleKindChange = (k: MeetingKind): void => {
    setKind(k)
    // 면접은 요약 형식이 따로 있으므로 회의 형식 선택을 비운다
    if (k === 'interview') setSummaryTemplate(null)
    const preset = k === 'interview' ? '2' : ''
    setSpeakerCount(preset)
    setAutoFilledCount(preset)
  }

  // 참석자를 고르면 참석 인원을 그 수로 제안한다.
  // 단 사용자가 직접 입력한 숫자(= 우리가 넣은 값과 다른 숫자)는 건드리지 않는다.
  const toggleAttendee = (memberId: number): void => {
    const next = attendeeIds.includes(memberId)
      ? attendeeIds.filter((id) => id !== memberId)
      : [...attendeeIds, memberId]
    setAttendeeIds(next)

    const untouched = speakerCount.trim() === '' || speakerCount === autoFilledCount
    if (!untouched) return
    // 참석자를 모두 해제하면 종류별 기본값으로 되돌린다(면접=2, 회의=자동).
    const fallback = kind === 'interview' ? '2' : ''
    const suggested = next.length > 0 ? String(next.length) : fallback
    setSpeakerCount(suggested)
    setAutoFilledCount(suggested)
  }

  // 녹음 수명주기(draft 행 생성·삭제, 저장, 후속 처리)는 recorderSession이 맡는다.
  // 화면이 언마운트돼도 main의 창 닫기/앱 종료 가드가 같은 경로로 저장할 수 있게 하기 위해서다.
  const handleStart = async (): Promise<void> => {
    if (starting) return
    setStarting(true)
    try {
      const parsed = speakerCount.trim() === '' ? NaN : parseInt(speakerCount, 10)
      const expected_speakers = Number.isNaN(parsed) ? null : parsed
      await startSession({
        source,
        kind,
        expected_speakers,
        attendee_ids: attendeeIds,
        compact_audio: compactAudio,
        summary_template: kind === 'meeting' ? summaryTemplate : null
      })
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : '녹음 시작 실패')
    } finally {
      setStarting(false)
    }
  }

  // 오디오 저장까지만 기다리고 닫는다. 전사·요약은 백그라운드에서 진행된다.
  // 실패 시 recorderSession이 saveError를 세팅하고 'stopped' 상태로 남겨 재시도할 수 있게 한다.
  const handleStop = async (): Promise<void> => {
    if (saving) return
    try {
      await stopAndSave({ process: true })
      onDone()
    } catch {
      // saveError로 표시된다
    }
  }

  // 종료 버튼 — 회의인데 참석 인원을 비워 두었으면 먼저 묻는다(녹음은 계속된다).
  const handleStopClick = (): void => {
    if (saving) return
    const ask = shouldAskHeadcountOnStop(
      draftMeeting
        ? {
            kind: draftMeeting.kind,
            speakersInput:
              draftMeeting.expected_speakers == null ? '' : String(draftMeeting.expected_speakers)
          }
        : { kind, speakersInput: speakerCount }
    )
    if (ask) {
      setHeadcountInput('')
      setAskingHeadcount(true)
      return
    }
    void handleStop()
  }

  // 참석 인원을 저장하고 종료한다. 인원 저장이 실패해도 녹음 저장은 계속한다.
  const handleHeadcountPick = async (n: number | null): Promise<void> => {
    setAskingHeadcount(false)
    const id = useRecorderStore.getState().draftId
    if (n != null && id != null) {
      try {
        await window.api.recording.setExpectedSpeakers(id, n)
      } catch (e) {
        console.warn('[RecorderControls] 참석 인원 저장 실패', e)
      }
    }
    await handleStop()
  }

  const parsedHeadcount = parseInt(headcountInput, 10)
  const headcountValid =
    /^\d+$/.test(headcountInput.trim()) && parsedHeadcount >= 1 && parsedHeadcount <= 20

  // 메모·북마크 저장. store가 아니라 window.api를 직접 부른다 — 녹음 중 회의는 상세에 열려 있지 않다.
  const saveMark = async (rawMs: number, text: string): Promise<boolean> => {
    const meetingId = useRecorderStore.getState().draftId
    if (meetingId == null) return false
    try {
      const r = await window.api.recording.addMark({ meetingId, raw_ms: rawMs, text, origin: 'live' })
      setMarkError(false)
      // 저장 중 다른 녹음으로 넘어갔으면 표시하지 않는다
      if (useRecorderStore.getState().draftId === meetingId) {
        setLiveMarks((prev) => [...prev, { id: r.id, raw_ms: rawMs, text }])
      }
      return true
    } catch (e) {
      console.warn('[RecorderControls] 메모 저장 실패', e)
      setMarkError(true)
      return false
    }
  }

  const handleMemoChange = (value: string): void => {
    if (memoText === '' && value !== '') memoAtRef.current = useRecorderStore.getState().elapsedMs
    if (value === '') memoAtRef.current = null
    setMemoText(value)
  }

  const handleMemoSubmit = async (): Promise<void> => {
    const text = memoText.trim()
    if (!text) return
    const at = memoAtRef.current ?? useRecorderStore.getState().elapsedMs
    const ok = await saveMark(at, text)
    if (ok) {
      setMemoText('')
      memoAtRef.current = null
    }
  }

  const handleBookmark = (): void => {
    void saveMark(useRecorderStore.getState().elapsedMs, '')
  }

  // B 키 북마크 — 녹음 중이고 글 입력 중이 아닐 때만. 이 화면이 떠 있을 때만 듣는다(전역 단축키 아님).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'b' && e.key !== 'B') return
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return
      if (useRecorderStore.getState().state !== 'recording') return
      e.preventDefault()
      void saveMark(useRecorderStore.getState().elapsedMs, '')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handleRetrySave = async (): Promise<void> => {
    if (saving) return
    try {
      await retrySave()
      onDone()
    } catch {
      // saveError로 표시된다
    }
  }

  // 녹음·일시정지 중 취소는 녹음 내용과 draft 회의를 지우므로 확인을 받는다.
  const handleCancelRecording = async (): Promise<void> => {
    if (!window.confirm('녹음을 취소하면 지금까지 녹음된 내용이 삭제됩니다. 취소할까요?')) return
    await cancelSession()
    onDone()
  }

  // 저장 실패로 남은 녹음을 버린다 — 버튼 자체가 명시적인 선택이라 확인은 생략한다.
  const handleDiscard = async (): Promise<void> => {
    await cancelSession()
    onDone()
  }

  const handleClose = (): void => {
    onDone()
  }

  const isIdle = state === 'idle'
  const isRecording = state === 'recording'
  const isPaused = state === 'paused'
  const isStopped = state === 'stopped'

  return (
    <div className="px-4 py-3 space-y-3">
      {/* 종류 · 소스 선택 (idle 상태에서만) */}
      {isIdle && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {/* 녹음 종류 — 요약 형식과 상세 화면이 이 값으로 갈린다 */}
            <div className="flex bg-gray-100 rounded-md p-0.5 w-fit">
              {(['meeting', 'interview'] as MeetingKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => handleKindChange(k)}
                  className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                    kind === k
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>

            <span className="text-gray-200">|</span>

            <div className="flex bg-gray-100 rounded-md p-0.5 w-fit">
              {(['mic', 'mic+system'] as MeetingSource[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSource(s)}
                  className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                    source === s
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {s === 'mic' ? '마이크' : '마이크 + 시스템'}
                </button>
              ))}
            </div>
          </div>

          {/* 요약 형식 — 회의만. 자동이면 제목으로 판별한다 */}
          {!isInterview && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-gray-500 shrink-0">요약 형식</span>
              {[{ id: null, name: '자동' } as { id: MeetingTemplateId | null; name: string }]
                .concat(templateOptions)
                .map((t) => {
                  const selected = summaryTemplate === t.id
                  return (
                    <button
                      key={t.id ?? 'auto'}
                      type="button"
                      onClick={() => setSummaryTemplate(t.id)}
                      aria-pressed={selected}
                      className={`px-2 py-0.5 text-[11px] rounded-full border transition-colors ${
                        selected
                          ? 'bg-blue-50 border-blue-200 text-blue-600 font-medium'
                          : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                      }`}
                    >
                      {t.name}
                    </button>
                  )
                })}
            </div>
          )}

          {/* 참석자 — 전사 힌트·화자 이름 프리셋·요약 담당자 매칭에 함께 쓰인다 */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-gray-500 shrink-0">참석자</span>
            {enabledMembers.length === 0 ? (
              <span className="text-[10px] text-gray-400">
                구성원을 등록하면 참석자를 고를 수 있습니다
              </span>
            ) : (
              enabledMembers.map((m) => {
                const selected = attendeeIds.includes(m.id)
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggleAttendee(m.id)}
                    title={m.role ? `${m.name} · ${m.role}` : m.name}
                    className={`px-2 py-0.5 text-[11px] rounded-full border transition-colors ${
                      selected
                        ? 'bg-blue-50 border-blue-200 text-blue-600 font-medium'
                        : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {m.name}
                  </button>
                )
              })
            )}
          </div>

          {/* 참석 인원 — 화자분리 클러스터 수. 비우면 자동 추정 (MeetingDetail 재분리 입력과 동일 규약) */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">참석 인원</span>
            <input
              type="number"
              min={1}
              max={20}
              value={speakerCount}
              onChange={(e) => setSpeakerCount(e.target.value)}
              placeholder="자동"
              title="참석 인원을 지정하면 그 수만큼 화자를 분리합니다 (비우면 자동 추정)"
              className="w-14 text-xs px-1.5 py-1 border border-gray-200 rounded text-center focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            <span className="text-[11px] text-gray-400">명</span>
            <span className="text-[10px] text-gray-400">비우면 자동 추정</span>
          </div>

          {/* 무음 컷편집 — 처리 전에 긴 침묵을 잘라 전사·화자분리 입력을 줄인다 */}
          <label className="flex items-center gap-1.5 cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={compactAudio}
              onChange={(e) => setCompactAudio(e.target.checked)}
              className="accent-blue-600"
            />
            <span className="text-xs text-gray-500">무음 구간 자동 제거</span>
            <span className="text-[10px] text-gray-400">
              긴 침묵을 잘라 전사·화자 분리를 빠르게 (녹음 파일이 그만큼 짧아집니다)
            </span>
          </label>

          {/* 면접: 동의 고지 (개인정보보호법상 사전 동의 필요) */}
          {isInterview && (
            <label className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md cursor-pointer">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 accent-amber-600"
              />
              <span className="text-[11px] text-amber-800 leading-relaxed">
                지원자에게 녹음 사실과 목적을 알리고 동의를 받았습니다.
                <span className="block text-amber-600">
                  기록은 답변 확인용이며, AI 요약은 합격 판정 근거로 사용하지 않습니다.
                </span>
              </span>
            </label>
          )}
        </div>
      )}

      {/* 경과 시간 + 레벨 미터 (녹음/일시정지 중) */}
      {(isRecording || isPaused) && (
        <div className="flex items-center gap-3">
          {/* 시간 */}
          <span className="font-mono text-sm font-semibold text-gray-800 tabular-nums w-14">
            {formatElapsed(elapsedMs)}
          </span>

          {/* 레벨 미터 */}
          <div className="flex items-end gap-px h-4" aria-label="입력 레벨">
            {Array.from({ length: BAR_COUNT }).map((_, i) => (
              <div
                key={i}
                className={`w-1 rounded-sm transition-all duration-75 ${
                  i < activeBars
                    ? isPaused
                      ? 'bg-gray-400'
                      : i < BAR_COUNT * 0.6
                        ? 'bg-green-500'
                        : i < BAR_COUNT * 0.85
                          ? 'bg-yellow-400'
                          : 'bg-red-500'
                    : 'bg-gray-200'
                }`}
                style={{ height: `${Math.max(20, ((i + 1) / BAR_COUNT) * 100)}%` }}
              />
            ))}
          </div>

          {/* 상태 표시 */}
          {isPaused ? (
            <span className="text-[11px] text-gray-400 font-medium">일시정지됨</span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-red-500 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              녹음 중
            </span>
          )}
        </div>
      )}

      {/* 녹음 중 메모·북마크 — 메모 시각은 쓰기 시작한 순간 */}
      {(isRecording || isPaused) && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={memoText}
              onChange={(e) => handleMemoChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleMemoSubmit()
                } else if (e.key === 'Escape') {
                  setMemoText('')
                  memoAtRef.current = null
                }
              }}
              maxLength={500}
              placeholder="메모 입력 후 Enter · 빈 곳에서 B: 북마크"
              className="flex-1 min-w-0 text-xs px-2 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            <button
              type="button"
              onClick={handleBookmark}
              title="지금 시점을 북마크합니다 (B)"
              className={`shrink-0 px-2.5 py-1 text-xs ${button.subtle}`}
            >
              북마크
            </button>
          </div>
          {liveMarks.length > 0 && (
            <ul className="space-y-0.5">
              {liveMarks.slice(-3).map((m) => (
                <li key={m.id} className="text-[11px] text-gray-500 truncate">
                  <span className="font-mono text-gray-400">[{formatElapsed(m.raw_ms)}]</span>{' '}
                  {m.text === '' ? '북마크' : m.text}
                </li>
              ))}
            </ul>
          )}
          {markError && <p className="text-[11px] text-red-500">메모를 저장하지 못했습니다.</p>}
        </div>
      )}

      {/* 종료 시 참석 인원 확인 — 버튼 자리에 띄우고 녹음은 계속된다 */}
      {askingHeadcount && (isRecording || isPaused) ? (
        <div className="space-y-2 px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-md">
          <div>
            <p className="text-xs font-medium text-gray-800">참석 인원은 몇 명이었나요?</p>
            <p className="text-[11px] text-gray-500">알려 주면 화자를 그 수로 나눕니다.</p>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {HEADCOUNT_CHIPS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => void handleHeadcountPick(n)}
                disabled={saving}
                className="px-2.5 py-0.5 text-xs rounded-full border border-gray-200 bg-white text-gray-700 hover:bg-blue-50 hover:border-blue-200 transition-colors disabled:opacity-50"
              >
                {n}
              </button>
            ))}
            <input
              type="number"
              min={1}
              max={20}
              value={headcountInput}
              onChange={(e) => setHeadcountInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && headcountValid) void handleHeadcountPick(parsedHeadcount)
              }}
              aria-label="참석 인원"
              className="w-14 text-xs px-1.5 py-0.5 border border-gray-200 rounded text-center focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            <button
              type="button"
              onClick={() => void handleHeadcountPick(parsedHeadcount)}
              disabled={!headcountValid || saving}
              className={`px-2 py-0.5 text-xs ${button.subtle} disabled:opacity-40`}
            >
              확인
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleHeadcountPick(null)}
              disabled={saving}
              className={`px-2.5 py-1 text-xs ${button.dark} disabled:opacity-50`}
            >
              {saving ? '저장 중...' : '모르겠어요 · 자동'}
            </button>
            <button
              type="button"
              onClick={() => setAskingHeadcount(false)}
              disabled={saving}
              className="px-2.5 py-1 text-xs text-gray-500 hover:text-gray-700 transition-colors disabled:opacity-50"
            >
              녹음 계속
            </button>
          </div>
        </div>
      ) : (
      <div className="flex items-center gap-2">
        {isIdle && (
          <button
            type="button"
            onClick={handleStart}
            disabled={starting || (isInterview && !consent)}
            title={isInterview && !consent ? '동의 확인 후 시작할 수 있습니다' : undefined}
            className={`px-3 py-1.5 text-xs font-medium ${button.primary} flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <RecordIcon />
            {starting ? '시작 중...' : isInterview ? '면접 녹음 시작' : '녹음 시작'}
          </button>
        )}

        {isRecording && (
          <>
            <button
              type="button"
              onClick={pause}
              className={`px-3 py-1.5 text-xs font-medium ${button.subtle}`}
            >
              일시정지
            </button>
            <button
              type="button"
              onClick={handleStopClick}
              disabled={saving}
              className={`px-3 py-1.5 text-xs font-medium ${button.dark} disabled:opacity-50`}
            >
              {saving ? '저장 중...' : '종료 및 저장'}
            </button>
          </>
        )}

        {isPaused && (
          <>
            <button
              type="button"
              onClick={resume}
              className={`px-3 py-1.5 text-xs font-medium ${button.primary}`}
            >
              재개
            </button>
            <button
              type="button"
              onClick={handleStopClick}
              disabled={saving}
              className={`px-3 py-1.5 text-xs font-medium ${button.dark} disabled:opacity-50`}
            >
              {saving ? '저장 중...' : '종료 및 저장'}
            </button>
          </>
        )}

        {/* 'stopped'는 오디오 저장이 실패해 녹음이 보존된 상태다(성공하면 바로 idle로 돌아간다) */}
        {isStopped && (
          <>
            <button
              type="button"
              onClick={handleRetrySave}
              disabled={saving}
              className={`px-3 py-1.5 text-xs font-medium ${button.dark} disabled:opacity-50`}
            >
              {saving ? '저장 중...' : '다시 저장'}
            </button>
            <button
              type="button"
              onClick={handleDiscard}
              disabled={saving}
              className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
            >
              버리기
            </button>
          </>
        )}

        {(isRecording || isPaused) && (
          <button
            type="button"
            onClick={handleCancelRecording}
            disabled={saving}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
          >
            취소
          </button>
        )}

        {isIdle && (
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            닫기
          </button>
        )}
      </div>
      )}

      {/* 오류 표시 */}
      {(error ?? saveError) && (
        <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-md">
          {error ?? saveError}
        </p>
      )}
    </div>
  )
}

function RecordIcon(): React.ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="10" />
    </svg>
  )
}
