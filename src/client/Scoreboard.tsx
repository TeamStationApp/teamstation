import './Scoreboard.css'

import React from 'react'

interface ScoreState {
  pitcherName: string
  batterName: string
  balls: number
  strikes: number
  outs: number
  bases: { 1: boolean; 2: boolean; 3: boolean }
  numPitches: number
  inning: number
  half: 'top' | 'bottom'
  homeTeam: string
  awayTeam: string
  homeScore: number
  awayScore: number
  batterNumber: number
  pitchSpeed: number
}

const Scoreboard: React.FC = () => {
  const scoreState: ScoreState = {
    pitcherName: 'KING',
    batterName: 'SANTANA',
    balls: 0,
    strikes: 2,
    outs: 2,
    bases: { 1: true, 2: false, 3: true },
    numPitches: 22,
    inning: 1,
    half: 'bottom',
    homeTeam: 'Sea  Gulls',
    awayTeam: 'Tierra Santa 1',
    homeScore: 10,
    awayScore: 0,
    batterNumber: 4,
    pitchSpeed: 94
  }

  return (
    <div className="scoreboard-container">
      <div className="scoreboard">
        {/* Top section - Batter on top, Pitcher with pitch count on bottom */}
        <div className="top-section">
          <div className="batter-name">
            {scoreState.batterNumber}. {scoreState.batterName}
          </div>
          <div className="pitcher-line">
            <span className="pitcher-name">P: {scoreState.pitcherName}</span>
            <span className="pitch-count">P: {scoreState.numPitches}</span>
          </div>
        </div>

        {/* Main content section */}
        <div className="main-section">
          {/* Left: Teams stacked */}
          <div className="teams-stack">
            <div className="team away-team">
              <div className="team-logo">{scoreState.awayTeam}</div>
              <div className="team-score">{scoreState.awayScore}</div>
            </div>
            <div className="team home-team">
              <div className="team-logo">{scoreState.homeTeam}</div>
              <div className="team-score">{scoreState.homeScore}</div>
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
