'use strict'

// Rolling 4-minute memory guard for stressFourHour.js.
//
// Every window records peak and floor physFootprintMB. One hour later (15 windows)
// the floors are compared. A 30% rise on two consecutive windows is a sustained leak.
// Peaks are logged but ignored for the abort: instant replay spikes the peak for a few
// seconds, then returns to the live floor.

const WINDOW_MS = 4 * 60 * 1000
const LOOKBACK_WINDOWS = 15
const RISE_RATIO = 1.3
const STREAK_NEEDED = 2

class MemoryPeakGuard {
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? WINDOW_MS
    this.lookbackWindows = options.lookbackWindows ?? LOOKBACK_WINDOWS
    this.riseRatio = options.riseRatio ?? RISE_RATIO
    this.streakNeeded = options.streakNeeded ?? STREAK_NEEDED
    this.windows = []
    this.windowStart = null
    this.windowPeak = 0
    this.windowFloor = 0
    this.streak = 0
  }

  sample(nowMs, megabytes) {
    const value = Number(megabytes)
    if (!Number.isFinite(value) || value < 0) return null
    if (this.windowStart == null) {
      this.windowStart = nowMs
      this.windowPeak = value
      this.windowFloor = value
      return null
    }
    if (nowMs - this.windowStart >= this.windowMs) {
      const closed = {
        start: this.windowStart,
        peak: this.windowPeak,
        floor: this.windowFloor
      }
      this.windows.push(closed)
      this.windowStart = nowMs
      this.windowPeak = value
      this.windowFloor = value
      return this.compare(closed)
    }
    if (value > this.windowPeak) this.windowPeak = value
    if (value < this.windowFloor) this.windowFloor = value
    return null
  }

  compare(closed) {
    if (this.windows.length <= this.lookbackWindows) return null
    const aged = this.windows[this.windows.length - 1 - this.lookbackWindows]
    if (!aged || !(aged.floor > 0)) {
      this.streak = 0
      return null
    }
    if (closed.floor > aged.floor * this.riseRatio) {
      this.streak += 1
      if (this.streak >= this.streakNeeded) {
        const percent = ((closed.floor / aged.floor - 1) * 100).toFixed(0)
        return (
          `memory leak: ${this.windowMinutes()}min floor ${closed.floor}MB is ${percent}% ` +
          `above ${aged.floor}MB from ${this.lookbackMinutes()}min earlier ` +
          `(peak ${closed.peak}MB)`
        )
      }
      return null
    }
    this.streak = 0
    return null
  }

  windowMinutes() {
    return Math.round(this.windowMs / 60000)
  }

  lookbackMinutes() {
    return Math.round((this.windowMs * this.lookbackWindows) / 60000)
  }
}

module.exports = {
  MemoryPeakGuard,
  WINDOW_MS,
  LOOKBACK_WINDOWS,
  RISE_RATIO,
  STREAK_NEEDED
}
