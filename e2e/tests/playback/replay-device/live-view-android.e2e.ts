import assert from 'node:assert/strict'

import { defineHarness } from '../../../core/spec'
import { liveView } from './phone-replay.e2e'

/**
 * The live view in the app on an Android phone: the game in progress, opened in
 * its replay while a web scorer in this run's browser throws a ball, a
 * called strike and a foul; each shows on the phone within 2.5 s of the
 * scorer's tap, and its card reads it. `live-<phone>.mp4` is maestro-d's
 * recording of the phone, `live-<phone>.log` the lags.
 */

export default defineHarness({
  id: 'playback/replay-device/live-view-android',
  title:
    'A pitch a web scorer throws shows on the live view in the Android phone’s app within 2.5 s',
  kind: 'e2e',
  covers: ['src/app/replay/**', 'src/app/scoring/ScoringScreen.tsx'],
  stack: 'isolated',
  fixtures: ['replay-games'],
  exclusive: false,
  surfaces: {
    // The phone draws the live view in 3D (gpu): a physical phone, never a
    // simulator. The scorer's browser scores on the 3D field too (gpu).
    'web-chromium': {
      devices: [
        { role: 'device', needs: ['android-phone', 'gpu'], simulator: 'never' }
      ],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: ['teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'three-pitches': async ctx => {
      const lags = await liveView(ctx, 'teamstation-android')
      // Each of the three pitches reached the phone, every one in time.
      assert.equal(lags.length, 3)
      assert.ok(
        lags.every(lag => lag < 2500),
        `lags ${lags.join(', ')} ms`
      )
    }
  }
})
