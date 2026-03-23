import { useEffect } from 'react'
import { useCalendarStore } from '../../stores/calendarStore'
import CalendarSettings from './CalendarSettings'
import { format, isAfter, isBefore } from 'date-fns'

export default function CalendarView(): React.ReactNode {
  const { events, status, loading, fetchEvents, fetchStatus, refreshEvents } = useCalendarStore()

  useEffect(() => {
    fetchStatus()
  }, [])

  useEffect(() => {
    if (status.connected) {
      fetchEvents()
    }
  }, [status.connected])

  if (!status.hasCredentials || !status.connected) {
    return <CalendarSettings />
  }

  const now = new Date()

  const getEventTimeDisplay = (event: (typeof events)[0]): string => {
    if (event.allDay) return 'All Day'
    const start = format(new Date(event.start), 'HH:mm')
    const end = format(new Date(event.end), 'HH:mm')
    return `${start} - ${end}`
  }

  const isCurrentEvent = (event: (typeof events)[0]): boolean => {
    if (event.allDay) return true
    return isAfter(now, new Date(event.start)) && isBefore(now, new Date(event.end))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold text-gray-900">
          Today's Schedule ({format(now, 'yyyy-MM-dd')})
        </h3>
        <div className="flex gap-2">
          <button
            onClick={refreshEvents}
            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200"
          >
            Refresh
          </button>
          <button
            onClick={() => fetchStatus()}
            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200"
          >
            Settings
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center text-gray-500 py-12">Loading events...</div>
      ) : events.length === 0 ? (
        <div className="text-center text-gray-400 py-12">No events scheduled for today</div>
      ) : (
        <div className="space-y-3">
          {events.map((event) => (
            <div
              key={event.id}
              className={`border rounded-lg p-4 transition-colors ${
                isCurrentEvent(event)
                  ? 'border-blue-400 bg-blue-50'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-medium text-gray-900">{event.summary}</h4>
                  {event.description && (
                    <p className="text-sm text-gray-500 mt-1 line-clamp-2">
                      {event.description}
                    </p>
                  )}
                  {event.location && (
                    <p className="text-xs text-gray-400 mt-1">{event.location}</p>
                  )}
                </div>
                <div className="text-right">
                  <span className="text-sm font-medium text-gray-700">
                    {getEventTimeDisplay(event)}
                  </span>
                  {isCurrentEvent(event) && (
                    <span className="block text-xs text-blue-600 mt-1">Now</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
