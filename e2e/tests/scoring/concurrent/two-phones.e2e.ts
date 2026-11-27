import { appendFileSync } from 'node:fs'

import { expect } from 'chai'

import type { ConcurrentScoringRig } from '../../../../src/test/concurrentScoring/concurrentScoring'
import { ConcurrentScoringSafariRig } from '../../../../src/test/concurrentScoring/concurrentScoringSafari'
import { fourInnings } from '../../../../src/test/concurrentScoring/game'
import { networkRecovery } from '../../../../src/test/concurrentScoring/networkRecovery'
import {
  defineHarness,
  type HarnessContext,
  type HarnessScenario
} from '../../../core/spec'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'

/**
 * Two scorers in Safari on two physical iPhones and a coach in the runner's
 * browser, on one fresh `concurrent-scoring` game
 * (`src/test/concurrentScoring/README.md`). The network journeys shape
 * each phone's network through its own hub. Each step's evidence goes to
 * `<journey>.log`.
 */

type Journey = (rig: ConcurrentScoringRig, ctx: HarnessContext) => Promise<void>

function journey(name: string, run: Journey): HarnessScenario {
  return async ctx => {
    await clearSignInLimits(ctx)
    const log = ctx.artifact(`${name}.log`)
    const note = (value: unknown): void => {
      appendFileSync(
        log,
        JSON.stringify({ at: new Date().toISOString(), value }) + '\n'
      )
    }
    const rig = new ConcurrentScoringSafariRig(ctx)
    try {
      await run(rig, ctx)
      // Every journey ran on the world it was written for.
      expect(rig.fixture.world).equals('concurrent-scoring')
      note({ status: 'passed', scenario: name, interventions: 0 })
    } catch (error) {
      await rig.capture('failure').catch(() => {})
      note({ status: 'failed', error: String(error) })
      throw error
    }
  }
}

/** The scoring screen draws in 3D: physical iPhones with a GPU. */
const PHONE = { needs: ['ios-phone', 'gpu'], simulator: 'never' } as const

export default defineHarness({
  id: 'scoring/concurrent/two-phones',
  title: 'Two scorers on two iPhones and a coach score one game and agree',
  kind: 'e2e',
  covers: [
    'src/app/scoring/**',
    'src/common/scoring/session.ts',
    'src/server/scoring/**'
  ],
  stack: 'isolated',
  fixtures: ['concurrent-scoring'],
  exclusive: false,
  surfaces: {
    'web-safari-ios': {
      devices: [
        { role: 'scorer-a', ...PHONE, needs: [...PHONE.needs] },
        { role: 'scorer-b', ...PHONE, needs: [...PHONE.needs] }
      ],
      // The coach's window, in the Mac's Chrome.
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 40,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    follow: journey('follow', async rig => {
      await rig.open()
      await rig.hit(1, 'Single')
      await rig.finish(1)
      await rig.boundary(1, 1)
      await rig.pitch(0, 'Ball')
      await rig.agree(0, '1 balls 0 strikes')
      await rig.capture('follow-after')
    }),
    lineups: journey('lineups', async rig => {
      await rig.open()
      await rig.pitch(1, 'Ball')
      await rig.coachChange()
      await rig.converge(1, 'coach reorder after scoring starts')
    }),
    'four-innings': journey('four-innings', async (rig, ctx) => {
      await fourInnings(rig, ctx)
    }),
    // 500 ms each way, 100 ms jitter, 2% loss and a 1 Mbit cap, then one
    // scorer's traffic held while the other authors a newer pitch.
    'network-recovery-older-a': journey(
      'network-recovery-older-a',
      async rig => {
        await networkRecovery(rig, 0)
      }
    ),
    'network-recovery-older-b': journey(
      'network-recovery-older-b',
      async rig => {
        await networkRecovery(rig, 1)
      }
    )
  }
})
