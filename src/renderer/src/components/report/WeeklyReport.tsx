import { useEffect } from 'react'
import { useReportStore } from '../../stores/reportStore'
import { format, endOfWeek, isThisWeek } from 'date-fns'
import { ko } from 'date-fns/locale'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell
} from 'recharts'

const ENTITY_LABELS: Record<string, string> = {
  project: 'Project',
  task: 'Task',
  document: 'Document',
  variable: 'Variable',
  memo: 'Memo'
}

const ACTION_LABELS: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  archive: 'Archived',
  restore: 'Restored',
  complete: 'Completed'
}

const ENTITY_COLORS: Record<string, string> = {
  project: '#6366f1',
  task: '#f59e0b',
  document: '#10b981',
  variable: '#8b5cf6',
  memo: '#ec4899',
  todo: '#0ea5e9'
}

const ACTION_COLORS: Record<string, string> = {
  create: '#10b981',
  update: '#3b82f6',
  delete: '#ef4444',
  archive: '#f59e0b',
  restore: '#8b5cf6',
  complete: '#14b8a6'
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function WeeklyReport(): React.ReactNode {
  const {
    activities, summary, dailyStats, currentWeekStart, loading,
    fetchWeeklyData, goToPreviousWeek, goToNextWeek, goToCurrentWeek
  } = useReportStore()

  useEffect(() => {
    fetchWeeklyData()
  }, [currentWeekStart, fetchWeeklyData])

  const weekEnd = endOfWeek(currentWeekStart, { weekStartsOn: 1 })
  const weekLabel = `${format(currentWeekStart, 'M/d', { locale: ko })} - ${format(weekEnd, 'M/d', { locale: ko })}`
  const isCurrentWeek = isThisWeek(currentWeekStart, { weekStartsOn: 1 })

  // 일별 차트 데이터 변환
  const dailyChartData = DAY_LABELS.map((day, i) => {
    const targetDate = new Date(currentWeekStart)
    targetDate.setDate(targetDate.getDate() + i)
    const dateStr = format(targetDate, 'yyyy-MM-dd')

    const entry: Record<string, string | number> = { name: day }
    for (const stat of dailyStats) {
      if (stat.date === dateStr) {
        entry[stat.entity_type] = (entry[stat.entity_type] as number || 0) + stat.count
      }
    }
    return entry
  })

  // 엔티티별 합계 (파이 차트용)
  const entityTotals = Object.entries(
    summary.reduce<Record<string, number>>((acc, s) => {
      acc[s.entity_type] = (acc[s.entity_type] || 0) + s.count
      return acc
    }, {})
  ).map(([name, value]) => ({ name: ENTITY_LABELS[name] || name, value, color: ENTITY_COLORS[name] || '#94a3b8' }))

  // 액션별 합계 (파이 차트용)
  const actionTotals = Object.entries(
    summary.reduce<Record<string, number>>((acc, s) => {
      acc[s.action] = (acc[s.action] || 0) + s.count
      return acc
    }, {})
  ).map(([name, value]) => ({ name: ACTION_LABELS[name] || name, value, color: ACTION_COLORS[name] || '#94a3b8' }))

  const totalActivities = summary.reduce((sum, s) => sum + s.count, 0)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900">Weekly Report</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={goToPreviousWeek}
            className="px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            &#8592;
          </button>
          <span className="px-4 py-1.5 text-sm font-medium bg-white border border-gray-300 rounded-lg min-w-[140px] text-center">
            {weekLabel}
          </span>
          <button
            onClick={goToNextWeek}
            className="px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            &#8594;
          </button>
          {!isCurrentWeek && (
            <button
              onClick={goToCurrentWeek}
              className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              Today
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64 text-gray-400">Loading...</div>
      ) : (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-5 gap-4">
            {(['project', 'task', 'document', 'variable', 'memo'] as const).map((type) => {
              const count = summary
                .filter((s) => s.entity_type === type)
                .reduce((sum, s) => sum + s.count, 0)
              return (
                <div key={type} className="bg-white rounded-xl border border-gray-200 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: ENTITY_COLORS[type] }} />
                    <span className="text-sm text-gray-500">{ENTITY_LABELS[type]}</span>
                  </div>
                  <div className="text-2xl font-bold text-gray-900">{count}</div>
                  <div className="text-xs text-gray-400">changes</div>
                </div>
              )
            })}
          </div>

          {/* Charts Row */}
          <div className="grid grid-cols-3 gap-4">
            {/* Daily Activity Bar Chart */}
            <div className="col-span-2 bg-white rounded-xl border border-gray-200 p-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Daily Activity</h3>
              {totalActivities === 0 ? (
                <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
                  No activity this week
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={dailyChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Legend />
                    {Object.entries(ENTITY_COLORS).map(([key, color]) => (
                      <Bar key={key} dataKey={key} name={ENTITY_LABELS[key]} fill={color} stackId="a" radius={[2, 2, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Pie Charts */}
            <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">By Type</h3>
                {entityTotals.length === 0 ? (
                  <div className="flex items-center justify-center h-24 text-gray-400 text-xs">No data</div>
                ) : (
                  <ResponsiveContainer width="100%" height={120}>
                    <PieChart>
                      <Pie data={entityTotals} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={45} innerRadius={25}>
                        {entityTotals.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">By Action</h3>
                {actionTotals.length === 0 ? (
                  <div className="flex items-center justify-center h-24 text-gray-400 text-xs">No data</div>
                ) : (
                  <ResponsiveContainer width="100%" height={120}>
                    <PieChart>
                      <Pie data={actionTotals} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={45} innerRadius={25}>
                        {actionTotals.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          {/* Activity Log Table */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">
              Activity Log ({activities.length})
            </h3>
            {activities.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">
                No activity recorded this week
              </div>
            ) : (
              <div className="overflow-auto max-h-80">
                <table className="w-full text-sm">
                  <thead className="text-gray-500 border-b border-gray-100">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium">Time</th>
                      <th className="text-left py-2 px-3 font-medium">Type</th>
                      <th className="text-left py-2 px-3 font-medium">Action</th>
                      <th className="text-left py-2 px-3 font-medium">Name</th>
                      <th className="text-left py-2 px-3 font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activities.map((log) => (
                      <tr key={log.id} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="py-2 px-3 text-gray-400 whitespace-nowrap">
                          {format(new Date(log.created_at), 'M/d HH:mm')}
                        </td>
                        <td className="py-2 px-3">
                          <span
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium text-white"
                            style={{ backgroundColor: ENTITY_COLORS[log.entity_type] || '#94a3b8' }}
                          >
                            {ENTITY_LABELS[log.entity_type] || log.entity_type}
                          </span>
                        </td>
                        <td className="py-2 px-3">
                          <span
                            className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium text-white"
                            style={{ backgroundColor: ACTION_COLORS[log.action] || '#94a3b8' }}
                          >
                            {ACTION_LABELS[log.action] || log.action}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-gray-700 max-w-[200px] truncate">
                          {log.entity_name || '-'}
                        </td>
                        <td className="py-2 px-3 text-gray-400 max-w-[200px] truncate">
                          {log.details || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
