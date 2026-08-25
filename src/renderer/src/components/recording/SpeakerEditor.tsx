import { useState } from 'react'
import { useRecordingStore } from '../../stores/recordingStore'
import type { Attendee, MeetingKind, MeetingSpeaker } from '../../types'
import { IconButton, TrashIcon } from '../ui'

interface Props {
  speakers: MeetingSpeaker[]
  meetingId: number
  kind?: MeetingKind
  /** 이 회의의 참석자. 화자 이름 프리셋으로 쓴다. */
  attendees?: Attendee[]
}

const PRESET_COLORS = [
  '#4F8EF7', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
  '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6B7280'
]

// 면접에서 화자 이름을 한 번에 지정하기 위한 프리셋. 요약 프롬프트가 "질문하는 쪽=면접관"을
// 추론하긴 하지만, 이름을 명시해두면 Q&A 귀속이 훨씬 안정적이다.
const INTERVIEW_NAME_PRESETS = ['면접관', '지원자']

// 프리셋 이름이 이미 다른 화자에게 쓰이고 있으면 '면접관 2', '면접관 3'…처럼
// 다음 빈 번호를 붙여 돌려준다. 다인 면접(면접관·지원자 여럿)에서 이름 충돌을 막는다.
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

// 면접은 기존 역할 프리셋 뒤에 참석자 이름을 붙이고, 회의는 참석자 이름만 쓴다.
export function buildNamePresets(kind: MeetingKind | undefined, attendees: Attendee[]): string[] {
  const base = kind === 'interview' ? INTERVIEW_NAME_PRESETS : []
  const names = attendees.map((a) => a.name.trim()).filter(Boolean)
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of [...base, ...names]) {
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out.slice(0, MAX_NAME_PRESETS)
}

export default function SpeakerEditor({
  speakers,
  meetingId,
  kind,
  attendees
}: Props): React.ReactNode {
  const { updateSpeaker, mergeSpeakers, refreshCurrent } = useRecordingStore()
  const [mergeFrom, setMergeFrom] = useState<number | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)

  const namePresets = buildNamePresets(kind, attendees ?? [])

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

  return (
    <div className="space-y-3">
      <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">화자 보정</p>

      {kind === 'interview' ? (
        <p className="text-[11px] text-gray-400">
          화자 이름을 지정하면 질문·답변 정리가 더 정확해집니다
        </p>
      ) : namePresets.length > 0 ? (
        <p className="text-[11px] text-gray-400">
          참석자 이름을 눌러 화자를 바로 지정할 수 있습니다
        </p>
      ) : null}

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

      {mergeError && (
        <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-md">{mergeError}</p>
      )}
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
  onMergeInto
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
}): React.ReactNode {
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(speaker.display_name ?? '')
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [saving, setSaving] = useState(false)

  const isSelected = mergeFromId === speaker.id

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
    // 같은 프리셋 이름을 이미 다른 화자가 쓰고 있으면 '면접관 2'처럼 번호를 붙인다.
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

      {/* 면접 프리셋 이름 (아직 이름이 없는 화자에만 노출) */}
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
