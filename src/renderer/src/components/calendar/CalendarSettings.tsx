import { useState, useEffect } from 'react'
import { useCalendarStore } from '../../stores/calendarStore'

interface Props {
  onBack?: () => void
}

export default function CalendarSettings({ onBack }: Props = {}): React.ReactNode {
  const { status, fetchStatus, connect, disconnect, saveSettings } = useCalendarStore()
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    fetchStatus()
  }, [])

  const handleSaveCredentials = async (): Promise<void> => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError('Client ID and Client Secret are required')
      return
    }
    await saveSettings(clientId.trim(), clientSecret.trim())
    setClientId('')
    setClientSecret('')
    setError('')
  }

  const handleConnect = async (): Promise<void> => {
    setConnecting(true)
    setError('')
    const result = await connect()
    if (!result.success) {
      setError(result.error || 'Failed to connect')
    }
    setConnecting(false)
  }

  const handleDisconnect = async (): Promise<void> => {
    await disconnect()
  }

  const inputClass =
    'w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'

  return (
    <div className="max-w-lg">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Google Calendar Settings</h3>
        {onBack && (
          <button
            onClick={onBack}
            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200"
          >
            ← Back
          </button>
        )}
      </div>

      {status.connected ? (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-green-800">Connected</p>
              <p className="text-sm text-green-600">Google Calendar is linked</p>
            </div>
            <button
              onClick={handleDisconnect}
              className="px-3 py-1.5 text-sm bg-red-50 text-red-600 rounded-md hover:bg-red-100"
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <>
          {!status.hasCredentials && (
            <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
              <h4 className="text-sm font-medium text-gray-700 mb-3">
                Step 1: Enter Google OAuth2 Credentials
              </h4>
              <p className="text-xs text-gray-500 mb-4">
                Create OAuth2 credentials in Google Cloud Console. Set redirect URI to
                http://localhost:8945/callback
              </p>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Client ID
                  </label>
                  <input
                    type="text"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    className={inputClass}
                    placeholder="xxxx.apps.googleusercontent.com"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Client Secret
                  </label>
                  <input
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    className={inputClass}
                    placeholder="Enter client secret"
                  />
                </div>
                <button
                  onClick={handleSaveCredentials}
                  className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700"
                >
                  Save Credentials
                </button>
              </div>
            </div>
          )}

          {status.hasCredentials && (
            <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
              <h4 className="text-sm font-medium text-gray-700 mb-3">
                {status.hasCredentials && !status.connected
                  ? 'Step 2: Connect Your Account'
                  : 'Connect Google Calendar'}
              </h4>
              <p className="text-xs text-gray-500 mb-4">
                Click the button below to authorize access to your Google Calendar.
              </p>
              <button
                onClick={handleConnect}
                disabled={connecting}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {connecting ? 'Connecting...' : 'Connect Google Calendar'}
              </button>
            </div>
          )}
        </>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mt-4">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}
    </div>
  )
}
