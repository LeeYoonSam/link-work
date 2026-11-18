import { useSettingsStore } from '../../stores/settingsStore'
import { SETTINGS_SECTIONS, getSettingsSection, type SettingsSectionId } from './settingsCatalog'
import IntegrationsSection from './sections/IntegrationsSection'
import AiSection from './sections/AiSection'
import AssistantSection from './sections/AssistantSection'
import RecordingSection from './sections/RecordingSection'
import DataSection from './sections/DataSection'

// 설정 화면 (docs/SETTINGS.md). 왼쪽에 섹션 목록(제목과 한 줄 설명), 오른쪽에 고른 섹션.

const SECTION_BODY: Record<SettingsSectionId, () => React.ReactNode> = {
  integrations: IntegrationsSection,
  ai: AiSection,
  assistant: AssistantSection,
  recording: RecordingSection,
  data: DataSection
}

export default function SettingsView(): React.ReactNode {
  const section = useSettingsStore((s) => s.section)
  const setSection = useSettingsStore((s) => s.setSection)
  const meta = getSettingsSection(section)
  const Body = SECTION_BODY[meta.id]

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-52 shrink-0 border-r border-gray-200 p-3 space-y-1 overflow-auto" aria-label="설정 섹션">
        {SETTINGS_SECTIONS.map((s) => {
          const active = s.id === meta.id
          return (
            <button
              key={s.id}
              type="button"
              data-section={s.id}
              aria-current={active ? 'page' : undefined}
              onClick={() => setSection(s.id)}
              className={`w-full text-left px-3 py-2 rounded-md transition-colors ${
                active ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              <span className="block text-sm font-medium">{s.title}</span>
              <span className={`block text-[11px] ${active ? 'text-blue-600/80' : 'text-gray-400'}`}>
                {s.description}
              </span>
            </button>
          )
        })}
      </nav>
      <div className="flex-1 min-w-0 overflow-auto">
        <div className="max-w-2xl p-6" data-settings-panel={meta.id}>
          <h2 className="text-lg font-semibold text-gray-900">{meta.title}</h2>
          <p className="text-xs text-gray-500 mb-4">{meta.description}</p>
          <Body />
        </div>
      </div>
    </div>
  )
}
