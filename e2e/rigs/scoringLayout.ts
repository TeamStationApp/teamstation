import { expect } from 'chai'

import { asStoredDefaultLineup } from '../../src/common/scoring/lineupHistory'
import { makeDatabase } from '../../src/server/db/database'
import { joinTeam } from '../../src/server/dev/lineupFixture'
import { signInTestAccount } from '../../src/test/passwordFixtures'
import type { FixtureManifest } from '../core/fixtures'
import { eventually, readJson } from '../core/readback'
import type { E2eContext, WebSession } from '../core/spec'
import { stackDatabaseUrl } from './coach/coachApp'

/** Score on a second client, then wait until an independent API read confirms it. */
export async function remotePitch(
  ctx: E2eContext,
  world: FixtureManifest
): Promise<{
  pitch: () => Promise<void>
  swap: () => Promise<void>
  close: WebSession['close']
}> {
  const peer = await ctx.browser({ width: 390, height: 844 })
  try {
    const peerToken = await signInTestAccount(
      ctx.stack.origin + '/api/v1',
      world.accounts.peer
    )
    await peer.page.browserContext().setCookie({
      name: 'ts_session',
      value: peerToken,
      domain: new URL(ctx.stack.origin).hostname,
      path: '/',
      secure: true,
      sameSite: 'Lax'
    })
    await peer.m.openLink({
      link: `${ctx.stack.origin}/games/${world.ids.game}/score`
    })
    const api = ctx.stack.origin + '/api/v1'
    const token = await signInTestAccount(api, world.accounts.coach)
    const read = async (): Promise<string> => {
      const res = await fetch(`${api}/games/${world.ids.game}/events`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      expect(res.ok).equals(true)
      return JSON.stringify(await res.json())
    }
    return {
      close: peer.close,
      swap: async () => {
        await peer.m.tapOn({ css: '[aria-label="Open scoring menu"]' })
        await peer.m.tapOn({ text: 'Swap Home and Away' })
        await peer.m.tapOn({ text: 'Reset and Swap' })
      },
      pitch: async () => {
        const before = await read()
        await peer.m.tapOn({ css: '[aria-label="Ball"]', timeout: 60000 })
        for (let n = 0; n < 80; n++) {
          const after = await read()
          if (after !== before && after.includes('"code":"B"')) return
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        throw new Error('Peer pitch was not confirmed by the server')
      }
    }
  } catch (error) {
    await peer.close()
    throw error
  }
}

/** Each case edits the default of its own fresh, unplayed fixture game. */
export async function catcherFixture(
  ctx: E2eContext,
  world: FixtureManifest,
  kind: 'long' | 'unnumbered' | 'empty'
): Promise<void> {
  const db = makeDatabase(await stackDatabaseUrl(ctx))
  try {
    await db.transaction().execute(async trx => {
      const team = await trx
        .selectFrom('teams')
        .select('default_lineup')
        .where('id', '=', world.ids.homeTeam)
        .executeTakeFirstOrThrow()
      const saved = asStoredDefaultLineup(team.default_lineup)
      const lineup = saved.lineup!
      const catcher = lineup.defense.C!
      if (kind === 'empty') lineup.defense.C = null
      else if (kind === 'unnumbered') {
        const membership = await trx
          .selectFrom('gumbo_ids')
          .select('user_id')
          .where('gumbo_id', '=', catcher.gumboId)
          .executeTakeFirstOrThrow()
        await trx
          .updateTable('memberships')
          .set({ jersey: null })
          .where('team_id', '=', world.ids.homeTeam)
          .where('user_id', '=', membership.user_id)
          .executeTakeFirstOrThrow()
        catcher.jersey = ''
        const batter = lineup.batters.find(p => p.gumboId === catcher.gumboId)
        if (batter != null) batter.jersey = ''
      } else {
        const first = 'Alexandriaverylongcatchername'
        const person = await trx
          .selectFrom('gumbo_ids')
          .select('user_id')
          .where('gumbo_id', '=', catcher.gumboId)
          .executeTakeFirstOrThrow()
        await trx
          .updateTable('users')
          .set({
            first_name: first,
            last_name: 'Catcherson',
            display_name: first + ' Catcherson'
          })
          .where('id', '=', person.user_id)
          .execute()
      }
      await trx
        .updateTable('teams')
        .set({ default_lineup: saved })
        .where('id', '=', world.ids.homeTeam)
        .execute()
    })
  } finally {
    await db.destroy()
  }
}

/** Match the base and head reset fixtures: either scorer may score for both sides. */
export async function scoringSwapFixture(
  ctx: E2eContext
): Promise<FixtureManifest> {
  const world = await ctx.fixture('coach-game')
  const db = makeDatabase(await stackDatabaseUrl(ctx))
  try {
    await db.transaction().execute(async trx => {
      for (const account of [world.accounts.peer, world.accounts.scorekeeper])
        await joinTeam(trx, account.userId, world.ids.awayTeam, 'scorekeeper')
    })
    return world
  } finally {
    await db.destroy()
  }
}

export const RESET_AND_SWAP_REPORT =
  'Home and away were swapped and the game was reset.'

/** Verify both sides and the emptied score from an independent reader. */
export async function expectSwapped(
  ctx: E2eContext,
  world: FixtureManifest
): Promise<void> {
  const token = await signInTestAccount(
    ctx.stack.origin + '/api/v1',
    world.accounts.coach
  )
  const get = async (suffix: string): Promise<unknown> =>
    await readJson(
      ctx.stack.origin,
      '/api/v1/games/' + world.ids.game + suffix,
      { headers: { authorization: 'Bearer ' + token } }
    )
  await eventually(async () => {
    const game = (await get('')) as { homeTeamId: string; awayTeamId: string }
    expect(game.homeTeamId).equals(world.ids.awayTeam)
    expect(game.awayTeamId).equals(world.ids.homeTeam)
    expect(JSON.stringify(await get('/events'))).not.match(/"call":\{"code":/)
  })
}
