import './Scoreboard.css'

import React, { useEffect, useState } from 'react'

import {
  asScoreState,
  type ScoreState,
  WS_RECONNECT_WAIT_MS
} from '../common/types'

const Scoreboard: React.FC = () => {
  const [scoreState, setScoreState] = useState<ScoreState>({
    pitcherName: 'Not Set',
    batterName: 'Not Set',
    batterNumber: 0,
    batterNumHits: 0,
    batterAtBats: 0,
    numPitches: 0,
    balls: 0,
    strikes: 0,
    outs: 0,
    base1: false,
    base2: false,
    base3: false,
    inning: 0,
    half: 'top',
    teams: { home: '', away: '' },
    scores: { home: 0, away: 0 }
  })

  useEffect(() => {
    // Determine WebSocket URL based on current location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const wsUrl = `${protocol}//${host}/sockets/api/v1/scoreboard`

    let reconnectTimeout: NodeJS.Timeout | null = null
    let shouldReconnect = true

    const connect = (): void => {
      console.log('Connecting to Scoreboard WebSocket:', wsUrl)
      const ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        console.log('Scoreboard WebSocket connected')
      }

      ws.onmessage = event => {
        try {
          const rawData = JSON.parse(event.data)
          const newScoreState: ScoreState = asScoreState(rawData)
          console.log('Received scoreState update:', newScoreState)
          setScoreState(newScoreState)
        } catch (error) {
          console.error('Error parsing or validating WebSocket message:', error)
        }
      }

      ws.onerror = error => {
        console.error('Scoreboard WebSocket error:', error)
      }

      ws.onclose = () => {
        console.log('Scoreboard WebSocket disconnected')
        if (shouldReconnect) {
          console.log(`Reconnecting in ${WS_RECONNECT_WAIT_MS}ms...`)
          reconnectTimeout = setTimeout(() => {
            connect()
          }, WS_RECONNECT_WAIT_MS)
        }
      }
    }

    connect()

    // Cleanup on unmount
    return () => {
      shouldReconnect = false
      if (reconnectTimeout != null) {
        clearTimeout(reconnectTimeout)
      }
    }
  }, [])

  // Additional UI state (not part of ScoreState type)
  // const numPitches = 22
  // const batterNumber = 4

  return (
    <div className="scoreboard-container">
      <div className="scoreboard">
        {/* Top section - Batter on top, Pitcher with pitch count on bottom */}
        <div className="top-section">
          <div className="batter-line">
            <span className="batter-name">{scoreState.batterName}</span>
            <span className="batter-stats">
              {scoreState.batterNumHits}-{scoreState.batterAtBats}
            </span>
          </div>
          <div className="pitcher-line">
            <span className="pitcher-name">{scoreState.pitcherName}</span>
            <span className="pitch-count">P: {scoreState.numPitches}</span>
          </div>
        </div>

        {/* Main content section */}
        <div className="main-section">
          {/* Left: Teams stacked */}
          <div className="teams-stack">
            <div className="team away-team">
              <div className="team-logo">{scoreState.teams.away}</div>
              <div className="team-score">{scoreState.scores.away}</div>
            </div>
            <div className="team home-team">
              <div className="team-logo">{scoreState.teams.home}</div>
              <div className="team-score">{scoreState.scores.home}</div>
            </div>
          </div>

          {/* Center: Inning */}
          <div className="inning-indicator">
            <div
              className={`arrow ${scoreState.half === 'top' ? 'active' : ''}`}
            >
              ▲
            </div>
            <div className="inning-number">{scoreState.inning}</div>
            <div
              className={`arrow ${scoreState.half === 'bottom' ? 'active' : ''}`}
            >
              ▼
            </div>
          </div>

          {/* Right: Count with outs below */}
          <div className="count-outs-section">
            <div className="count-display">
              {scoreState.balls}-{scoreState.strikes}
            </div>
            <div className="outs-display">
              {[1, 2].map(out => (
                <div
                  key={out}
                  className={`out ${out <= scoreState.outs ? 'active' : ''}`}
                />
              ))}
            </div>
          </div>

          {/* Far right: Bases */}
          <div className="bases-display">
            <div className="diamond">
              <div
                className={`base second ${scoreState.base2 ? 'occupied' : ''}`}
              />
              <div className="base-row">
                <div
                  className={`base third ${scoreState.base3 ? 'occupied' : ''}`}
                />
                <div
                  className={`base first ${scoreState.base1 ? 'occupied' : ''}`}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Scoreboard
