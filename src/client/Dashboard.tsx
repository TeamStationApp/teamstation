import './Dashboard.css'

import React, { useCallback, useEffect, useRef, useState } from 'react'

import {
  asAutoStateMessage,
  type DashboardOverrides,
  WS_RECONNECT_WAIT_MS
} from '../common/types'

const Dashboard: React.FC = () => {
  const [overrideEnabled, setOverrideEnabled] = useState(false)
  const [overrideBasesEnabled, setOverrideBasesEnabled] = useState(false)
  const [overrideBalls, setOverrideBalls] = useState(0)
  const [overrideStrikes, setOverrideStrikes] = useState(0)
  const [overrideOuts, setOverrideOuts] = useState(0)
  const [autoBalls, setAutoBalls] = useState(0)
  const [autoStrikes, setAutoStrikes] = useState(0)
  const [autoOuts, setAutoOuts] = useState(0)
  // Auto bases (left diamonds)
  const [autoBase1, setAutoBase1] = useState(false)
  const [autoBase2, setAutoBase2] = useState(false)
  const [autoBase3, setAutoBase3] = useState(false)
  // Override bases (right diamonds)
  const [overrideBase1, setOverrideBase1] = useState(false)
  const [overrideBase2, setOverrideBase2] = useState(false)
  const [overrideBase3, setOverrideBase3] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  const incrementBalls = (): void => {
    if (overrideBalls < 3) setOverrideBalls(overrideBalls + 1)
  }

  const decrementBalls = (): void => {
    if (overrideBalls > 0) setOverrideBalls(overrideBalls - 1)
  }

  const incrementStrikes = (): void => {
    if (overrideStrikes < 2) setOverrideStrikes(overrideStrikes + 1)
  }

  const decrementStrikes = (): void => {
    if (overrideStrikes > 0) setOverrideStrikes(overrideStrikes - 1)
  }

  const incrementOuts = (): void => {
    if (overrideOuts < 2) setOverrideOuts(overrideOuts + 1)
  }

  const decrementOuts = (): void => {
    if (overrideOuts > 0) setOverrideOuts(overrideOuts - 1)
  }

  const toggleBase1 = (): void => {
    setOverrideBase1(!overrideBase1)
  }

  const toggleBase2 = (): void => {
    setOverrideBase2(!overrideBase2)
  }

  const toggleBase3 = (): void => {
    setOverrideBase3(!overrideBase3)
  }

  const resetBatter = (): void => {
    setOverrideBalls(0)
    setOverrideStrikes(0)
  }

  const reset = (): void => {
    setOverrideBalls(0)
    setOverrideStrikes(0)
    setOverrideOuts(0)
    setOverrideBase1(false)
    setOverrideBase2(false)
    setOverrideBase3(false)
  }

  // Function to send overrides to server
  const sendOverrides = useCallback((): void => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const overrides: DashboardOverrides = {
        overrideCount: undefined,
        overrideBases: undefined
      }

      if (overrideEnabled) {
        overrides.overrideCount = {
          balls: overrideBalls,
          strikes: overrideStrikes,
          outs: overrideOuts
        }
      }

      if (overrideBasesEnabled) {
        overrides.overrideBases = {
          base1: overrideBase1,
          base2: overrideBase2,
          base3: overrideBase3
        }
      }

      wsRef.current.send(JSON.stringify(overrides))
      console.log('Sent overrides:', overrides)
    }
  }, [
    overrideBalls,
    overrideStrikes,
    overrideOuts,
    overrideBase1,
    overrideBase2,
    overrideBase3,
    overrideEnabled,
    overrideBasesEnabled
  ])

  // WebSocket connection with auto-reconnect
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const wsUrl = `${protocol}//${host}/sockets/api/v1/dashboard`

    let reconnectTimeout: NodeJS.Timeout | null = null
    let shouldReconnect = true

    const connect = (): void => {
      console.log('Connecting to Dashboard WebSocket:', wsUrl)
      const ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        console.log('Dashboard WebSocket connected')
      }

      ws.onmessage = event => {
        try {
          const rawData = JSON.parse(event.data)
          const message = asAutoStateMessage(rawData)
          if (message.type === 'autoState' && message.data != null) {
            const autoState = message.data
            console.log(
              'Received autoState:',
              JSON.stringify(autoState, null, 2)
            )

            // Update auto values with autoState
            setAutoBalls(autoState.balls)
            setAutoStrikes(autoState.strikes)
            setAutoOuts(autoState.outs)

            // If not overriding, update override values too
            if (!overrideEnabled) {
              setOverrideBalls(autoState.balls)
              setOverrideStrikes(autoState.strikes)
              setOverrideOuts(autoState.outs)
            }

            // Update auto bases
            setAutoBase1(autoState.base1)
            setAutoBase2(autoState.base2)
            setAutoBase3(autoState.base3)

            // If not overriding, update override bases too
            if (!overrideBasesEnabled) {
              setOverrideBase1(autoState.base1)
              setOverrideBase2(autoState.base2)
              setOverrideBase3(autoState.base3)
            }
          }
        } catch (error) {
          console.error('Error parsing or validating WebSocket message:', error)
        }
      }

      ws.onerror = error => {
        console.error('Dashboard WebSocket error:', error)
      }

      ws.onclose = () => {
        console.log('Dashboard WebSocket disconnected')
        if (shouldReconnect) {
          console.log(`Reconnecting in ${WS_RECONNECT_WAIT_MS}ms...`)
          reconnectTimeout = setTimeout(() => {
            connect()
          }, WS_RECONNECT_WAIT_MS)
        }
      }

      wsRef.current = ws
    }

    connect()

    return () => {
      shouldReconnect = false
      if (reconnectTimeout != null) {
        clearTimeout(reconnectTimeout)
      }
      wsRef.current?.close()
    }
  }, [overrideEnabled, overrideBasesEnabled])

  // Send overrides when values change and override is enabled
  useEffect(() => {
    sendOverrides()
  }, [
    overrideBalls,
    overrideStrikes,
    overrideOuts,
    overrideBase1,
    overrideBase2,
    overrideBase3,
    overrideEnabled,
    overrideBasesEnabled,
    sendOverrides
  ])

  return (
    <div className="dashboard-container">
      <div className="dashboard">
        <div className="override-toggle-container">
          <span className="override-label">Override Count</span>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={overrideEnabled}
              onChange={() => {
                setOverrideEnabled(!overrideEnabled)
              }}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="stats-row">
          <div className="stat-column">
            <div className="stat-label">Balls</div>
            <button
              className={`arrow-button up ${!overrideEnabled ? 'disabled' : ''}`}
              onClick={incrementBalls}
            >
              ▲
            </button>
            <div className="stat-value-container">
              <div
                className={`stat-value ${!overrideEnabled ? 'grayed-out' : ''}`}
              >
                {overrideBalls}
              </div>
              <div
                className={`stat-value-secondary ${!overrideEnabled ? 'green' : ''}`}
              >
                {autoBalls}
              </div>
            </div>
            <button
              className={`arrow-button down ${!overrideEnabled ? 'disabled' : ''}`}
              onClick={decrementBalls}
            >
              ▼
            </button>
          </div>

          <div className="stat-column">
            <div className="stat-label">Strikes</div>
            <button
              className={`arrow-button up ${!overrideEnabled ? 'disabled' : ''}`}
              onClick={incrementStrikes}
            >
              ▲
            </button>
            <div className="stat-value-container">
              <div
                className={`stat-value ${!overrideEnabled ? 'grayed-out' : ''}`}
              >
                {overrideStrikes}
              </div>
              <div
                className={`stat-value-secondary ${!overrideEnabled ? 'green' : ''}`}
              >
                {autoStrikes}
              </div>
            </div>
            <button
              className={`arrow-button down ${!overrideEnabled ? 'disabled' : ''}`}
              onClick={decrementStrikes}
            >
              ▼
            </button>
          </div>

          <div className="stat-column">
            <div className="stat-label">Outs</div>
            <button
              className={`arrow-button up ${!overrideEnabled ? 'disabled' : ''}`}
              onClick={incrementOuts}
            >
              ▲
            </button>
            <div className="stat-value-container">
              <div
                className={`stat-value ${!overrideEnabled ? 'grayed-out' : ''}`}
              >
                {overrideOuts}
              </div>
              <div
                className={`stat-value-secondary ${!overrideEnabled ? 'green' : ''}`}
              >
                {autoOuts}
              </div>
            </div>
            <button
              className={`arrow-button down ${!overrideEnabled ? 'disabled' : ''}`}
              onClick={decrementOuts}
            >
              ▼
            </button>
          </div>
        </div>

        <button className="reset-batter-button" onClick={resetBatter}>
          Reset Batter
        </button>

        <div className="override-toggle-container">
          <span className="override-label">Override Bases</span>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={overrideBasesEnabled}
              onChange={() => {
                setOverrideBasesEnabled(!overrideBasesEnabled)
              }}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="diamonds-container">
          <div className="diamond-set">
            <div className="diamond-row">
              <div
                className={`diamond diamond-readonly ${autoBase2 ? 'filled' : ''} ${!overrideBasesEnabled ? 'diamond-green' : 'diamond-grey'}`}
              />
            </div>
            <div className="diamond-row">
              <div
                className={`diamond diamond-readonly ${autoBase3 ? 'filled' : ''} ${!overrideBasesEnabled ? 'diamond-green' : 'diamond-grey'}`}
              />
              <div
                className={`diamond diamond-readonly ${autoBase1 ? 'filled' : ''} ${!overrideBasesEnabled ? 'diamond-green' : 'diamond-grey'}`}
              />
            </div>
          </div>

          <div className="diamond-set">
            <div className="diamond-row">
              <div
                className={`diamond ${overrideBase2 ? 'filled' : ''} ${!overrideBasesEnabled ? 'diamond-grey' : ''}`}
                onClick={() => {
                  toggleBase2()
                }}
              />
            </div>
            <div className="diamond-row">
              <div
                className={`diamond ${overrideBase3 ? 'filled' : ''} ${!overrideBasesEnabled ? 'diamond-grey' : ''}`}
                onClick={() => {
                  toggleBase3()
                }}
              />
              <div
                className={`diamond ${overrideBase1 ? 'filled' : ''} ${!overrideBasesEnabled ? 'diamond-grey' : ''}`}
                onClick={() => {
                  toggleBase1()
                }}
              />
            </div>
          </div>
        </div>

        <button className="reset-button" onClick={reset}>
          Reset
        </button>
      </div>
    </div>
  )
}

export default Dashboard
