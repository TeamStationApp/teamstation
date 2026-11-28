import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import type { FixtureManifest } from '../../../../src/server/dev/fixtures/accounts'
import { readJson } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { appLink } from '../../../rigs/app/setServer'
import {
  type CoachApp,
  DEVELOP_APP,
  openCoachApp,
  stackDatabaseUrl
} from '../../../rigs/coach/coachApp'

/**
 * A phone keeps the nearest three games its person may score ready to open
 * with no server (#372), and nothing for anybody else. "No server" is the
 * stack's fault server holding every API request (`api-hang`), as the
 * offline scenarios on hub phones do: the bench's network shaper is not in
 * this machine's settings. Changes are made in the stack's database, whose
 * triggers tell the phone's socket the set moved.
 */

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Long enough for the set to read its manifest and keep each game. */
const PREPARE_MS = 60_000

async function sql(
  ctx: E2eContext,
  text: string,
  values: unknown[] = []
): Promise<void> {
  const { Client } = await import('pg')
  const client = new Client({
    connectionString: await stackDatabaseUrl(ctx),
    connectionTimeoutMillis: 15_000
  })
  await client.connect()
  try {
    await client.query(text, values)
  } finally {
    await client.end()
  }
}

/** Tries `work` again after a dropped connection: the stack is far away. */
async function retried<T>(work: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      if (attempt >= tries || !String(error).includes('fetch failed'))
        throw error
      await sleep(2000)
    }
  }
}

function faults(ctx: E2eContext): (fault: string | null) => Promise<void> {
  const setFault = ctx.stack.setFault
  if (setFault == null)
    throw new BlockedError('needs a stack whose fault server can be set')
  return async fault => {
    await retried(async () => {
      await setFault(fault)
    })
  }
}

/** Whether the game's Score screen opens, within `ms`, from the phone alone. */
async function opensToScore(
  app: CoachApp,
  gameId: string,
  ms = 20_000
): Promise<boolean> {
  await app.m.openLink({ link: appLink(`games/${gameId}/score`) })
  try {
    await app.m.extendedWaitUntil({ visible: { text: 'Ball' }, timeout: ms })
    return true
  } catch {
    return false
  }
}

/** Back to Home, out of any game. */
async function home(app: CoachApp): Promise<void> {
  await app.m.openLink({ link: appLink('') })
  await sleep(2000)
}

/** Which of `games` open to score with the server held, in order. */
async function readyOffline(
  ctx: E2eContext,
  app: CoachApp,
  games: string[]
): Promise<boolean[]> {
  const setFault = faults(ctx)
  const ready: boolean[] = []
  await setFault('api-hang')
  try {
    for (const game of games) {
      ready.push(await opensToScore(app, game))
      await home(app)
    }
  } finally {
    await setFault(null)
  }
  await sleep(5000)
  return ready
}

/** Each account's API session, signed in once: sign-ins are rate limited. */
const tokens = new Map<string, string>()

async function asAccount(
  ctx: E2eContext,
  account: { email: string; password: string },
  path: string
): Promise<unknown> {
  let token = tokens.get(account.email)
  if (token == null) {
    const { signInTestAccount } =
      await import('../../../../src/test/passwordFixtures')
    token = await retried(
      async () => await signInTestAccount(`${ctx.stack.origin}/api/v1`, account)
    )
    tokens.set(account.email, token)
  }
  const signed = token
  return await retried(
    async () =>
      await readJson(ctx.stack.origin, `/api/v1${path}`, {
        headers: { authorization: `Bearer ${signed}` }
      })
  )
}

function log(ctx: E2eContext, name: string, lines: string[]): void {
  writeFileSync(ctx.artifact(name), lines.join('\n') + '\n')
}

function soonOf(world: FixtureManifest): string[] {
  return world.ids.soon.split(',')
}

