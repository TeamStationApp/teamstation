import { expect } from 'chai'

import type { ScoringAction } from '../../../../src/common/scoring/actions'
import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { clearSignInLimits } from '../../../rigs/coach/coachApp'
import {
  Browser,
  HEIGHT,
  type LineupWorld,
  PHONE_HEIGHT,
  PHONE_WIDTH,
  rosterSaves,
  type ScoringStack,
  scoringStack,
  WIDTH
} from '../../../rigs/scoringBrowser'

/**
 * Team-keyed lineups, end to end: the stack's API with its game socket and
 * web build, a `lineup-game` world made afresh for each game, in this
 * machine's browser. Stored records name teams, not sides; guests and
 * players left off are kept by team; lineups before the first pitch stay
 * off Gumbo; a begun game resets and swaps once its plays are confirmed,
 * from the API, the scoring menu or a one-team scorekeeper's Game
 * Settings; and an older app's swap-only proposal is accepted or refused.
 */

type Action = ScoringAction

interface Run {
  ctx: HarnessContext
  stack: ScoringStack
  browser: Browser | undefined
}

async function begin(ctx: HarnessContext): Promise<Run> {
  await clearSignInLimits(ctx)
  return { ctx, stack: await scoringStack(ctx), browser: undefined }
}

/** The run's window, opened the first time it is asked for. */
async function window(run: Run): Promise<Browser> {
  run.browser ??= await Browser.open(run.ctx, { width: WIDTH, height: HEIGHT })
  return run.browser
}

/** A scenario's steps, its windows closed and their page errors logged. */
async function scenario(
  ctx: HarnessContext,
  steps: (run: Run) => Promise<void>
): Promise<void> {
  const run = await begin(ctx)
  try {
    await steps(run)
  } finally {
    if (run.browser != null) {
      if (run.browser.errors.length > 0)
        run.stack.note('browser-errors.log', run.browser.errors.join('\n'))
      await run.browser.close()
    }
  }
}

/** A second window at a phone's size, open beside the first. */
async function phone<T>(
  run: Run,
  work: (phone: Browser) => Promise<T>
): Promise<T> {
  const small = await Browser.open(run.ctx, {
    width: PHONE_WIDTH,
    height: PHONE_HEIGHT
  })
  try {
    return await work(small)
  } finally {
    await small.close()
  }
}

async function as(
  run: Run,
  browser: Browser,
  world: LineupWorld,
  who: string
): Promise<void> {
  await browser.as(await run.stack.tokenOf(world, who))
}

/** Makes the world's plain member a scorekeeper of the home team alone. */
async function oneTeamScorekeeper(
  run: Run,
  world: LineupWorld,
  file: string | null
): Promise<void> {
  await run.stack.query(
    file,
    `insert into scope_roles (id, user_id, scope_type, scope_id, role)
       values ('sr_' || md5(random()::text), $1, 'team', $2, 'scorekeeper')
       on conflict do nothing returning scope_type, role`,
    [world.users.member.userId, world.teams.home]
  )
}

/** A fresh game, its lineups saved by the scorekeeper. */
async function lineupsSaved(
  run: Run,
  file: string | null
): Promise<LineupWorld> {
  const { stack } = run
  const world = await stack.lineupGame(file)
  await stack.score(world, rosterSaves)
  stack.note(
    file,
    `$ POST ${stack.api}/games/${world.gameId}/events  (scorekeeper: three roster saves, no pitch)\nsaved\n`
  )
  return world
}

/** Two half-innings of strikeouts, then a ball: the top of the 2nd. */
const intoTheSecond: Action[] = [
  ...Array.from({ length: 18 }, (): Action => ({ type: 'pitch', call: 'C' })),
  { type: 'pitch', call: 'B' }
]

const playsState = `select home_team_id as "homeTeam", away_team_id as "awayTeam", status,
    play_generation as generation,
    (select count(*) from events e where e."gameId" = g.id)::int as plays,
    (select count(*) from game_play_archives a where a.game_id = g.id)::int as archives
  from games g where id = $1`

