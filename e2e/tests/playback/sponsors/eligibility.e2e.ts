import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import type { Kysely } from 'kysely'

import { TeamStationClient } from '../../../../src/common/api'
import { makeId } from '../../../../src/common/ids'
import type { GameSponsors } from '../../../../src/common/sponsors/types'
import { type Database, makeDatabase } from '../../../../src/server/db/database'
import type {
  FixtureAccount,
  FixtureManifest
} from '../../../../src/server/dev/fixtures/accounts'
import { pickSide } from '../../../../src/server/sponsors/eligibility'
import { placeReel } from '../../../../src/server/sponsors/reels'
import { nodeDatabaseUrl } from '../../../core/dropletStack'
import { eventually } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext, type WebSession } from '../../../core/spec'
import { apiToken } from '../../../rigs/media/recordingSeek'
import { recordGame } from '../../../rigs/media/sponsorRecordings'
import {
  acceptLogo,
  acceptReel,
  type ReelSetup
} from '../../../rigs/media/sponsorReelGame'
import { stackHandle } from '../../../rigs/media/stackSpace'

/**
 * E11, which league's sponsorship each viewer sees (#220): on the `sponsors`
 * world's interleague Dodgers @ Yankees (in the AL season), both leagues have
 * a logo and a reel, and the game is recorded so each is given the game's
 * logo and a pre-game reel. The Yankees player sees the AL's, the Dodgers
 * player the NL's, and the Yankees player moved to the Dodgers the NL's on
 * the next open. A member of the AL season, on both sides, sees the hash's
 * league on three opens, as does the NL admin, whose league is a team's and
 * not the season's. Signed out, the read is 401 and the game plays nothing.
 *
 * Each read is logged with `curl` to `eligibility.log`, the token left out;
 * each web open reads the drawn logo's address, which names its league.
 */

const DESKTOP = { width: 1280, height: 800 }

const run = promisify(execFile)

type Role = 'yankeesPlayer' | 'dodgersPlayer' | 'nlAdmin' | 'neutral'

interface Viewers {
  world: FixtureManifest
  api: string
  db: Kysely<Database>
  tokens: Record<Role, string>
}

/**
 * `GET /games/:gameId/sponsors` with `curl` as `role` (or signed out),
 * appended to `eligibility.log` with its status and answer. The token is
 * written as `$TOKEN`.
 */
async function curlRead(
  ctx: E2eContext,
  viewers: Viewers,
  step: string,
  gameId: string,
  role: Role | null
): Promise<{ status: number; body: GameSponsors | null }> {
  const url = `${viewers.api}/games/${gameId}/sponsors`
  const auth =
    role == null ? [] : ['-H', `authorization: Bearer ${viewers.tokens[role]}`]
  const { stdout } = await run('curl', [
    '-sS',
    '-w',
    '\n%{http_code}',
    ...auth,
    url
  ])
  const lines = stdout.trimEnd().split('\n')
  const status = Number(lines.pop())
  const text = lines.join('\n')
  appendFileSync(
    ctx.artifact('eligibility.log'),
    `\n## ${step} (${new Date().toISOString()})\n$ curl -sS ${
      role == null ? '' : `-H "authorization: Bearer $TOKEN" `
    }${url}   # ${role ?? 'signed out'}\nHTTP ${status}\n${text}\n`
  )
  return {
    status,
    body: status === 200 ? (JSON.parse(text) as GameSponsors) : null
  }
}

/** The league a read answered, its logo's and every reel's address checked to name it. */
function leagueOf(answer: GameSponsors | null): string | null {
  expect(answer, 'an answer').not.equals(null)
  const leagueId = answer!.leagueId
  if (leagueId == null) return null
  expect(answer!.logo?.url).contains(`/sponsors/${leagueId}/`)
  expect(answer!.reels, 'the league’s pre-game reel').length(1)
  expect(answer!.reels[0].url).contains(`/sponsors/${leagueId}/`)
  return leagueId
}

/** `account` signed in on the web through the password form. */
async function signedInWeb(
  ctx: E2eContext,
  account: FixtureAccount
): Promise<WebSession> {
  const web = await ctx.browser(DESKTOP, { h264: true })
  await web.m.openLink({ link: ctx.stack.origin })
  await web.m.assertVisible({ text: 'Use a password instead', timeout: 30_000 })
  await web.m.tapOn({ text: 'Use a password instead' })
  await web.m.tapOn({
    css: 'input[aria-label="E-mail address"]',
    timeout: 15_000
  })
  await web.m.inputText({ text: account.email })
  await web.m.tapOn({ css: 'input[aria-label="Password"]', timeout: 15_000 })
  await web.m.inputText({ text: account.password })
  await web.m.pressKey({ key: 'Enter' })
  await eventually(async () => {
    const signedIn = await web.page.evaluate(
      () => document.querySelector('input[aria-label="Password"]') == null
    )
    expect(signedIn, 'the password form has gone').equals(true)
  }, 30_000)
  return web
}

