import { useState } from 'react'
import { useRecordingStore } from '../../stores/recordingStore'
import type { MeetingSpeaker } from '../../types'
import { IconButton, TrashIcon } from '../ui'

interface Props {
  speakers: MeetingSpeaker[]
  meetingId: number
}

const PRESET_COLORS = [
  '#4F8EF7', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
  '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6B7280'
]

export default function SpeakerEditor({ speakers, meetingId }: Props): React.ReactNode {
  const { updateSpeaker, mergeSpeakers, refreshCurrent } = useRecordingStore()
  const [mergeFrom, setMergeFrom] = useState<number | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)

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

      <ul className="space-y-2">
        {speakers.map((spk) => (
          <SpeakerRow
            key={spk.id}
            speaker={spk}
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
  mergeFromId,
  isMergeTarget,
  mergeBusy,
  onUpdate,
  onSelectMergeFrom,
  onMergeInto
}: {
  speaker: MeetingSpeaker
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
