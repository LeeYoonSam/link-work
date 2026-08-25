import { useEffect, useState } from 'react'
import { useRecognitionAidsStore } from '../../stores/recognitionAidsStore'
import { useProjectStore } from '../../stores/projectStore'
import type { GlossaryEntry, Member } from '../../types'
import { Badge, IconButton, TrashIcon } from '../ui'

type AidsTab = 'glossary' | 'members'

const TABS: { id: AidsTab; label: string }[] = [
  { id: 'glossary', label: '용어집' },
  { id: 'members', label: '구성원' }
]

// 행 안에서 반복되는 입력 스타일. 녹음 컨트롤의 참석 인원 입력과 같은 문법이다.
const input =
  'text-xs px-1.5 py-1 border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:opacity-50'

// 쉼표로 나열한 텍스트 ↔ 문자열 배열. 별칭 입력은 사람이 읽고 쓰는 형태가 쉼표 나열이라
// 저장 직전에만 배열로 바꾼다.
export function parseCsvList(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(',')) {
    const v = raw.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

interface Props {
  onClose?: () => void
  /** 처음 열 탭. 기본 '용어집' */
  initialTab?: AidsTab
}

export default function RecognitionAidsPanel({
  onClose,
  initialTab = 'glossary'
}: Props): React.ReactNode {
  const {
    glossary,
    members,
    loading,
    error,
    fetchAll,
    upsertGlossary,
    removeGlossary,
    importGlossaryText,
    upsertMember,
    removeMember
  } = useRecognitionAidsStore()
  const { projects, fetchProjects } = useProjectStore()

  const [tab, setTab] = useState<AidsTab>(initialTab)

  useEffect(() => {
    void fetchAll()
    void fetchProjects()
  }, [])

  return (
    <div className="px-4 py-3 space-y-2.5">
      {/* 탭 + 닫기 */}
      <div className="flex items-center gap-2">
        <div className="flex bg-gray-100 rounded-md p-0.5 w-fit">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
                tab === t.id
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
              <span className="ml-1.5 tabular-nums text-gray-300">
                {t.id === 'glossary' ? glossary.length : members.length}
              </span>
            </button>
          ))}
        </div>
        {loading && <span className="text-[10px] text-gray-400">불러오는 중…</span>}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-3 py-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            닫기
          </button>
        )}
      </div>

      {/* 저장 위치·용도 고지 — 회사 용어와 실명이 들어가는 화면이라 어디까지 나가는지 밝힌다 */}
      <p className="text-[10px] text-gray-400 leading-relaxed">
        이 정보는 이 기기의 로컬 DB에만 저장되며, 전사 힌트·후보정·AI 요약 프롬프트에 사용됩니다.
      </p>

      {error && (
        <p className="text-xs text-red-500 bg-red-50 px-3 py-2 rounded-md">{error}</p>
      )}

      {tab === 'glossary' ? (
        <GlossaryTab
          entries={glossary}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          onUpsert={upsertGlossary}
          onRemove={removeGlossary}
          onImport={importGlossaryText}
        />
      ) : (
        <MembersTab members={members} onUpsert={upsertMember} onRemove={removeMember} />
      )}
    </div>
  )
}

/* ────────────────────────────── 용어집 ────────────────────────────── */

type UpsertGlossary = (input: {
  id?: number
  term: string
  aliases?: string[]
  note?: string | null
  priority?: number
  enabled?: boolean
  project_id?: number | null
}) => Promise<boolean>

