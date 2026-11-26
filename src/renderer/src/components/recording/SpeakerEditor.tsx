import { useEffect, useState } from 'react'
import { useRecordingStore } from '../../stores/recordingStore'
import type { VoiceAction } from '../../stores/recordingStore'
import type { Attendee, MeetingSpeaker } from '../../types'
import { Badge } from '../ui'
import RematchDialog from './RematchDialog'

interface Props {
  speakers: MeetingSpeaker[]
  meetingId: number
  /** 이 회의의 참석자. 화자 이름 프리셋으로 쓴다. */
  attendees?: Attendee[]
}

const PRESET_COLORS = [
  '#4F8EF7', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
  '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6B7280'
]

// 프리셋 이름(참석자 이름)이 이미 다른 화자에게 쓰이고 있으면 '홍길동 2', '홍길동 3'…처럼
// 다음 빈 번호를 붙여 돌려준다. 같은 참석자 이름을 여러 화자에 눌렀을 때 이름 충돌을 막는다.
export function nextPresetName(base: string, usedNames: string[]): string {
  const used = new Set(usedNames.map((n) => n.trim()).filter(Boolean))
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!used.has(candidate)) return candidate
  }
}

// 한 화자 행에 붙일 프리셋 버튼 상한. 참석자를 많이 지정한 회의에서 이름 버튼이
// 행을 밀어내고 실명 입력칸을 잡아먹지 않도록 자른다.
const MAX_NAME_PRESETS = 8

// 화자 이름 프리셋은 참석자 이름만 쓴다(빈 이름·중복 제거, 상한 MAX_NAME_PRESETS).
export function buildNamePresets(attendees: Attendee[]): string[] {
  const names = attendees.map((a) => a.name.trim()).filter(Boolean)
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out.slice(0, MAX_NAME_PRESETS)
}

// 화자 행에 붙는 목소리 상태. 표시와 버튼이 함께 갈리므로 판정을 한곳에 둔다.
//  - auto: 목소리로 자동 지정됨 → 맞음/이 사람 아님
//  - suggested: 후보만 있음 → 지정/아님
//  - enrolled: 이 화자 목소리가 구성원 표본으로 실제 저장됨
//  - enrollable: 이름이 있고 목소리가 있는데 아직 표본으로 저장되지 않음 → 목소리 등록
export type SpeakerVoiceState = 'auto' | 'suggested' | 'enrolled' | 'enrollable' | null

export function speakerVoiceState(
  s: Pick<
    MeetingSpeaker,
    'display_name' | 'member_id' | 'member_source' | 'has_voice' | 'voice_enrolled'
  >
): SpeakerVoiceState {
  if (s.member_id != null && s.member_source === 'auto') return 'auto'
  if (s.member_id != null && s.member_source === 'suggested') return 'suggested'
  if (s.voice_enrolled) return 'enrolled'
  if (s.has_voice && (s.display_name ?? '').trim() !== '') return 'enrollable'
  return null
}

