import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import type { Document, Project, Task } from '../../types'
import { buildNotionExportMarkdown } from '../../utils/notionExport'
import type { ProjectExportData } from '../../utils/notionExport'
import { Badge, EmptyState, XIcon, button, projectStatus } from '../ui'

interface ProjectExportModalProps {
  // 선택 목록에 표시할 프로젝트. 호출부(ProjectList)의 정렬 순서를 그대로 쓴다.
  projects: Project[]
  onClose: () => void
}

// 파일명에 쓸 수 없는 문자를 밑줄로 치환한다 (프로젝트명에 / 등이 섞여 있을 수 있다)
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '프로젝트'
}

export default function ProjectExportModal({
  projects,
  onClose
}: ProjectExportModalProps): React.ReactNode {
  const [step, setStep] = useState<'select' | 'preview'>('select')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [markdown, setMarkdown] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [onClose])

  // 선택된 프로젝트를 목록 표시 순서 그대로 유지한다 (체크한 순서가 아니라 화면 순서)
  const selected = useMemo(
    () => projects.filter((p) => selectedIds.has(p.id)),
    [projects, selectedIds]
  )
  const allSelected = projects.length > 0 && selected.length === projects.length

  const toggle = (id: number): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleAll = (): void => {
    setSelectedIds(allSelected ? new Set() : new Set(projects.map((p) => p.id)))
  }

  const handleGenerate = async (): Promise<void> => {
    if (selected.length === 0) return
    setLoading(true)
    setError(null)
    try {
      const ids = selected.map((p) => p.id)
      const [tasksByProject, allDocuments] = await Promise.all([
        window.api.task.listByProjectIds(ids),
        window.api.document.listAll()
      ])
      const items: ProjectExportData[] = selected.map((project) => ({
        project,
        tasks: (tasksByProject[project.id] ?? []) as Task[],
        documents: allDocuments.filter((d: Document) => d.project_id === project.id)
      }))
      setMarkdown(buildNotionExportMarkdown(items))
      setCopied(false)
      setSavedPath(null)
      setStep('preview')
    } catch (e) {
      setError(e instanceof Error ? e.message : '마크다운 생성에 실패했습니다')
    } finally {
      setLoading(false)
    }
  }

  const handleBack = (): void => {
    setStep('select')
    setError(null)
    setCopied(false)
    setSavedPath(null)
  }

  const handleCopy = async (): Promise<void> => {
    await navigator.clipboard.writeText(markdown)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleSave = async (): Promise<void> => {
    const fileName =
      selected.length === 1
        ? `${sanitizeFileName(selected[0].name)}-작업로그.md`
        : `프로젝트-작업로그-${format(new Date(), 'yyyyMMdd')}.md`
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.export.saveMarkdown(markdown, fileName)
      if (result.canceled) return
      if (result.success) {
        setSavedPath(result.path ?? null)
      } else {
        setError(result.error ?? '파일 저장에 실패했습니다')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '파일 저장에 실패했습니다')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h3 className="text-base font-semibold text-gray-900">프로젝트 내보내기</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              {step === 'select'
                ? '노션 작업 로그로 내보낼 프로젝트를 선택하세요'
                : '아래 마크다운을 복사하거나 .md 파일로 저장하세요'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-700 transition-colors"
            title="닫기"
          >
            <XIcon size={16} />
          </button>
        </div>

        {step === 'select' ? (
          <>
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-gray-50">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = selected.length > 0 && !allSelected
                  }}
                  onChange={toggleAll}
                  disabled={projects.length === 0}
                  className="w-4 h-4 accent-blue-600"
                />
                전체 선택
              </label>
              <span className="text-xs text-gray-500">
                {selected.length}/{projects.length} 선택됨
              </span>
            </div>

            <div className="flex-1 overflow-auto px-6 py-2">
              {projects.length === 0 ? (
                <EmptyState>내보낼 프로젝트가 없습니다</EmptyState>
              ) : (
                <div className="divide-y divide-gray-100">
                  {projects.map((project) => (
                    <label
                      key={project.id}
                      className="flex items-center gap-3 py-2.5 cursor-pointer hover:bg-gray-50 -mx-2 px-2 rounded-md transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(project.id)}
                        onChange={() => toggle(project.id)}
                        className="w-4 h-4 accent-blue-600 shrink-0"
                      />
                      <span className="flex-1 min-w-0 text-sm text-gray-900 truncate">
                        {project.name}
                      </span>
                      <span className="text-xs text-green-700 shrink-0">
                        {format(new Date(project.dev_start_date), 'MM/dd')} ~{' '}
                        {format(new Date(project.dev_end_date), 'MM/dd')}
                      </span>
                      <Badge color={projectStatus[project.status].badge} size="xs">
                        {projectStatus[project.status].label}
                      </Badge>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-200">
              <span className="text-xs text-red-600">{error}</span>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={onClose} className={`px-4 py-2 text-sm ${button.subtle}`}>
                  취소
                </button>
                <button
                  onClick={() => void handleGenerate()}
                  disabled={selected.length === 0 || loading}
                  className={`px-4 py-2 text-sm disabled:opacity-40 ${button.primary}`}
                >
                  {loading ? '불러오는 중...' : '마크다운 생성'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex-1 overflow-auto px-6 py-4">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-md p-3 max-h-[55vh] overflow-auto">
                {markdown}
              </pre>
            </div>

            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-200">
              <div className="min-w-0 text-xs">
                {error ? (
                  <span className="text-red-600 break-all">{error}</span>
                ) : savedPath ? (
                  <span className="text-gray-500 break-all">저장됨 — {savedPath}</span>
                ) : null}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={handleBack} className={`px-4 py-2 text-sm ${button.subtle}`}>
                  ← 다시 선택
                </button>
                <button
                  onClick={() => void handleCopy()}
                  className={`px-4 py-2 text-sm ${button.subtle}`}
                >
                  {copied ? '복사됨' : '클립보드 복사'}
                </button>
                <button
                  onClick={() => void handleSave()}
                  disabled={loading}
                  className={`px-4 py-2 text-sm disabled:opacity-40 ${button.primary}`}
                >
                  {loading ? '저장 중...' : '.md 저장'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
