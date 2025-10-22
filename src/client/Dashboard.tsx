import './Dashboard.css'

import React, { useState } from 'react'

const Dashboard: React.FC = () => {
  const [overrideEnabled, setOverrideEnabled] = useState(false)
  const [overrideBasesEnabled, setOverrideBasesEnabled] = useState(false)
  const [balls, setBalls] = useState(0)
  const [strikes, setStrikes] = useState(0)
  const [outs, setOuts] = useState(0)
  const [ballsSecondary] = useState(0)
  const [strikesSecondary] = useState(0)
  const [outsSecondary] = useState(0)
  const [diamonds, setDiamonds] = useState([
    false,
    false,
    false,
    false,
    false,
    false
  ])

  const incrementBalls = (): void => {
    if (balls < 3) setBalls(balls + 1)
  }

  const decrementBalls = (): void => {
    if (balls > 0) setBalls(balls - 1)
  }

  const incrementStrikes = (): void => {
    if (strikes < 2) setStrikes(strikes + 1)
  }

  const decrementStrikes = (): void => {
    if (strikes > 0) setStrikes(strikes - 1)
  }

  const incrementOuts = (): void => {
    if (outs < 2) setOuts(outs + 1)
  }

  const decrementOuts = (): void => {
    if (outs > 0) setOuts(outs - 1)
  }

  const toggleDiamond = (index: number): void => {
    const newDiamonds = [...diamonds]
    newDiamonds[index] = !newDiamonds[index]
    setDiamonds(newDiamonds)
  }

  const resetBatter = (): void => {
    setBalls(0)
    setStrikes(0)
  }

  const reset = (): void => {
    setBalls(0)
    setStrikes(0)
    setOuts(0)
    setDiamonds([false, false, false, false, false, false])
  }

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
                {balls}
              </div>
              <div
                className={`stat-value-secondary ${!overrideEnabled ? 'green' : ''}`}
              >
                {ballsSecondary}
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
                {strikes}
              </div>
              <div
                className={`stat-value-secondary ${!overrideEnabled ? 'green' : ''}`}
              >
                {strikesSecondary}
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
                {outs}
              </div>
              <div
                className={`stat-value-secondary ${!overrideEnabled ? 'green' : ''}`}
              >
                {outsSecondary}
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
                className={`diamond diamond-readonly ${diamonds[0] ? 'filled' : ''} ${!overrideBasesEnabled ? 'diamond-green' : 'diamond-grey'}`}
              />
            </div>
            <div className="diamond-row">
              <div
                className={`diamond diamond-readonly ${diamonds[1] ? 'filled' : ''} ${!overrideBasesEnabled ? 'diamond-green' : 'diamond-grey'}`}
              />
              <div
                className={`diamond diamond-readonly ${diamonds[2] ? 'filled' : ''} ${!overrideBasesEnabled ? 'diamond-green' : 'diamond-grey'}`}
              />
            </div>
          </div>

          <div className="diamond-set">
            <div className="diamond-row">
              <div
                className={`diamond ${diamonds[3] ? 'filled' : ''} ${!overrideBasesEnabled ? 'diamond-grey' : ''}`}
                onClick={() => {
                  toggleDiamond(3)
                }}
              />
            </div>
            <div className="diamond-row">
              <div
                className={`diamond ${diamonds[4] ? 'filled' : ''} ${!overrideBasesEnabled ? 'diamond-grey' : ''}`}
                onClick={() => {
                  toggleDiamond(4)
                }}
              />
              <div
                className={`diamond ${diamonds[5] ? 'filled' : ''} ${!overrideBasesEnabled ? 'diamond-grey' : ''}`}
                onClick={() => {
                  toggleDiamond(5)
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
