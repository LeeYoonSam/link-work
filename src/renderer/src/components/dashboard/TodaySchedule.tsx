import { format, isAfter, isBefore } from 'date-fns'
import type { CalendarEvent } from '../../stores/calendarStore'

interface Props {
  events: CalendarEvent[]
  connected: boolean
}

export default function TodaySchedule({ events, connected }: Props): React.ReactNode {
  if (!connected) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-6 text-center">
        <p className="text-gray-400 text-sm">
          Connect Google Calendar to view today's schedule
        </p>
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-6 text-center">
        <p className="text-gray-400 text-sm">No events scheduled for today</p>
      </div>
    )
  }

  const now = new Date()

  const isCurrentEvent = (event: CalendarEvent): boolean => {
    if (event.allDay) return true
    return isAfter(now, new Date(event.start)) && isBefore(now, new Date(event.end))
  }

  const getTimeDisplay = (event: CalendarEvent): string => {
    if (event.allDay) return 'All Day'
    const start = format(new Date(event.start), 'HH:mm')
    const end = format(new Date(event.end), 'HH:mm')
    return `${start} - ${end}`
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
      {events.map((event) => (
        <div
          key={event.id}
          className={`flex items-center gap-4 px-4 py-3 ${
            isCurrentEvent(event) ? 'bg-blue-50' : ''
          }`}
        >
          <div className="w-20 text-right">
            <span
              className={`text-sm font-medium ${
                isCurrentEvent(event) ? 'text-blue-600' : 'text-gray-500'
              }`}
            >
              {getTimeDisplay(event)}
            </span>
          </div>
          <div
            className={`w-0.5 h-8 rounded-full ${
              isCurrentEvent(event) ? 'bg-blue-500' : 'bg-gray-300'
            }`}
          />
          <div className="flex-1">
            <p
              className={`text-sm font-medium ${
                isCurrentEvent(event) ? 'text-blue-900' : 'text-gray-800'
              }`}
            >
              {event.summary}
            </p>
            {event.location && (
              <p className="text-xs text-gray-400">{event.location}</p>
            )}
          </div>
          {isCurrentEvent(event) && (
            <span className="text-xs font-medium text-blue-600 bg-blue-100 px-2 py-0.5 rounded-full">
              Now
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