function GlossaryTab({
  entries,
  projects,
  onUpsert,
  onRemove,
  onImport
}: {
  entries: GlossaryEntry[]
  projects: { id: number; name: string }[]
  onUpsert: UpsertGlossary
  onRemove: (id: number) => Promise<boolean>
  onImport: (text: string) => Promise<{ added: number; updated: number; skipped: number } | null>
}): React.ReactNode {
  const [newTerm, setNewTerm] = useState('')
  const [newAliases, setNewAliases] = useState('')
  const [adding, setAdding] = useState(false)
  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{
    added: number
    updated: number
    skipped: number
  } | null>(null)

  const handleAdd = async (): Promise<void> => {
    const term = newTerm.trim()
    if (!term) return
    setAdding(true)
    try {
      const ok = await onUpsert({ term, aliases: parseCsvList(newAliases) })
      if (ok) {
        setNewTerm('')
        setNewAliases('')
      }
    } finally {
      setAdding(false)
    }
  }

  const handleImport = async (): Promise<void> => {
    if (!importText.trim()) return
    setImporting(true)
    try {
      const result = await onImport(importText)
      setImportResult(result)
      if (result) setImportText('')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-2">
      {entries.length === 0 ? (
        <p className="text-xs text-gray-400 py-3 text-center">
          등록된 용어가 없습니다. 자주 잘못 들리는 사내 용어를 넣어 두세요.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((e) => (
            <GlossaryRow
              key={e.id}
              entry={e}
              projects={projects}
              onUpsert={onUpsert}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}

      {/* 추가 입력줄 */}
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={newTerm}
          onChange={(ev) => setNewTerm(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') void handleAdd()
          }}
          placeholder="정답 표기"
          className={`w-32 ${input}`}
        />
        <input
          type="text"
          value={newAliases}
          onChange={(ev) => setNewAliases(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') void handleAdd()
          }}
          placeholder="오인식 표기 (쉼표로 구분)"
          className={`flex-1 ${input}`}
        />
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={adding || newTerm.trim() === ''}
          className="text-xs px-2.5 py-1 rounded-md bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors disabled:opacity-40"
        >
          추가
        </button>
      </div>

      {/* 텍스트 일괄 가져오기 */}
      <div className="pt-2 border-t border-gray-100 space-y-1.5">
        <p className="text-[11px] font-medium text-gray-500">텍스트로 가져오기</p>
        <textarea
          value={importText}
          onChange={(ev) => setImportText(ev.target.value)}
          rows={3}
          placeholder={'LinkWork | 링크워크, 링크웍 | 사내 WBS 앱\n# 앞에 #을 붙이면 주석'}
          className={`w-full resize-y font-mono ${input}`}
        />
        <p className="text-[10px] text-gray-400 leading-relaxed">
          한 줄에 하나씩 · <span className="font-mono">정답 | 별칭1, 별칭2 | 메모</span> · 별칭·메모는
          생략 가능 · <span className="font-mono">#</span>로 시작하는 줄과 빈 줄은 건너뜁니다.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={importing || importText.trim() === ''}
            className="text-xs px-2.5 py-1 rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors disabled:opacity-40"
          >
            {importing ? '가져오는 중…' : '가져오기'}
          </button>
          {importResult && (
            <span className="text-[11px] text-gray-500 tabular-nums">
              추가 {importResult.added} · 갱신 {importResult.updated} · 건너뜀{' '}
              {importResult.skipped}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function GlossaryRow({
  entry,
  projects,
  onUpsert,
  onRemove
}: {
  entry: GlossaryEntry
  projects: { id: number; name: string }[]
  onUpsert: UpsertGlossary
  onRemove: (id: number) => Promise<boolean>
}): React.ReactNode {
  const [term, setTerm] = useState(entry.term)
  const [aliases, setAliases] = useState(entry.aliases.join(', '))
  const [note, setNote] = useState(entry.note ?? '')
  const [priority, setPriority] = useState(String(entry.priority))
  const [saving, setSaving] = useState(false)

  // 텍스트 일괄 가져오기가 같은 term의 별칭을 합쳐 갱신하면 행은 그대로 남고 값만 바뀐다.
  // 그때 입력값이 옛 값에 멈춰 있지 않도록 저장 시각이 바뀌면 다시 읽어온다.
  useEffect(() => {
    setTerm(entry.term)
    setAliases(entry.aliases.join(', '))
    setNote(entry.note ?? '')
    setPriority(String(entry.priority))
  }, [entry.id, entry.updated_at])

  // 한 필드만 고쳐도 행 전체를 upsert한다(계약상 term이 필수).
  const save = async (patch: Partial<Parameters<UpsertGlossary>[0]>): Promise<void> => {
    const trimmed = term.trim()
    // 정답 표기를 비운 채 저장하면 규칙이 무의미해진다 — 되돌린다.
    if (!trimmed) {
      setTerm(entry.term)
      return
    }
    const parsedPriority = parseInt(priority, 10)
    setSaving(true)
    try {
      await onUpsert({
        id: entry.id,
        term: trimmed,
        aliases: parseCsvList(aliases),
        note: note.trim() === '' ? null : note.trim(),
        priority: Number.isNaN(parsedPriority) ? 0 : parsedPriority,
        enabled: entry.enabled === 1,
        project_id: entry.project_id,
        ...patch
      })
    } finally {
      setSaving(false)
    }
  }

  const enabled = entry.enabled === 1

  return (
    <li
      className={`rounded-lg border border-gray-200 bg-white px-2.5 py-2 space-y-1.5 ${
        saving ? 'opacity-60' : ''
      } ${enabled ? '' : 'opacity-70'}`}
    >
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={term}
          onChange={(ev) => setTerm(ev.target.value)}
          onBlur={() => void save({})}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') ev.currentTarget.blur()
          }}
          placeholder="정답 표기"
          title="전사에 남길 올바른 표기"
          className={`w-32 shrink-0 font-medium ${input}`}
        />
        <span className="text-[10px] text-gray-300 shrink-0" title="오인식 표기를 정답 표기로 바로잡습니다">
          ←
        </span>
        <input
          type="text"
          value={aliases}
          onChange={(ev) => setAliases(ev.target.value)}
          onBlur={() => void save({})}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') ev.currentTarget.blur()
          }}
          placeholder="오인식 표기 (쉼표로 구분)"
          title="이렇게 들린 부분을 정답 표기로 바꿉니다"
          className={`flex-1 min-w-0 ${input}`}
        />
        <Badge
          color={enabled ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}
          size="xs"
          title={enabled ? '사용 중 — 눌러서 끕니다' : '꺼짐 — 눌러서 켭니다'}
          onClick={() => void save({ enabled: !enabled })}
        >
          {enabled ? '사용' : '끔'}
        </Badge>
        <IconButton title="용어 삭제" onClick={() => void onRemove(entry.id)} tone="danger">
          <TrashIcon size={13} />
        </IconButton>
      </div>

      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
          onBlur={() => void save({})}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') ev.currentTarget.blur()
          }}
          placeholder="메모 (선택) — 요약이 뜻을 잡는 데 씁니다"
          className={`flex-1 min-w-0 ${input}`}
        />
        <input
          type="number"
          value={priority}
          onChange={(ev) => setPriority(ev.target.value)}
          onBlur={() => void save({})}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') ev.currentTarget.blur()
          }}
          title="우선순위 — 높을수록 전사 힌트에 먼저 들어갑니다"
          className={`w-14 shrink-0 text-center ${input}`}
        />
        <select
          value={entry.project_id ?? ''}
          onChange={(ev) =>
            void save({ project_id: ev.target.value ? Number(ev.target.value) : null })
          }
          title="이 용어를 쓸 범위"
          className={`w-32 shrink-0 bg-white ${input}`}
        >
          <option value="">전역</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
    </li>
  )
}

