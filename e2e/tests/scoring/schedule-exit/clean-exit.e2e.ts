import { strict as assert } from 'node:assert'

import { BlockedError } from '../../../core/result'
import { defineHarness } from '../../../core/spec'
import { stackSql } from '../../../rigs/coach/coachApp'
import { SCORER_ROLE, textOf } from '../../../rigs/scoring/scorerSheets'
import { beginRoster, type Roster } from '../roster-edit/player-settings.e2e'

/**
 * Leaving scoring from Schedule, on Safari on an iPhone and in the develop
 * app on one: Exit Current Game, twice, brings Schedule back to its list
 * with no scoring screen left behind; a save the server refuses keeps the
 * scorer on scoring when Exit is cancelled, and Discard and Exit returns
 * Schedule to its list.
 */

/** The upcoming game's row on Schedule: the world's Owls at Hawks. */
const GAME_LABEL = '.*Owls.*'

async function tab(run: Roster, label: string): Promise<void> {
  const { s } = run
  await s.shown(`^${label}$`, 15000)
  const target = (await s.nodes())
    .filter(node => textOf(node) === label && node.bounds != null)
    .sort((a, b) => b.bounds!.y - a.bounds!.y)[0]?.bounds
  assert(target != null, `The ${label} tab is there`)
  await s.point(target.x + target.width / 2, target.y + target.height / 2)
}

async function enter(run: Roster): Promise<void> {
  const { m } = run.s
  await run.s.shown('^Upcoming$', 15000)
  await m.tapOn({ text: GAME_LABEL, timeout: 15000 })
  await m.tapOn({ text: '^Score$', timeout: 15000 })
  await m.tapOn({ text: '^Full game scoring$', timeout: 15000 })
  await run.s.shown('^Open scoring menu$', 15000)
}

async function exit(run: Roster): Promise<void> {
  await run.s.m.tapOn({ text: '^Open scoring menu$', timeout: 15000 })
  await run.s.m.tapOn({ text: '^Exit Current Game$', timeout: 15000 })
}

async function revisit(run: Roster): Promise<void> {
  await tab(run, 'Videos')
  await tab(run, 'Schedule')
}

async function schedule(run: Roster): Promise<void> {
  await run.s.shown('^Upcoming$', 15000)
  await run.s.m.assertVisible({ text: GAME_LABEL, timeout: 15000 })
  await run.s.m.assertNotVisible({ text: '^Open scoring menu$' })
}

export default defineHarness({
  id: 'scoring/schedule-exit/clean-exit',
  title:
    'Exit Current Game returns Schedule to its list, and keeps an unsaved play until discarded',
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/screens/GamesFeedScreen.tsx'
  ],
  stack: 'isolated',
  fixtures: ['roster-edit'],
  exclusive: false,
  surfaces: {
    // The scoring screen draws the field in 3D: a GPU, so a physical iPhone.
    'web-safari-ios': {
      devices: [
        { role: SCORER_ROLE, needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    },
    'ios-app': {
      devices: [
        { role: SCORER_ROLE, needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    }
  },
  services: [],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 10,
  guards: [],
  // The scenario sets and clears `api-500` itself, as setup.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'exit-to-list': async ctx => {
      const run = await beginRoster(ctx)
      const { s } = run
      // Schedule lists a member's games: the scorer joins the home team.
      const { makeId } = await import('../../../../src/common/ids')
      await stackSql(
        ctx,
        "insert into memberships (id, user_id, team_id, role, is_player, joined_at) values ($1, $2, $3, 'member', false, now())",
        [makeId('membership'), run.world.accounts.scorer.userId, run.teams.home]
      )
      await s.open('')
      await tab(run, 'Schedule')
      for (let cycle = 1; cycle <= 2; cycle++) {
        await enter(run)
        await exit(run)
        await revisit(run)
        await schedule(run)
        if (cycle === 1) await s.capture('schedule')
      }
      // A save the server refuses: Cancel keeps the scorer on scoring, and
      // Discard and Exit returns Schedule to its list.
      const setFault = ctx.stack.setFault
      if (setFault == null)
        throw new BlockedError('needs a stack whose fault server can be set')
      await enter(run)
      await setFault('api-500')
      try {
        await s.m.tapOn({ text: '^Ball$', timeout: 15000 })
        await exit(run)
        await s.shown('^Discard and Exit$', 15000)
        await s.m.tapOn({ text: '^Cancel$', timeout: 15000 })
        await s.shown('^Open scoring menu$', 15000)
        await s.m.assertNotVisible({ text: '^Schedule$' })
        await exit(run)
        await s.m.tapOn({ text: '^Discard and Exit$', timeout: 15000 })
      } finally {
        await setFault(null)
      }
      await revisit(run)
      await schedule(run)
    }
  }
})
