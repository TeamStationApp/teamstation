import { appendFileSync } from 'node:fs'

import { expect } from 'chai'

import { ConcurrentScoringRig } from '../../../../src/test/concurrentScoring/concurrentScoring'
import { conflictingPitches } from '../../../../src/test/concurrentScoring/conflicts'
import { fourInnings } from '../../../../src/test/concurrentScoring/game'
import { pendingStretch } from '../../../../src/test/concurrentScoring/pending'
import { staleTail } from '../../../../src/test/concurrentScoring/staleTail'
import { remoteUpdates } from '../../../../src/test/concurrentScoring/updates'
import {
  defineHarness,
  type HarnessContext,
  type HarnessScenario
} from '../../../core/spec'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'

/**
 * Two scorers and a coach on one game at once, each in a browser of its own
 * on the runner's machine (`src/test/concurrentScoring/README.md` describes
 * each journey). Every journey starts on a fresh `concurrent-scoring`
 * game; it stops on the first failure and never reloads a scorer or
 * retries a scoring action. Each step's evidence goes to `<journey>.log`.
 */

type Journey = (rig: ConcurrentScoringRig, ctx: HarnessContext) => Promise<void>

/** The rig on `ctx`, `journey` run on it, its evidence logged and its screens kept on failure. */
function journey(
  name: string,
  run: Journey,
  size?: (asked: { width: number; height: number }) => {
    width: number
    height: number
  }
): HarnessScenario {
  return async ctx => {
    await clearSignInLimits(ctx)
    const log = ctx.artifact(`${name}.log`)
    const note = (value: unknown): void => {
      appendFileSync(
        log,
        JSON.stringify({ at: new Date().toISOString(), value }) + '\n'
      )
    }
    const sized: HarnessContext =
      size == null
        ? ctx
        : {
            ...ctx,
            browser: async (asked, emulation) =>
              await ctx.browser(size(asked), emulation)
          }
    const rig = new ConcurrentScoringRig(sized)
    try {
      await run(rig, sized)
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

/** The short unfinished single, then the scorer handoff. */
const follow: Journey = async rig => {
  await rig.open()
  await rig.hit(1, 'Single')
  await rig.finish(1)
  await rig.boundary(1, 1)
  await rig.pitch(0, 'Ball')
  await rig.agree(0, '1 balls 0 strikes')
  await rig.capture('follow-after')
}

/** The coach reorders the lineup after scoring starts. */
const lineups: Journey = async rig => {
  await rig.open()
  await rig.pitch(1, 'Ball')
  await rig.coachChange()
  await rig.converge(1, 'coach reorder after scoring starts')
}

const conflicts =
  (older: 0 | 1, first: 0 | 1): Journey =>
  async rig => {
    await conflictingPitches(rig, older, first)
  }

export default defineHarness({
  id: 'scoring/concurrent/two-browsers',
  title: 'Two scorers and a coach score one game at once and agree',
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
    // The scoring screen draws in 3D: the Mac's Chrome, with its GPU.
    'web-chromium': {
      devices: [],
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
    follow: journey('follow', follow),
    lineups: journey('lineups', lineups),
    'four-innings': journey('four-innings', async (rig, ctx) => {
      await fourInnings(rig, ctx)
    }),
    updates: journey('updates', async rig => {
      await remoteUpdates(rig)
    }),
    // The short mobile-web window: the phones' 393 wide, 620 tall.
    'updates-short-window': journey(
      'updates-short-window',
      async rig => {
        await remoteUpdates(rig)
      },
      asked => (asked.width === 393 ? { ...asked, height: 620 } : asked)
    ),
    'stale-tail': journey('stale-tail', async rig => {
      await staleTail(rig)
    }),
    'pending-stretch': journey('pending-stretch', async rig => {
      await pendingStretch(rig)
    }),
    // Each of the four orders: who scored first, whose save landed first.
    'conflicts-older-a-first-a': journey(
      'conflicts-older-a-first-a',
      conflicts(0, 0)
    ),
    'conflicts-older-a-first-b': journey(
      'conflicts-older-a-first-b',
      conflicts(0, 1)
    ),
    'conflicts-older-b-first-a': journey(
      'conflicts-older-b-first-a',
      conflicts(1, 0)
    ),
    'conflicts-older-b-first-b': journey(
      'conflicts-older-b-first-b',
      conflicts(1, 1)
    )
  }
})