/* ────────────────────────────── 구성원 ────────────────────────────── */

type UpsertMember = (input: {
  id?: number
  name: string
  aliases?: string[]
  role?: string | null
  enabled?: boolean
  sort_order?: number
}) => Promise<boolean>

function MembersTab({
  members,
  onUpsert,
  onRemove
}: {
  members: Member[]
  onUpsert: UpsertMember
  onRemove: (id: number) => Promise<boolean>
}): React.ReactNode {
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState('')
  const [adding, setAdding] = useState(false)

  const handleAdd = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    setAdding(true)
    try {
      const ok = await onUpsert({
        name,
        role: newRole.trim() === '' ? null : newRole.trim(),
        // 새 구성원은 목록 끝에 붙인다
        sort_order: members.length
      })
      if (ok) {
        setNewName('')
        setNewRole('')
      }
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="space-y-2">
      {members.length === 0 ? (
        <p className="text-xs text-gray-400 py-3 text-center">
          등록된 구성원이 없습니다. 이름을 넣어 두면 참석자·화자 이름에 바로 쓸 수 있습니다.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {members.map((m) => (
            <MemberRow key={m.id} member={m} onUpsert={onUpsert} onRemove={onRemove} />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={newName}
          onChange={(ev) => setNewName(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') void handleAdd()
          }}
          placeholder="이름"
          className={`w-32 ${input}`}
        />
        <input
          type="text"
          value={newRole}
          onChange={(ev) => setNewRole(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') void handleAdd()
          }}
          placeholder="역할 (선택)"
          className={`flex-1 ${input}`}
        />
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={adding || newName.trim() === ''}
          className="text-xs px-2.5 py-1 rounded-md bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors disabled:opacity-40"
        >
          추가
        </button>
      </div>
    </div>
  )
}

function MemberRow({
  member,
  onUpsert,
  onRemove
}: {
  member: Member
  onUpsert: UpsertMember
  onRemove: (id: number) => Promise<boolean>
}): React.ReactNode {
  const [name, setName] = useState(member.name)
  const [aliases, setAliases] = useState(member.aliases.join(', '))
  const [role, setRole] = useState(member.role ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setName(member.name)
    setAliases(member.aliases.join(', '))
    setRole(member.role ?? '')
  }, [member.id, member.updated_at])

  const save = async (patch: Partial<Parameters<UpsertMember>[0]>): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) {
      setName(member.name)
      return
    }
    setSaving(true)
    try {
      await onUpsert({
        id: member.id,
        name: trimmed,
        aliases: parseCsvList(aliases),
        role: role.trim() === '' ? null : role.trim(),
        enabled: member.enabled === 1,
        sort_order: member.sort_order,
        ...patch
      })
    } finally {
      setSaving(false)
    }
  }

  const enabled = member.enabled === 1

  return (
    <li
      className={`flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-2 ${
        saving ? 'opacity-60' : ''
      } ${enabled ? '' : 'opacity-70'}`}
    >
      <input
        type="text"
        value={name}
        onChange={(ev) => setName(ev.target.value)}
        onBlur={() => void save({})}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') ev.currentTarget.blur()
        }}
        placeholder="이름"
        className={`w-28 shrink-0 font-medium ${input}`}
      />
      <input
        type="text"
        value={aliases}
        onChange={(ev) => setAliases(ev.target.value)}
        onBlur={() => void save({})}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') ev.currentTarget.blur()
        }}
        placeholder="호칭·별칭 (쉼표로 구분)"
        title="'김 대리', 영문명처럼 회의에서 불리는 표기"
        className={`flex-1 min-w-0 ${input}`}
      />
      <input
        type="text"
        value={role}
        onChange={(ev) => setRole(ev.target.value)}
        onBlur={() => void save({})}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') ev.currentTarget.blur()
        }}
        placeholder="역할"
        className={`w-24 shrink-0 ${input}`}
      />
      <Badge
        color={enabled ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}
        size="xs"
        title={enabled ? '사용 중 — 눌러서 끕니다' : '꺼짐 — 눌러서 켭니다'}
        onClick={() => void save({ enabled: !enabled })}
      >
        {enabled ? '사용' : '끔'}
      </Badge>
      <IconButton title="구성원 삭제" onClick={() => void onRemove(member.id)} tone="danger">
        <TrashIcon size={13} />
      </IconButton>
    </li>
  )
}
