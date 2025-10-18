import './Scoreboard.css'

import React from 'react'

import type { ScoreState } from '../server/types/types'

const Scoreboard: React.FC = () => {
  const scoreState: ScoreState = {
    pitcherName: 'KING',
    batterName: 'SANTANA',
    balls: 0,
    strikes: 2,
    outs: 2,
    bases: { 1: true, 2: false, 3: true },
    inning: 1,
    half: 'bottom',
    teams: {
      home: 'Sea  Gulls',
      away: 'Tierra Santa 1'
    },
    scores: {
      home: 10,
      away: 0
    }
  }

  // Additional UI state (not part of ScoreState type)
  // const numPitches = 22
  // const batterNumber = 4

  return (
    <div className="scoreboard-container">
      <div className="scoreboard">
        {/* Top section - Batter on top, Pitcher with pitch count on bottom */}
        <div className="top-section">
          <div className="batter-name">{scoreState.batterName}</div>
          <div className="pitcher-line">
            <span className="pitcher-name">P: {scoreState.pitcherName}</span>
            <span className="pitch-count" />
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
                className={`base second ${scoreState.bases[2] ? 'occupied' : ''}`}
              />
              <div className="base-row">
                <div
                  className={`base third ${scoreState.bases[3] ? 'occupied' : ''}`}
                />
                <div
                  className={`base first ${scoreState.bases[1] ? 'occupied' : ''}`}
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
