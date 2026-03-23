import type { Project } from '../../types'
import { format } from 'date-fns'

type UrgencyLevel = 'early' | 'mid' | 'late'

function calculateProgress(startDate: string, endDate: string): number {
  const start = new Date(startDate)
  const end = new Date(endDate)
  const today = new Date()

  const total = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
  if (total <= 0) return 100

  const elapsed = Math.ceil((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
  if (elapsed < 0) return 0

  return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)))
}

function getUrgencyLevel(progress: number): UrgencyLevel {
  if (progress <= 33) return 'early'
  if (progress <= 66) return 'mid'
  return 'late'
}

const urgencyConfig: Record<UrgencyLevel, { bg: string; bar: string; text: string; label: string }> = {
  early: { bg: 'bg-green-50', bar: 'bg-green-500', text: 'text-green-700', label: 'Early' },
  mid: { bg: 'bg-blue-50', bar: 'bg-blue-500', text: 'text-blue-700', label: 'Mid' },
  late: { bg: 'bg-red-50', bar: 'bg-red-500', text: 'text-red-700', label: 'Late' }
}

interface Props {
  project: Project
}

export default function ProjectProgress({ project }: Props): React.ReactNode {
  const progress = calculateProgress(project.dev_start_date, project.deploy_date)
  const level = getUrgencyLevel(progress)
  const config = urgencyConfig[level]

  return (
    <div className={`border rounded-lg p-4 ${config.bg} border-gray-200`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="font-semibold text-gray-900">{project.name}</h4>
          <div className="flex gap-3 text-xs text-gray-500 mt-1">
            <span>
              Dev: {format(new Date(project.dev_start_date), 'MM/dd')} ~{' '}
              {format(new Date(project.dev_end_date), 'MM/dd')}
            </span>
            <span>Deploy: {format(new Date(project.deploy_date), 'MM/dd')}</span>
          </div>
        </div>
        <div className="text-right">
          <span className={`text-2xl font-bold ${config.text}`}>{progress}%</span>
          <span
            className={`block text-xs font-medium px-2 py-0.5 rounded-full mt-1 ${config.bar} text-white`}
          >
            {config.label}
          </span>
        </div>
      </div>

      <div className="w-full bg-gray-200 rounded-full h-2.5">
        <div
          className={`h-2.5 rounded-full transition-all duration-500 ${config.bar}`}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
}