/** The game's card opened on `videoId`: the drawn logo's address, once it shows. */
async function drawnLogo(
  ctx: E2eContext,
  web: WebSession,
  gameId: string,
  videoId: string
): Promise<string> {
  await web.m.openLink({
    link: `${ctx.stack.origin}/games/${gameId}?video=${videoId}`
  })
  let src = ''
  await eventually(async () => {
    // Read in the page, which has no helpers for `??` or `?.`.
    src = await web.page.evaluate(() => {
      const image = document.querySelector('[data-testid="sponsor-logo"] img')
      if (image == null) return ''
      const found = image.getAttribute('src')
      return typeof found === 'string' ? found : ''
    })
    expect(src, 'the card draws a sponsor logo').not.equals('')
  }, 60_000)
  return src
}

async function viewers(ctx: E2eContext): Promise<Viewers> {
  const handle = stackHandle(ctx)
  const world = await ctx.fixture('sponsors')
  const token = async (role: Role): Promise<string> =>
    await apiToken(handle.api, world.accounts[role])
  const tokens: Record<Role, string> = {
    yankeesPlayer: await token('yankeesPlayer'),
    dodgersPlayer: await token('dodgersPlayer'),
    nlAdmin: await token('nlAdmin'),
    neutral: await token('neutral')
  }
  return {
    world,
    api: handle.api,
    db: makeDatabase(nodeDatabaseUrl(handle.databaseUrl)),
    tokens
  }
}

