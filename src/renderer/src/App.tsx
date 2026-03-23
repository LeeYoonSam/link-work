import Sidebar from './components/layout/Sidebar'
import Header from './components/layout/Header'
import ProjectList from './components/project/ProjectList'
import ProjectForm from './components/project/ProjectForm'
import ProjectDetail from './components/project/ProjectDetail'
import Dashboard from './components/dashboard/Dashboard'
import CalendarView from './components/calendar/CalendarView'
import { useProjectStore } from './stores/projectStore'

function App(): React.ReactNode {
  const { view, projectView } = useProjectStore()

  const renderContent = (): React.ReactNode => {
    switch (view) {
      case 'dashboard':
        return <Dashboard />
      case 'projects':
        switch (projectView) {
          case 'list':
            return <ProjectList />
          case 'form':
            return <ProjectForm />
          case 'detail':
            return <ProjectDetail />
          default:
            return <ProjectList />
        }
      case 'calendar':
        return <CalendarView />
      default:
        return <Dashboard />
    }
  }

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-auto p-6">{renderContent()}</main>
      </div>
    </div>
  )
}

export default App