/** Game Settings from the game screen's gear: Swap home and away, Save. */
async function settingsSwap(
  browser: Browser,
  gameId: string,
  form?: string
): Promise<void> {
  await browser.go(`/games/${gameId}`)
  await browser.tap('Event settings')
  await browser.waitText(
    "As this game's scorekeeper you can swap home and away."
  )
  if (form != null) await browser.capture(form)
  await browser.tap('Swap home and away')
  await browser.tap('Save')
}

/** The game socket's protocol header, as the app sends it. */
async function protocolHeader(): Promise<Record<string, string>> {
  const { GAME_SOCKET_PROTOCOL, PROTOCOL_HEADER } =
    await import('../../../../src/common/gameSocket')
  return { [PROTOCOL_HEADER]: String(GAME_SOCKET_PROTOCOL) }
}

export default defineHarness({
  id: 'scoring/team-lineups/team-keyed',
  title: 'Lineups are kept by team, and a begun game resets to swap',
  kind: 'e2e',
  covers: [
    'src/common/scoring/swapDocuments.ts',
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/scoring/MoreMenu.tsx',
    'src/app/screens/GameFormScreen.tsx',
    'src/server/routes/events.ts',
    'src/server/games/swapSides.ts',
    'src/server/games/resetSwap.ts',
    'src/server/games/rosterAvailability.ts',
    'src/server/schedule/gameApprovals.ts'
  ],
  stack: 'isolated',
  fixtures: ['lineup-game'],
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
  minutes: 25,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'records-name-teams': async ctx => {
      await scenario(ctx, async run => {
        const { stack } = run
        const file = 'record-by-team.log'
        const world = await stack.lineupGame(file)
        const bench = world.players.away[9]
        await stack.score(world, (game): Action[] => [
          ...rosterSaves(game),
          { type: 'pitch', call: 'B' },
          {
            type: 'lineup',
            kind: 'substitute',
            side: 'away',
            player: bench.gumboId,
            replaces: world.players.away[0].gumboId
          },
          { type: 'result', eventType: 'intent_walk' },
          { type: 'gameFlow', kind: 'closePlay' }
        ])
        stack.note(
          file,
          `$ POST ${stack.api}/games/${world.gameId}/events  (scorekeeper: roster saves, a ball, a pinch hitter for the leadoff, an intentional walk)\nsaved\n`
        )
        await stack.query(
          file,
          `select e."atBatIndex", e.gumbo->'teamStation'->>'version' as "version",
                  (select array_agg(k order by k) from jsonb_object_keys(e.gumbo->'teamStation'->'setupBefore'->'teams') k) as "setupTeams",
                  e.gumbo->'teamStation'->'setupBefore' ? 'sides' as "keyedBySide",
                  (select array_agg(distinct a->>'teamId') from jsonb_array_elements(e.gumbo->'teamStation'->'actions') a where a->>'teamId' is not null) as "lineupChangesNameTeams",
                  g.away_team_id as "awayTeam", g.home_team_id as "homeTeam"
             from events e join games g on g.id = e."gameId"
            where e."gameId" = $1 order by 1`,
          [world.gameId]
        )
        const [older] = await stack.query(
          null,
          `select id from games where "currentPlay"->'teamStation'->>'version' = '2'
              or exists (select 1 from events e where e."gameId" = games.id and e.gumbo->'teamStation'->>'version' = '2')
            order by updated_at desc limit 1`
        )
        if (older == null) {
          stack.note(file, 'no version 2 game in this database to refold\n')
          return
        }
        // The refold preview is the server's own script, run on its host.
        throw new BlockedError(
          `version 2 game ${String(older.id)} to refold: the preview is \`npm run refold-scored-games -- --game <id> --preview\` on the stack's host, which no control route runs`
        )
      })
    },

    'availability-by-team': async ctx => {
      await scenario(ctx, async run => {
        const { stack } = run
        const file = 'availability-by-team.log'
        const world = await stack.lineupGame(file)
        const coach = await stack.clientOf(world, 'headCoach')
        const guest = await coach.createGuestPlayer(world.gameId, 'home', {
          firstName: 'Gus',
          lastName: 'Guest',
          jersey: '77',
          positions: [],
          bats: null,
          throws: null
        })
        stack.note(
          file,
          `$ POST ${stack.api}/games/${world.gameId}/guest-players  {"side":"home","firstName":"Gus","lastName":"Guest","jersey":"77"}\n${JSON.stringify({ gumboId: guest.gumboId })}\n`
        )
        const bench = world.players.away[12]
        await (
          await stack.clientOf(world, 'awayCoach')
        ).setRostered(world.gameId, {
          side: 'away',
          userId: bench.userId,
          rostered: false
        })
        stack.note(
          file,
          `$ PUT ${stack.api}/games/${world.gameId}/unroster  {"side":"away","userId":"<${bench.name}>","rostered":false}\nunrostered (gumbo id ${bench.gumboId})\n`
        )
        await stack.query(
          file,
          `select away_team_id as "awayTeam", home_team_id as "homeTeam", guests, unrostered from games where id = $1`,
          [world.gameId]
        )
        const detail = await coach.game(world.gameId)
        stack.note(
          file,
          `$ GET ${stack.api}/games/${world.gameId}\n${JSON.stringify({ guests: detail.guests, unrostered: detail.unrostered }, null, 2)}\n`
        )
      })
    },

    'pregame-off-gumbo': async ctx => {
      await scenario(ctx, async run => {
        const { stack } = run
        const file = 'pregame-storage-after.log'
        const world = await lineupsSaved(run, file)
        const columns = `select "currentPlay" is null as "noAtBatStored",
            pregame->>'version' as "pregameVersion",
            (select array_agg(k order by k) from jsonb_object_keys(pregame->'setupBefore'->'teams') k) as "pregameTeams",
            jsonb_array_length(pregame->'actions') as "pregameActions",
            away_team_id as "awayTeam", home_team_id as "homeTeam", lineups_digest is not null as "digest"
          from games where id = $1`
        await stack.query(file, columns, [world.gameId])
        const scorer = await stack.clientOf(world, 'scorekeeper')
        const events = await scorer.gameEvents(world.gameId)
        const current = events.currentPlay as {
          about: unknown
          teamStation: { version: number }
        } | null
        stack.note(
          file,
          `$ GET ${stack.api}/games/${world.gameId}/events\n${JSON.stringify({ plays: events.plays.length, currentPlay: current == null ? null : { about: current.about, recordVersion: current.teamStation.version } }, null, 2)}\n`
        )
        const lineups = await scorer.gameLineups(world.gameId)
        stack.note(
          file,
          `$ GET ${stack.api}/games/${world.gameId}/lineups\naway leadoff: ${String(lineups.away.current?.batters[0]?.name)} (${String(lineups.away.current?.batters[0]?.gumboId)}), expected ${world.players.away[0].name}\n`
        )
        const dj = await scorer.djGame(world.gameId)
        stack.note(
          file,
          `$ GET ${stack.api}/games/${world.gameId}/dj\nat bat: ${JSON.stringify(dj.atBat)}\n`
        )
        await stack.score(world, [{ type: 'pitch', call: 'B' }])
        stack.note(
          file,
          `$ POST ${stack.api}/games/${world.gameId}/events  (scorekeeper: the first pitch, a ball)\nsaved\n`
        )
        await stack.query(file, columns, [world.gameId])

        const swapFile = 'pregame-swap.log'
        const other = await lineupsSaved(run, swapFile)
        const state = `select home_team_id as "homeTeam", away_team_id as "awayTeam", home_score, away_score,
            md5(pregame::text) as "pregame", md5(guests::text) as "guests", md5(unrostered::text) as "unrostered",
            lineups_digest as "digest", "currentPlay" is null as "noAtBatStored"
          from games where id = $1`
        await stack.query(swapFile, state, [other.gameId])
        const scorekeeper = await stack.clientOf(other, 'scorekeeper')
        const read = await scorekeeper.game(other.gameId)
        await scorekeeper.swapGameSides(other.gameId, {
          homeTeamId: read.homeTeamId,
          awayTeamId: read.awayTeamId
        })
        stack.note(
          swapFile,
          `$ POST ${stack.api}/games/${other.gameId}/swap-sides  {"homeTeamId":"${read.homeTeamId}","awayTeamId":"${read.awayTeamId}"}\nswapped\n`
        )
        await stack.query(swapFile, state, [other.gameId])
      })
    },

    'confirmed-reset-swap': async ctx => {
      await scenario(ctx, async run => {
        const { stack } = run
        const file = 'reset-swap.log'
        const world = await lineupsSaved(run, file)
        // Two half-innings of strikeouts, then a ball to the 2nd's leadoff.
        await stack.score(world, intoTheSecond)
        stack.note(
          file,
          `$ POST ${stack.api}/games/${world.gameId}/events  (scorekeeper: six strikeouts, then a ball)\nsaved\n`
        )
        const state = `select home_team_id as "homeTeam", away_team_id as "awayTeam", status, home_score, away_score,
            "currentPlay" is null as "noAtBatStored", pregame->>'version' as "pregameVersion",
            play_generation as generation,
            (select count(*) from events e where e."gameId" = g.id)::int as plays,
            (select count(*) from game_play_archives a where a.game_id = g.id)::int as archives,
            (select status from game_stats_state s where s.game_id = g.id) as stats,
            (select count(*) from game_player_stats s where s.game_id = g.id)::int as "statLines"
          from games g where id = $1`
        await stack.query(file, state, [world.gameId])
        const token = await stack.tokenOf(world, 'scorekeeper')
        const protocol = await protocolHeader()
        const call = async (
          method: string,
          path: string,
          body: unknown
        ): Promise<{ status: number; body: unknown }> => {
          const response = await fetch(`${stack.api}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              ...protocol
            },
            body: JSON.stringify(body)
          })
          const answer = {
            status: response.status,
            body: await response.json()
          }
          stack.note(
            file,
            `$ ${method} ${stack.api}${path}  ${JSON.stringify(body)}\n${answer.status} ${JSON.stringify(answer.body, null, 2)}\n`
          )
          return answer
        }
        const scorer = await stack.clientOf(world, 'scorekeeper')
        const read = await scorer.game(world.gameId)
        const events = (await (
          await fetch(`${stack.api}/games/${world.gameId}/events`, {
            headers: { authorization: `Bearer ${token}` }
          })
        ).json()) as { playsDigest: string; generation: number }
        stack.note(
          file,
          `$ GET ${stack.api}/games/${world.gameId}/events\nplaysDigest ${events.playsDigest}, generation ${events.generation}\n`
        )
        const sides = {
          homeTeamId: read.homeTeamId,
          awayTeamId: read.awayTeamId
        }
        const refused = await call(
          'POST',
          `/games/${world.gameId}/swap-sides`,
          sides
        )
        expect(refused.status, 'the unconfirmed reset went').equals(409)
        const reset = await call('POST', `/games/${world.gameId}/swap-sides`, {
          ...sides,
          playsDigest: events.playsDigest,
          generation: events.generation
        })
        expect(reset.status, 'the confirmed reset failed').equals(200)
        await stack.query(file, state, [world.gameId])
        // The hosts, away now, bat first: their leadoff is due up.
        const lineups = await scorer.gameLineups(world.gameId)
        const leadoff = lineups.away.current?.batters[0]
        stack.note(
          file,
          `$ GET ${stack.api}/games/${world.gameId}/lineups\naway (${lineups.away.teamName}) leadoff: ${String(leadoff?.name)}, expected ${world.players.home[0].name}\n`
        )
        expect(leadoff?.gumboId, 'the hosts lead off').equals(
          world.players.home[0].gumboId
        )
        const stale = await call('POST', `/games/${world.gameId}/events`, {
          mode: 'live',
          source: { system: 'teamstation' },
          plays: [],
          currentPlay: null,
          generation: events.generation
        })
        expect(stale.status, 'the stale post went').equals(409)
        await stack.query(file, state, [world.gameId])
      })
    },

    'menu-reset-swap-phone-follows': async ctx => {
      await scenario(ctx, async run => {
        const { stack } = run
        const file = 'reset-menu.log'
        const world = await lineupsSaved(run, file)
        await stack.score(world, intoTheSecond)
        stack.note(
          file,
          `$ POST ${stack.api}/games/${world.gameId}/events  (scorekeeper: six strikeouts, then a ball)\nsaved\n`
        )
        await stack.query(file, playsState, [world.gameId])
        const browser = await window(run)
        await phone(run, async small => {
          await as(run, small, world, 'scorekeeper')
          await small.scoreGame(world.gameId)
          // The top of the 2nd: the visitors' fourth batter is up.
          await small.waitText(`Batter ${world.players.away[3].name}`, 60000)
          await as(run, browser, world, 'scorekeeper')
          await browser.scoreGame(world.gameId)
          await browser.waitText(`Batter ${world.players.away[3].name}`, 60000)
          await browser.tap('Open scoring menu')
          await browser.waitText('resets all game plays')
          const row = await browser.labelText('Swap Home and Away')
          expect(row, 'the menu row').equals(
            'Swap Home and Away\nresets all game plays'
          )
          await browser.capture('scoring-menu-after-pitch-after.png')
          await browser.tap('Swap Home and Away')
          await browser.waitText(
            'Resets all game plays: 7 at-bats in 2 innings will be lost.'
          )
          await browser.capture('reset-confirm.png')
          stack.note(
            file,
            `scoring menu: "${row.replace('\n', ' / ')}"; the sheet: "Resets all game plays: 7 at-bats in 2 innings will be lost." with Reset and Swap\n`
          )
          await browser.tap('Reset and Swap')
          await browser.waitText(`Batter ${world.players.home[0].name}`, 60000)
          await browser.waitText(
            'Home and away were swapped and the game was reset.'
          )
          await browser.capture('reset-swapped.png')
          await small.waitText(`Batter ${world.players.home[0].name}`, 60000)
          await small.waitText('the game was reset')
          await small.capture('reset-phone-notice.png')
          stack.note(
            file,
            `both screens opened again at the top of the 1st with ${world.players.home[0].name} due up; the phone says the game was reset\n`
          )
        })
        await stack.query(file, playsState, [world.gameId])
      })
    },

    'pregame-menu-swap': async ctx => {
      await scenario(ctx, async run => {
        const { stack } = run
        const file = 'swap-pregame-menu.log'
        const world = await lineupsSaved(run, file)
        const browser = await window(run)
        await as(run, browser, world, 'scorekeeper')
        await browser.scoreGame(world.gameId)
        await browser.waitText(`Batter ${world.players.away[0].name}`, 60000)
        await browser.tap('Open scoring menu')
        await browser.waitText('Swap Home and Away')
        const row = await browser.labelText('Swap Home and Away')
        expect(row, 'the menu row').equals('Swap Home and Away')
        await browser.capture('scoring-menu-pregame.png')
        await browser.tap('Swap Home and Away')
        await browser.waitText('will bat first')
        expect(
          await browser.text(),
          'a pregame swap names no plays lost'
        ).not.includes('Resets all game plays')
        await browser.capture('swap-confirm-pregame.png')
        await browser.tap('Confirm Swap')
        await browser.waitText(`Batter ${world.players.home[0].name}`, 60000)
        await browser.waitText('Home and away were swapped.')
        stack.note(
          file,
          `scoring menu: "${row}"; the sheet names no plays; Confirm Swap; ${world.players.home[0].name} due up\n`
        )
        await stack.query(file, playsState, [world.gameId])
      })
    },

    'one-team-scorekeeper-settings': async ctx => {
      await scenario(ctx, async run => {
        const { stack } = run
        const file = 'settings-scorekeeper-swap.log'
        const fresh = await lineupsSaved(run, file)
        await oneTeamScorekeeper(run, fresh, file)
        await stack.query(file, playsState, [fresh.gameId])
        const browser = await window(run)
        await as(run, browser, fresh, 'member')
        await settingsSwap(
          browser,
          fresh.gameId,
          'settings-scorekeeper-after.png'
        )
        await browser.waitText('Home and away swapped: Visitors vs Hosts')
        await browser.capture('settings-scorekeeper-swapped.png')
        stack.note(
          file,
          'member (scorekeeper of the home team only): game screen gear, Swap home and away, Save; swapped at once\n'
        )
        await stack.query(file, playsState, [fresh.gameId])

        const begun = await lineupsSaved(run, file)
        await oneTeamScorekeeper(run, begun, file)
        await stack.score(begun, intoTheSecond)
        await as(run, browser, begun, 'member')
        await settingsSwap(browser, begun.gameId)
        await browser.waitText(
          'Resets all game plays: 7 at-bats in 2 innings will be lost.'
        )
        await browser.capture('settings-reset-confirm.png')
        await browser.tap('Reset and Swap')
        await browser.waitText('Home and away swapped: Visitors vs Hosts')
        stack.note(
          file,
          'member on a game with plays: Save asked "Resets all game plays: 7 at-bats in 2 innings will be lost.", then Reset and Swap\n'
        )
        await stack.query(file, playsState, [begun.gameId])
      })
    },

    'older-app-swap-proposal': async ctx => {
      await scenario(ctx, async run => {
        const { stack } = run
        const file = 'settings-old-app-swap.log'
        const protocol = await protocolHeader()
        const propose = async (
          world: LineupWorld,
          key: string
        ): Promise<{ status: number; answer: Record<string, unknown> }> => {
          const token = await stack.tokenOf(world, 'member')
          const read = (await (
            await fetch(`${stack.api}/games/${world.gameId}/scheduling`, {
              headers: { authorization: `Bearer ${token}` }
            })
          ).json()) as { version: string; game: Record<string, unknown> }
          // As Game Settings' Save builds it (gameProposalFields): the stored
          // game with its sides exchanged and this device's time zone.
          const body = {
            sender: { kind: 'team', id: world.teams.home },
            initiatingTeamId: world.teams.home,
            gameId: world.gameId,
            expected: read.version,
            game: {
              ...read.game,
              homeTeamId: read.game.awayTeamId,
              awayTeamId: read.game.homeTeamId,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
            },
            idempotencyKey: key
          }
          const response = await fetch(`${stack.api}/game-requests`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              ...protocol
            },
            body: JSON.stringify(body)
          })
          const answer = (await response.json()) as Record<string, unknown>
          stack.note(
            file,
            `$ POST ${stack.api}/game-requests  (member, scorekeeper of the home team only: Swap home and away)\n${response.status} ${JSON.stringify({ status: answer.status, message: answer.message })}\n`
          )
          return { status: response.status, answer }
        }
        const fresh = await lineupsSaved(run, file)
        await oneTeamScorekeeper(run, fresh, file)
        const accepted = await propose(fresh, `t8-fresh-${fresh.gameId}`)
        expect(
          [accepted.status, accepted.answer.status],
          'the swap accepted at once'
        ).deep.equals([201, 'accepted'])
        await stack.query(file, playsState, [fresh.gameId])
        const begun = await lineupsSaved(run, file)
        await oneTeamScorekeeper(run, begun, file)
        await stack.score(begun, [{ type: 'pitch', call: 'B' }])
        const refused = await propose(begun, `t8-begun-${begun.gameId}`)
        expect(
          [refused.status, refused.answer.message],
          'the swap of a begun game refused'
        ).deep.equals([
          409,
          'This game has plays. Swap it from the scoring menu, which resets them.'
        ])
        await stack.query(file, playsState, [begun.gameId])
      })
    }
  }
})