export default defineE2e({
  id: 'scoring/offline/eligible',
  title: 'A phone keeps its nearest three scorable games ready offline',
  kind: 'e2e',
  covers: [
    'src/app/sync/offlineSet.ts',
    'src/app/sync/cachingClient.ts',
    'src/server/scoring/offlineManifest.ts',
    'src/server/routes/me.ts',
    'src/server/socket/userNotices.ts'
  ],
  stack: 'isolated',
  fixtures: ['refresh-notices', 'coach-game'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'device', needs: ['ios'], hardware: 'none' }]
    }
  },
  services: ['web', 'api'],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 15,
  guards: [],
  // The scenarios set and clear `api-hang` themselves, as setup.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'nearest-three': async ctx => {
      const world = await ctx.fixture('refresh-notices')
      const soon = soonOf(world)
      const app = await openCoachApp(ctx, 'scorer')
      const lines: string[] = []
      const checks: Array<() => void> = []
      try {
        await sleep(PREPARE_MS)
        const first = await readyOffline(ctx, app, soon)
        lines.push(`$ prepared, server held: ready ${JSON.stringify(first)}`)
        checks.push(() => {
          expect(first, 'the nearest three, not the fourth').to.deep.equal([
            true,
            true,
            true,
            false
          ])
        })

        // The fourth game moves ahead of them all.
        await sql(
          ctx,
          "update games set start_at = now() + interval '1 hour' where id = $1",
          [soon[3]]
        )
        await sleep(PREPARE_MS)
        const moved = await readyOffline(ctx, app, soon)
        lines.push(`$ game four moved first: ready ${JSON.stringify(moved)}`)
        checks.push(() => {
          expect(moved, 'the set follows: four, one, two').to.deep.equal([
            true,
            true,
            false,
            true
          ])
        })

        // The scorekeeper role goes on every team.
        await sql(
          ctx,
          "delete from scope_roles where user_id = $1 and role = 'scorekeeper'",
          [world.accounts.scorer.userId]
        )
        await sleep(PREPARE_MS)
        const revoked = await readyOffline(ctx, app, soon)
        lines.push(`$ role revoked: ready ${JSON.stringify(revoked)}`)
        checks.push(() => {
          expect(revoked, 'nothing kept once the role goes').to.deep.equal([
            false,
            false,
            false,
            false
          ])
        })
      } finally {
        log(ctx, 'offline-set-after.nearest-three.log', lines)
      }
      for (const check of checks) check()
    },

    // The lineup game, whose sides have players to score, on the phone of
    // its home team's scorekeeper.
    'cold-offline-open': async ctx => {
      const world = await ctx.fixture('coach-game')
      const game = world.ids.game
      // The world's game starts as it is made: two hours on, it is still to
      // come, and the phone takes it as one of its three.
      await sql(
        ctx,
        "update games set start_at = now() + interval '2 hours' where id = $1",
        [game]
      )
      const app = await openCoachApp(ctx, world.accounts.scorekeeper)
      const setFault = faults(ctx)
      const lines: string[] = []
      const chosen = (await asAccount(
        ctx,
        world.accounts.scorekeeper,
        '/me/offline-scoring'
      )) as { games: Array<{ id: string }> }
      lines.push(
        `$ the scorekeeper's manifest names the game: ${chosen.games.some(row => row.id === game)}`
      )
      await sleep(PREPARE_MS)
      await setFault('api-hang')
      try {
        // Closed and opened again with no server: the game was never opened.
        await app.m.launchApp({ appId: DEVELOP_APP, stopApp: true })
        await sleep(5000)
        // Schedule lists it from what the phone kept.
        await app.m.openLink({ link: appLink('schedule') })
        let listed = false
        try {
          await app.m.extendedWaitUntil({
            visible: { text: '.*Visitors.*' },
            timeout: 30_000
          })
          listed = true
        } catch {
          listed = false
        }
        lines.push(`$ Schedule lists the game with the server held: ${listed}`)
        await app.m.takeScreenshot({
          path: ctx.artifact('cold-offline-schedule.png')
        })
        const opens = await opensToScore(app, game, 60_000)
        lines.push(
          `$ opened the never-opened game with the server held: ${opens}`
        )
        if (!opens || !listed) log(ctx, 'cold-offline-open-after.log', lines)
        expect(listed, 'Schedule lists the game').to.equal(true)
        expect(opens, 'the never-opened game opens').to.equal(true)
        for (const pitch of ['Ball', 'Called Strike']) {
          await app.m.tapOn({ text: pitch })
          await sleep(1500)
        }
        await app.m.takeScreenshot({
          path: ctx.artifact('cold-offline-open-after.png')
        })
        lines.push('$ opened with the server held, scored Ball and Strike')
      } finally {
        await setFault(null)
      }
      // In front again with the server back: the queue sends.
      await app.m.pressKey({ key: 'home' })
      await sleep(2000)
      await app.m.launchApp({ appId: DEVELOP_APP, stopApp: false })
      let pitches = 0
      for (let i = 0; i < 24 && pitches < 2; i++) {
        await sleep(5000)
        const events = await asAccount(
          ctx,
          world.accounts.scorekeeper,
          `/games/${game}/events`
        )
        pitches = (JSON.stringify(events).match(/"isPitch":true/g) ?? []).length
      }
      lines.push(`$ server back: ${pitches} pitches on the server`)
      log(ctx, 'cold-offline-open-after.log', lines)
      expect(pitches, 'both plays reached the server').to.equal(2)
    },

    // Nobody else's phone keeps games ahead: the spectator's nearest game,
    // never opened, does not open with the server held. (On the base build,
    // Home's read-ahead had kept its page.) An administrator who is no
    // scorekeeper is chosen nothing either.
    'spectator-zero': async ctx => {
      const world = await ctx.fixture('refresh-notices')
      const soon = soonOf(world)
      const app = await openCoachApp(ctx, 'spectator')
      const setFault = faults(ctx)
      const lines: string[] = []
      await app.m.openLink({ link: appLink('') })
      await sleep(PREPARE_MS)
      const chosen = async (role: string): Promise<number> =>
        (
          (await asAccount(
            ctx,
            world.accounts[role],
            '/me/offline-scoring'
          )) as { games: unknown[] }
        ).games.length
      const spectator = await chosen('spectator')
      const admin = await chosen('admin')
      lines.push(`$ manifests: spectator ${spectator} games, admin ${admin}`)
      let opens = false
      await setFault('api-hang')
      try {
        await app.m.openLink({ link: `teamstation://games/${soon[0]}` })
        try {
          await app.m.extendedWaitUntil({
            // The game page's own sections: a spectator's has no actions.
            visible: { text: 'Box score' },
            timeout: 20_000
          })
          opens = true
        } catch {
          opens = false
        }
        await app.m.takeScreenshot({
          path: ctx.artifact('spectator-game-held.png')
        })
      } finally {
        await setFault(null)
      }
      lines.push(
        `$ server held: the spectator's nearest game, never opened, opens: ${opens}`
      )
      log(ctx, 'offline-set-after.spectator-zero.log', lines)
      expect(spectator, 'nothing to keep for a spectator').to.equal(0)
      expect(admin, 'nothing to keep for an administrator').to.equal(0)
      expect(opens, 'nothing kept ahead on the phone').to.equal(false)
    }
  }
})
