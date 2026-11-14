import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ScoringAction } from '../../common/scoring/actions'
import { applyAction } from '../../common/scoring/session'
import { fixture, panel, render, timing } from './remoteScoringFixture.test'

/**
 * What one remote pitch costs the panel late in a long game: run by
 * `node scripts/profile-remote-log.mjs` (TS_REMOTE_LOG_PROFILE=1), which
 * prints one JSON line per sample. Skipped in the ordinary unit run.
 */
const profiling = process.env.TS_REMOTE_LOG_PROFILE === '1'
const atBats = Number(process.env.TS_REMOTE_LOG_AT_BATS ?? 100)

describe('remote log profile', () => {
  ;(profiling ? it : it.skip)(
    `measures each remote pitch over ${atBats} at-bats`,
    async function () {
      this.timeout(600_000)
      const gc = (globalThis as { gc?: () => void }).gc
      const f = fixture(true)
      await render(f.game)
      const strike: ScoringAction = { type: 'pitch', call: 'C' }
      const flow: ScoringAction[] = [
        { type: 'gameFlow', kind: 'closePlay' },
        { type: 'gameFlow', kind: 'endHalf' }
      ]
      let completed = 0
      let sequence = 0
      const samples: Array<{
        atBat: number
        ms: number
        subscriberMs: number
        heap: number
      }> = []
      while (completed < atBats) {
        const state = f.game.state
        const before =
          state.liveData.plays.currentPlay?.about.atBatIndex ?? completed
        let action: ScoringAction = strike
        if (applyAction(state, strike).problems.length > 0) {
          const next = flow.find(
            candidate => applyAction(state, candidate).problems.length === 0
          )
          if (next == null) break
          action = next
        }
        const started = performance.now()
        await f.update(`profile-${sequence++}`, 'other', [action])
        const ms = performance.now() - started
        const after =
          f.game.state.liveData.plays.currentPlay?.about.atBatIndex ?? before
        if (after !== before) completed++
        if (completed % 10 === 0 && action === strike) {
          gc?.()
          samples.push({
            atBat: completed,
            ms: Math.round(ms * 100) / 100,
            subscriberMs: Math.round(timing.lastNotifyMs * 100) / 100,
            heap: process.memoryUsage().heapUsed
          })
        }
      }
      for (const sample of samples) console.log(JSON.stringify(sample))
      expect(panel()).not.equals(null)
      expect(completed).equals(atBats)
    }
  )
})