/** E11: each viewer's league, the hash for neutral ones, and none signed out. */
async function eligibleViewers(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
  const setup = await viewers(ctx)
  const { world, db } = setup
  const { americanLeague, nationalLeague } = world.ids
  const gameId = world.ids.dodgersAtYankees
  const yankees = world.ids.yankees
  const dodgers = world.ids.dodgers
  const player = world.accounts.yankeesPlayer
  appendFileSync(
    ctx.artifact('eligibility.log'),
    `# E11 ${ctx.scenarioId} on ${ctx.stack.origin}\n` +
      `# American League ${americanLeague}, National League ${nationalLeague}\n` +
      `# Dodgers @ Yankees ${gameId} (AL season ${world.ids.season}), Yankees @ Red Sox ${world.ids.yankeesAtRedSox}\n`
  )
  try {
    // Each league's logo and reel, accepted by its admin.
    for (const [league, role] of [
      [americanLeague, 'alAdmin'],
      [nationalLeague, 'nlAdmin']
    ] as const) {
      const admin: ReelSetup = {
        world,
        league,
        gameId,
        admin: new TeamStationClient({
          baseUrl: setup.api,
          token: await apiToken(setup.api, world.accounts[role])
        }),
        player: new TeamStationClient({ baseUrl: setup.api }),
        db,
        psqlUrl: ''
      }
      await acceptLogo(ctx, admin)
      await acceptReel(ctx, admin)
    }
    // Recorded a minute after the accepts: each league gives the game its
    // logo, and each its pre-game reel at the start.
    const startAt = new Date(Date.now() + 60_000)
    const recorded = await recordGame(stackHandle(ctx), {
      gameId,
      startAt,
      runDir: join(ctx.runDir, 'recording'),
      angles: [{ title: 'Home Plate', durationSec: 120 }]
    })
    for (const league of [americanLeague, nationalLeague])
      expect(
        await placeReel(db, gameId, league, { slot: 'pregame' }, startAt),
        'a pre-game reel'
      ).not.equals(null)
    const videoId = recorded['Home Plate']

    // Teams: each player their own team's league.
    const yankeesRead = await curlRead(
      ctx,
      setup,
      'Yankees player',
      gameId,
      'yankeesPlayer'
    )
    expect(leagueOf(yankeesRead.body)).equals(americanLeague)
    const dodgersRead = await curlRead(
      ctx,
      setup,
      'Dodgers player',
      gameId,
      'dodgersPlayer'
    )
    expect(leagueOf(dodgersRead.body)).equals(nationalLeague)
    const web = await signedInWeb(ctx, player)
    expect(await drawnLogo(ctx, web, gameId, videoId)).contains(
      `/sponsors/${americanLeague}/`
    )
    await web.close()
    const dodgersWeb = await signedInWeb(ctx, world.accounts.dodgersPlayer)
    expect(await drawnLogo(ctx, dodgersWeb, gameId, videoId)).contains(
      `/sponsors/${nationalLeague}/`
    )
    await dodgersWeb.close()

    // The Yankees player moved to the Dodgers: the NL's, on the next open.
    await db
      .updateTable('memberships')
      .set({ team_id: dodgers })
      .where('user_id', '=', player.userId)
      .where('team_id', '=', yankees)
      .execute()
    try {
      const moved = await curlRead(
        ctx,
        setup,
        'Yankees player moved to the Dodgers',
        gameId,
        'yankeesPlayer'
      )
      expect(leagueOf(moved.body)).equals(nationalLeague)
      const movedWeb = await signedInWeb(ctx, player)
      expect(await drawnLogo(ctx, movedWeb, gameId, videoId)).contains(
        `/sponsors/${nationalLeague}/`
      )
      await movedWeb.close()
    } finally {
      await db
        .updateTable('memberships')
        .set({ team_id: yankees })
        .where('user_id', '=', player.userId)
        .where('team_id', '=', dodgers)
        .execute()
    }

    // Neutral: a member of the game's season, so of both sides, gets the
    // hash's league on every open.
    const neutral = world.accounts.neutral
    await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: neutral.userId,
        season_id: world.ids.season
      })
      .execute()
    const hashed = (userId: string): string =>
      pickSide(gameId, userId) === 'home' ? americanLeague : nationalLeague
    for (let open = 1; open <= 3; open++) {
      const read = await curlRead(
        ctx,
        setup,
        `neutral (AL season member), open ${open}: the hash gives ${pickSide(gameId, neutral.userId)}`,
        gameId,
        'neutral'
      )
      expect(leagueOf(read.body)).equals(hashed(neutral.userId))
    }
    const neutralWeb = await signedInWeb(ctx, neutral)
    for (let open = 1; open <= 3; open++)
      expect(await drawnLogo(ctx, neutralWeb, gameId, videoId)).contains(
        `/sponsors/${hashed(neutral.userId)}/`
      )
    await neutralWeb.close()

    // Signed out: no read, and the game plays nothing.
    const signedOut = await curlRead(ctx, setup, 'signed out', gameId, null)
    expect(signedOut.status).equals(401)
    const visitor = await ctx.browser(DESKTOP, { h264: true })
    for (const link of [
      `${ctx.stack.origin}/teams/${yankees}`,
      `${ctx.stack.origin}/games/${gameId}?video=${videoId}`
    ]) {
      await visitor.m.openLink({ link })
      await new Promise(resolve => setTimeout(resolve, 8000))
      const shown = await visitor.page.evaluate(() => ({
        videos: document.querySelectorAll('video').length,
        logos: document.querySelectorAll('[data-testid="sponsor-logo"]').length
      }))
      expect(shown, `signed out at ${link}`).deep.equals({
        videos: 0,
        logos: 0
      })
    }
    await visitor.close()

    // Boundary: the NL admin's league is the Dodgers' but not the AL
    // season's, so it is neutral here; the AL season's own game it cannot
    // open at all.
    const boundary = await curlRead(
      ctx,
      setup,
      `NL admin on Dodgers @ Yankees (AL season): the hash gives ${pickSide(gameId, world.accounts.nlAdmin.userId)}`,
      gameId,
      'nlAdmin'
    )
    expect(leagueOf(boundary.body)).equals(
      hashed(world.accounts.nlAdmin.userId)
    )
    const outside = await curlRead(
      ctx,
      setup,
      'NL admin on Yankees @ Red Sox (AL season, no NL team)',
      world.ids.yankeesAtRedSox,
      'nlAdmin'
    )
    expect(outside.status).equals(404)
  } finally {
    await db.destroy()
  }
}

export default defineE2e({
  id: 'playback/sponsors/eligibility',
  title:
    'Each viewer sees the sponsorship of their own team’s league, neutral viewers a stable hash’s, and signed-out visitors none',
  kind: 'e2e',
  covers: [
    'src/server/sponsors/eligibility.ts',
    'src/server/sponsors/logos.ts',
    'src/server/routes/sponsors.ts',
    'src/app/player/sponsors/useGameSponsors.ts',
    'src/app/screens/GameScreen.tsx'
  ],
  stack: 'isolated',
  fixtures: ['sponsors'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [] }
  },
  services: ['web'],
  apps: [],
  secrets: [],
  costUsd: 0,
  sendsNoMail: true,
  minutes: 8,
  guards: [],
  faults: ['blank-screen', 'hidden-element'],
  manual: false,
  scenarios: {
    viewers: eligibleViewers
  }
})