// 매칭 점수(코사인 0~1)를 사람이 읽는 퍼센트로
export function formatMatchScore(score: number | null): string | null {
  if (score == null || !Number.isFinite(score)) return null
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`
}

const voiceBtn =
  'text-[10px] px-1.5 py-0.5 rounded transition-colors disabled:opacity-50'

// 화자 행의 목소리 배지·버튼. 훅을 쓰지 않는 표시 전용 컴포넌트다(테스트에서 직접 호출한다).
export function SpeakerVoiceControls({
  speaker,
  busy,
  onAction
}: {
  speaker: Pick<
    MeetingSpeaker,
    | 'display_name'
    | 'member_id'
    | 'member_source'
    | 'match_score'
    | 'has_voice'
    | 'voice_enrolled'
    | 'member_name'
  >
  busy: boolean
  onAction: (action: VoiceAction) => void
}): React.ReactNode {
  const state = speakerVoiceState(speaker)
  if (state == null) return null

  const act =
    (action: VoiceAction) =>
    (e: { stopPropagation: () => void }): void => {
      e.stopPropagation()
      onAction(action)
    }

  if (state === 'auto') {
    const pct = formatMatchScore(speaker.match_score)
    return (
      <div className="flex items-center gap-1 shrink-0">
        <Badge color="bg-blue-50 text-blue-600" size="xs" title="저장된 목소리와 비교해 지정했습니다">
          {pct ? `목소리로 자동 지정 · ${pct}` : '목소리로 자동 지정'}
        </Badge>
        <button
          type="button"
          onClick={act('confirm')}
          disabled={busy}
          className={`${voiceBtn} bg-blue-50 text-blue-600 hover:bg-blue-100`}
          title="맞으면 이 목소리를 등록합니다"
        >
          맞음
        </button>
        <button
          type="button"
          onClick={act('reject')}
          disabled={busy}
          className={`${voiceBtn} text-gray-400 hover:text-gray-600 hover:bg-gray-100`}
        >
          이 사람 아님
        </button>
      </div>
    )
  }

  if (state === 'suggested') {
    return (
      <div className="flex items-center gap-1 shrink-0">
        <span className="text-[11px] text-gray-500">혹시 {speaker.member_name ?? '구성원'}?</span>
        <button
          type="button"
          onClick={act('confirm')}
          disabled={busy}
          className={`${voiceBtn} bg-blue-50 text-blue-600 hover:bg-blue-100`}
        >
          지정
        </button>
        <button
          type="button"
          onClick={act('reject')}
          disabled={busy}
          className={`${voiceBtn} text-gray-400 hover:text-gray-600 hover:bg-gray-100`}
        >
          아님
        </button>
      </div>
    )
  }

  if (state === 'enrolled') {
    return (
      <Badge color="bg-green-50 text-green-700" size="xs" title="다음 회의부터 이 목소리로 화자를 찾습니다">
        목소리 등록됨
      </Badge>
    )
  }

  return (
    <button
      type="button"
      onClick={act('enroll')}
      disabled={busy}
      className={`shrink-0 ${voiceBtn} bg-gray-100 text-gray-500 hover:bg-blue-50 hover:text-blue-600`}
      title="이 이름의 구성원으로 목소리를 등록합니다"
    >
      목소리 등록
    </button>
  )
}

// 목소리 액션 결과 안내. 실패는 병합 실패와 같은 빨간 줄, 참고 안내는 회색 줄
export function VoiceNotice({ ok, message }: { ok: boolean; message: string }): React.ReactNode {
  return (
    <p
      role={ok ? 'status' : 'alert'}
      className={`text-xs px-3 py-2 rounded-md ${
        ok ? 'text-gray-500 bg-gray-50' : 'text-red-500 bg-red-50'
      }`}
    >
      {message}
    </p>
  )
}

// 목소리는 있는데 이름이 빈 화자가 있으면 등록된 목소리로 다시 찾기를 권한다
export function shouldOfferRematch(
  speakers: Array<Pick<MeetingSpeaker, 'has_voice' | 'display_name'>>
): boolean {
  return speakers.some((s) => s.has_voice && (s.display_name ?? '').trim() === '')
}

// 화자 목록 위 다시 찾기 안내 줄
export function RematchPrompt({ onOpen }: { onOpen: () => void }): React.ReactNode {
  return (
    <div className="flex items-center gap-2 text-[11px] text-gray-400 bg-gray-50 px-3 py-1.5 rounded-md">
      <span className="flex-1 min-w-0">이름 없는 화자를 등록된 목소리와 다시 비교합니다.</span>
      <button
        type="button"
        onClick={onOpen}
        className="shrink-0 text-[11px] px-2 py-0.5 rounded bg-white border border-gray-200 text-gray-600 hover:bg-gray-100 transition-colors"
      >
        등록된 목소리로 다시 찾기
      </button>
    </div>
  )
}

export default function SpeakerEditor({
  speakers,
  meetingId,
  attendees
}: Props): React.ReactNode {
  const {
    updateSpeaker,
    mergeSpeakers,
    refreshCurrent,
    confirmSpeakerMatch,
    rejectSpeakerMatch,
    enrollSpeakerVoice
  } = useRecordingStore()
  const [mergeFrom, setMergeFrom] = useState<number | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const [voiceBusyId, setVoiceBusyId] = useState<number | null>(null)
  // 목소리 액션 안내. ok=false는 실패(빨강), ok=true는 참고 안내(회색)
  const [voiceNotice, setVoiceNotice] = useState<{ ok: boolean; message: string } | null>(null)
  const [rematchOpen, setRematchOpen] = useState(false)

  const namePresets = buildNamePresets(attendees ?? [])

  if (speakers.length === 0) {
    return (
      <p className="text-xs text-gray-400 py-4 text-center">
        전사 후 화자가 표시됩니다
      </p>
    )
  }

  const handleMerge = async (intoId: number): Promise<void> => {
    if (mergeFrom == null || mergeFrom === intoId) return
    setMergeBusy(true)
    setMergeError(null)
    try {
      await mergeSpeakers(meetingId, mergeFrom, intoId)
      await refreshCurrent()
      setMergeFrom(null)
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : '병합 실패')
    } finally {
      setMergeBusy(false)
    }
  }

  // 목소리 액션은 store가 상세를 새로고침한다. 실패하면 버튼은 그대로 두고 안내만 띄운다
  const handleVoiceAction = async (speakerId: number, action: VoiceAction): Promise<void> => {
    setVoiceBusyId(speakerId)
    setVoiceNotice(null)
    try {
      const run =
        action === 'confirm'
          ? confirmSpeakerMatch
          : action === 'reject'
            ? rejectSpeakerMatch
            : enrollSpeakerVoice
      const outcome = await run(speakerId)
      if (outcome.message) setVoiceNotice({ ok: outcome.ok, message: outcome.message })
    } finally {
      setVoiceBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">화자 보정</p>

      {namePresets.length > 0 && (
        <p className="text-[11px] text-gray-400">
          참석자 이름을 눌러 화자를 바로 지정할 수 있습니다
        </p>
      )}

      {shouldOfferRematch(speakers) && <RematchPrompt onOpen={() => setRematchOpen(true)} />}

      <ul className="space-y-2">
        {speakers.map((spk) => (
          <SpeakerRow
            key={spk.id}
            speaker={spk}
            namePresets={namePresets}
            usedNames={speakers
              .filter((s) => s.id !== spk.id)
              .map((s) => s.display_name ?? '')
              .filter(Boolean)}
            mergeFromId={mergeFrom}
            isMergeTarget={mergeFrom != null && mergeFrom !== spk.id}
            mergeBusy={mergeBusy}
            onUpdate={async (input) => {
              await updateSpeaker(spk.id, input)
              await refreshCurrent()
            }}
            onSelectMergeFrom={() =>
              setMergeFrom((prev) => (prev === spk.id ? null : spk.id))
            }
            onMergeInto={() => handleMerge(spk.id)}
            voiceBusy={voiceBusyId === spk.id}
            onVoiceAction={(action) => void handleVoiceAction(spk.id, action)}
          />
        ))}
      </ul>

      {mergeFrom != null && (
        <p className="text-xs text-blue-600 bg-blue-50 px-3 py-2 rounded-md">
          <span className="font-medium">
            "{speakers.find((s) => s.id === mergeFrom)?.display_name ??
              speakers.find((s) => s.id === mergeFrom)?.label}"
          </span>
          를 다른 화자에 병합할 대상을 선택하세요.{' '}
          <button
            type="button"
            onClick={() => setMergeFrom(null)}
            className="underline text-blue-500 hover:text-blue-700"
          >
            취소
          </button>
        </p>
      )}

      {voiceNotice && <VoiceNotice ok={voiceNotice.ok} message={voiceNotice.message} />}

      {mergeError && (
        <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-md">{mergeError}</p>
      )}

      <RematchDialog
        open={rematchOpen}
        opts={{ meetingIds: [meetingId] }}
        onClose={() => {
          setRematchOpen(false)
          void refreshCurrent()
        }}
      />
    </div>
  )
}

function SpeakerRow({
  speaker,
  namePresets,
  usedNames,
  mergeFromId,
  isMergeTarget,
  mergeBusy,
  onUpdate,
  onSelectMergeFrom,
  onMergeInto,
  voiceBusy,
  onVoiceAction
}: {
  speaker: MeetingSpeaker
  namePresets: string[]
  // 이 화자를 제외한 다른 화자들이 이미 쓰고 있는 이름 (프리셋 자동 번호 부여용)
  usedNames: string[]
  mergeFromId: number | null
  isMergeTarget: boolean
  mergeBusy: boolean
  onUpdate: (input: { display_name?: string | null; color?: string }) => Promise<void>
  onSelectMergeFrom: () => void
  onMergeInto: () => Promise<void>
  voiceBusy: boolean
  onVoiceAction: (action: VoiceAction) => void
}): React.ReactNode {
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(speaker.display_name ?? '')
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [saving, setSaving] = useState(false)

  const isSelected = mergeFromId === speaker.id

  // 자동 지정·거절로 이름이 바깥에서 바뀌면 입력 초안도 따라간다 (편집 중에는 덮지 않는다)
  useEffect(() => {
    if (!editingName) setNameValue(speaker.display_name ?? '')
  }, [speaker.display_name])

  const handleNameSave = async (): Promise<void> => {
    setEditingName(false)
    const trimmed = nameValue.trim()
    const newName = trimmed === '' ? null : trimmed
    if (newName === speaker.display_name) return
    setSaving(true)
    try {
      await onUpdate({ display_name: newName })
    } finally {
      setSaving(false)
    }
  }

  const handleColorSelect = async (color: string): Promise<void> => {
    setShowColorPicker(false)
    if (color === speaker.color) return
    setSaving(true)
    try {
      await onUpdate({ color })
    } finally {
      setSaving(false)
    }
  }

  const handlePresetName = async (base: string): Promise<void> => {
    // 같은 프리셋 이름을 이미 다른 화자가 쓰고 있으면 '홍길동 2'처럼 번호를 붙인다.
    const name = nextPresetName(base, usedNames)
    if (name === speaker.display_name) return
    setNameValue(name)
    setSaving(true)
    try {
      await onUpdate({ display_name: name })
    } finally {
      setSaving(false)
    }
  }

  return (
    <li
      className={`relative flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
        isSelected
          ? 'border-blue-300 bg-blue-50'
          : isMergeTarget
            ? 'border-dashed border-blue-300 bg-white hover:bg-blue-50 cursor-pointer'
            : 'border-gray-200 bg-white'
      } ${saving ? 'opacity-60' : ''}`}
      onClick={isMergeTarget && !mergeBusy ? onMergeInto : undefined}
      role={isMergeTarget ? 'button' : undefined}
      title={isMergeTarget ? '이 화자로 병합' : undefined}
    >
      {/* 색상 버튼 */}
      <div className="relative">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setShowColorPicker((v) => !v)
          }}
          className="w-6 h-6 rounded-full border-2 border-white shadow-sm hover:scale-110 transition-transform"
          style={{ backgroundColor: speaker.color }}
          title="색상 변경"
          aria-label="화자 색상 변경"
        />
        {showColorPicker && (
          <div
            className="absolute z-20 left-0 top-8 w-max bg-white border border-gray-200 rounded-lg shadow-lg p-2 grid grid-cols-5 gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => handleColorSelect(c)}
                className={`w-5 h-5 rounded-full hover:scale-110 transition-transform ${
                  c === speaker.color ? 'ring-2 ring-offset-1 ring-gray-400' : ''
                }`}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
          </div>
        )}
      </div>

      {/* 기본 라벨 */}
      <span className="text-xs text-gray-400 shrink-0 w-14">{speaker.label}</span>

      {/* 실명 입력 */}
      {editingName ? (
        <input
          type="text"
          value={nameValue}
          onChange={(e) => setNameValue(e.target.value)}
          onBlur={handleNameSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleNameSave()
            if (e.key === 'Escape') {
              setNameValue(speaker.display_name ?? '')
              setEditingName(false)
            }
          }}
          autoFocus
          placeholder="실명 입력..."
          className="flex-1 text-sm px-2 py-0.5 border border-blue-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setEditingName(true)
          }}
          className="flex-1 text-left text-sm hover:bg-gray-100 px-2 py-0.5 rounded transition-colors"
          title="클릭하여 실명 입력"
        >
          {speaker.display_name ? (
            <span className="text-gray-800 font-medium">{speaker.display_name}</span>
          ) : (
            <span className="text-gray-400 italic">실명 입력...</span>
          )}
        </button>
      )}

      {/* 참석자 이름 프리셋 (아직 이름이 없는 화자에만 노출) */}
      {!isMergeTarget && !editingName && !speaker.display_name && namePresets.length > 0 && (
        <div className="flex items-center gap-1 shrink-0">
          {namePresets.map((name) => (
            <button
              key={name}
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                void handlePresetName(name)
              }}
              disabled={saving}
              className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 hover:bg-purple-100 hover:text-purple-700 transition-colors disabled:opacity-50"
              title={`이 화자를 '${name}'으로 지정`}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {/* 목소리 자동 지정·제안·등록 */}
      {!isMergeTarget && !editingName && (
        <SpeakerVoiceControls
          speaker={speaker}
          busy={voiceBusy || saving}
          onAction={onVoiceAction}
        />
      )}

      {/* 병합 선택 버튼 */}
      {!isMergeTarget && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onSelectMergeFrom()
          }}
          className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded transition-colors ${
            isSelected
              ? 'bg-blue-100 text-blue-600'
              : 'text-gray-300 hover:text-gray-500 hover:bg-gray-100'
          }`}
          title={isSelected ? '병합 선택 취소' : '이 화자를 병합 소스로 선택'}
        >
          {isSelected ? '취소' : '병합'}
        </button>
      )}

      {isMergeTarget && !mergeBusy && (
        <span className="shrink-0 text-[10px] text-blue-500 font-medium">여기로 병합</span>
      )}
    </li>
  )
}
