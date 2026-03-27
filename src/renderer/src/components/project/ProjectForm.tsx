import { useState, useEffect } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import type { ProjectInput } from '../../types'

export default function ProjectForm(): React.ReactNode {
  const { editingProject, createProject, updateProject, setProjectView } = useProjectStore()

  const [form, setForm] = useState<ProjectInput>({
    name: '',
    description: '',
    dev_start_date: '',
    dev_end_date: '',
    qa_start_date: '',
    qa_end_date: '',
    deploy_date: '',
    deploy_version: '',
    status: 'scheduled',
    status_manual: 0
  })

  useEffect(() => {
    if (editingProject) {
      setForm({
        name: editingProject.name,
        description: editingProject.description || '',
        dev_start_date: editingProject.dev_start_date,
        dev_end_date: editingProject.dev_end_date,
        qa_start_date: editingProject.qa_start_date,
        qa_end_date: editingProject.qa_end_date,
        deploy_date: editingProject.deploy_date,
        deploy_version: editingProject.deploy_version || '',
        status: editingProject.status,
        status_manual: editingProject.status_manual
      })
    } else {
      window.api.project.lastDates().then(async (last) => {
        if (last) {
          const dates = await window.api.project.calculateDates(last.devEndDate)
          setForm((prev) => ({
            ...prev,
            dev_start_date: last.devStartDate,
            dev_end_date: last.devEndDate,
            qa_start_date: dates.qaStart,
            qa_end_date: dates.qaEnd,
            deploy_date: dates.deployDate
          }))
        }
      })
    }
  }, [editingProject])

  const handleDevEndDateChange = async (devEndDate: string): Promise<void> => {
    setForm((prev) => ({ ...prev, dev_end_date: devEndDate }))
    if (devEndDate) {
      const dates = await window.api.project.calculateDates(devEndDate)
      setForm((prev) => ({
        ...prev,
        dev_end_date: devEndDate,
        qa_start_date: dates.qaStart,
        qa_end_date: dates.qaEnd,
        deploy_date: dates.deployDate
      }))
    }
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!form.name || !form.dev_start_date || !form.dev_end_date) return

    if (editingProject) {
      await updateProject(editingProject.id, form)
    } else {
      await createProject(form)
    }
  }

  const inputClass =
    'w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
  const labelClass = 'block text-sm font-medium text-gray-700 mb-1'

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold text-gray-900">
          {editingProject ? 'Edit Project' : 'New Project'}
        </h3>
        <button
          onClick={() => setProjectView('list')}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Cancel
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className={labelClass}>Project Name *</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputClass}
            placeholder="Enter project name"
            required
          />
        </div>

        <div>
          <label className={labelClass}>Description</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className={inputClass}
            rows={3}
            placeholder="Project description (optional)"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Dev Start Date *</label>
            <input
              type="date"
              value={form.dev_start_date}
              onChange={(e) => setForm({ ...form, dev_start_date: e.target.value })}
              className={inputClass}
              required
            />
          </div>
          <div>
            <label className={labelClass}>Dev End Date *</label>
            <input
              type="date"
              value={form.dev_end_date}
              onChange={(e) => handleDevEndDateChange(e.target.value)}
              className={inputClass}
              required
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>
              QA Start <span className="text-gray-400 text-xs">(auto)</span>
            </label>
            <input
              type="date"
              value={form.qa_start_date}
              onChange={(e) => setForm({ ...form, qa_start_date: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>
              QA End <span className="text-gray-400 text-xs">(auto)</span>
            </label>
            <input
              type="date"
              value={form.qa_end_date}
              onChange={(e) => setForm({ ...form, qa_end_date: e.target.value })}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>
              Deploy Date <span className="text-gray-400 text-xs">(auto)</span>
            </label>
            <input
              type="date"
              value={form.deploy_date}
              onChange={(e) => setForm({ ...form, deploy_date: e.target.value })}
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label className={labelClass}>
            Deploy Version <span className="text-gray-400 text-xs">(optional)</span>
          </label>
          <input
            type="text"
            value={form.deploy_version}
            onChange={(e) => setForm({ ...form, deploy_version: e.target.value })}
            className={inputClass}
            placeholder="e.g. 4.142.0"
          />
        </div>

        {editingProject && (
          <div>
            <label className={labelClass}>Status</label>
            <div className="flex items-center gap-3">
              <select
                value={form.status_manual ? form.status : 'auto'}
                onChange={(e) => {
                  if (e.target.value === 'auto') {
                    setForm({ ...form, status_manual: 0 })
                  } else {
                    setForm({ ...form, status: e.target.value, status_manual: 1 })
                  }
                }}
                className={inputClass}
              >
                <option value="auto">Auto (날짜 기반 자동)</option>
                <option value="scheduled">Scheduled</option>
                <option value="development">Development</option>
                <option value="qa">QA</option>
                <option value="deploy">Deploy</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
              {form.status_manual === 1 && (
                <span className="text-xs text-amber-600 whitespace-nowrap">수동 설정됨</span>
              )}
            </div>
          </div>
        )}

        <div className="pt-4 flex gap-3">
          <button
            type="submit"
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors"
          >
            {editingProject ? 'Update Project' : 'Create Project'}
          </button>
          <button
            type="button"
            onClick={() => setProjectView('list')}
            className="px-4 py-2 bg-gray-100 text-gray-700 text-sm rounded-md hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
