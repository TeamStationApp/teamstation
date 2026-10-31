import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { after, before, describe, it } from 'mocha'
import pg from 'pg'

import { browserSession, maestro } from '../../../e2e/rigs/refinementsMaestro'
import {
  API,
  APP,
  Browser,
  clientOf,
  databaseUrl,
  HEIGHT,
  lineupFixture,
  note,
  PASSWORD,
  PHONE_HEIGHT,
  PHONE_WIDTH,
  query,
  rosterSaves,
  score,
  spawnText,
  tokenOf,
  WIDTH,
  writeArtifactsTo
} from '../../../e2e/rigs/scoringBrowser'
import type { ScoringAction } from '../../common/scoring/actions'
import type { LineupFixture } from '../../server/dev/lineupFixture'

/**
 * Team-keyed lineups, end to end, against the real local stack — the API
 * with its game socket, the web app built against it and a game from
 * `npm run lineup-fixture`, made afresh for each scenario — in maestro-d's
 * Chromium.
 *
 *   MAESTRO_D=team-keyed-browser MAESTRO_D_BIN=… TS_MAESTRO_D_CLIENT=… \
 *   TS_SCORING_TEST_URL=http://127.0.0.1:8190 \
 *   TS_API_TEST_URL=http://127.0.0.1:9190/api/v1 \
 *   TS_LINEUP_PASSWORD=<the fixture's password> \
 *   TEAM_KEYED_ARTIFACTS=<dir> \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 180000 src/app/screens/teamKeyedLineups.e2e.ts
 *
 * `TEAM_KEYED_MODE=before`, run in a checkout of the code before this
 * change, records what that code does with the same steps: a lineup save
 * writing a Gumbo current play, the menu's swap after a pitch, and a
 * one-team scorekeeper's game screen.
 */

const ARTIFACTS = process.env.TEAM_KEYED_ARTIFACTS
const BEFORE = process.env.TEAM_KEYED_MODE === 'before'
writeArtifactsTo(ARTIFACTS)

/** Makes the fixture's plain member a scorekeeper of the home team alone. */
async function oneTeamScorekeeper(
  fixture: LineupFixture,
  file: string | null
): Promise<void> {
  await query(
    file,
    `insert into scope_roles (id, user_id, scope_type, scope_id, role)
       values ('sr_' || md5(random()::text), $1, 'team', $2, 'scorekeeper')
       on conflict do nothing returning scope_type, role`,
    [fixture.users.member.userId, fixture.teams.home]
  )
}

describe('team-keyed lineups, and reset with swap', function () {
  let daemon: Awaited<ReturnType<typeof maestro>> | undefined
  let browser: Browser

  before(async function () {
    if (PASSWORD === '')
      throw new Error('Supply TS_LINEUP_PASSWORD, the lineup fixture password')
    for (const url of [APP, API])
      if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
        throw new Error(`${url} must be a local server`)
    if (ARTIFACTS != null) await mkdir(ARTIFACTS, { recursive: true })
    // A local database starts before the organization cutover a deployed
    // node has made; game requests and Game Settings wait for it.
    const client = new pg.Client({ connectionString: databaseUrl() })
    await client.connect()
    try {
      await client.query(
        `insert into system_settings (key, value) values ('creation.hierarchyReady', 'true')
           on conflict (key) do update set value = 'true'`
      )
    } finally {
      await client.end()
    }
    daemon = await maestro(process.env.MAESTRO_D ?? 'team-keyed-browser')
    const session = await browserSession(
      daemon,
      'team-keyed-chromium',
      WIDTH,
      HEIGHT,
      join(tmpdir(), 'team-keyed-e2e')
    )
    session.page.setDefaultTimeout(30000)
    browser = new Browser(session, session.page)
  })

  after(async function () {
    if (browser != null && browser.errors.length > 0)
      console.log(`    browser errors: ${browser.errors.join('\n')}`)
    try {
      await browser?.session.browser.close()
    } finally {
      await daemon?.shutdown()
    }
  })

  /** A second browser at a phone's size, open beside the first. */
  async function phone<T>(run: (phone: Browser) => Promise<T>): Promise<T> {
    const session = await browserSession(
      daemon!,
      'team-keyed-phone',
      PHONE_WIDTH,
      PHONE_HEIGHT,
      join(tmpdir(), 'team-keyed-e2e')
    )
    session.page.setDefaultTimeout(30000)
    try {
      return await run(new Browser(session, session.page))
    } finally {
      await session.m.detach()
      await session.browser.close()
    }
  }

  /** A fresh game, its lineups saved by the scorekeeper. */
  async function lineupsSaved(file: string | null): Promise<LineupFixture> {
    const fixture = lineupFixture()
    await note(
      file,
      `$ npm run lineup-fixture -- --password <the fixture password>\ngame ${fixture.gameId}: Hosts (home) vs Visitors (away)\n`
    )
    await score(fixture, rosterSaves)
    await note(
      file,
      `$ POST ${API}/games/${fixture.gameId}/events  (scorekeeper: three roster saves, no pitch)\nsaved\n`
    )
    return fixture
  }

  if (BEFORE) {
    it('before: a lineup save writes a Gumbo current play, the swap is off after a pitch, and a one-team scorekeeper has no Game Settings', async function () {
      const file = 'pregame-storage-before.log'
      const fixture = await lineupsSaved(file)
      await query(
        file,
        `select "currentPlay" is not null as "currentPlayWritten",
                "currentPlay"->'about'->>'halfInning' as "half",
                "currentPlay"->'matchup'->'batter'->>'fullName' as "dueUp",
                jsonb_typeof("currentPlay"->'teamStation'->'setupBefore'->'sides') as "recordKeyedBySide",
                lineups_digest is not null as "digest"
           from games where id = $1`,
        [fixture.gameId]
      )

      await browser.as(fixture, 'scorekeeper')
      await browser.scoreGame(fixture.gameId)
      await browser.waitText(`Batter ${fixture.players.away[0].name}`, 60000)
      await browser.tap('Ball')
      await browser.tap('Open scoring menu')
      await browser.waitText('End Game')
      await browser.capture('scoring-menu-after-pitch-before.png')

      const scorer = lineupFixture()
      await oneTeamScorekeeper(scorer, null)
      await browser.as(scorer, 'member')
      await browser.page.goto(`${APP}/games/${scorer.gameId}`, {
        waitUntil: 'domcontentloaded'
      })
      await browser.waitText('Hosts', 60000)
      await new Promise(resolve => setTimeout(resolve, 2000))
      await browser.capture('settings-scorekeeper-before.png')
    })
    return
  }

  it('T1: stored records name teams, and a refold of an older game changes only its records', async function () {
    const file = 'record-by-team.log'
    const fixture = lineupFixture()
    await note(
      file,
      `$ npm run lineup-fixture -- --password <the fixture password>\ngame ${fixture.gameId}: Hosts (home) vs Visitors (away)\n`
    )
    const bench = fixture.players.away[9]
    await score(fixture, (game): ScoringAction[] => [
      ...rosterSaves(game),
      { type: 'pitch', call: 'B' },
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'away',
        player: bench.gumboId,
        replaces: fixture.players.away[0].gumboId
      },
      { type: 'result', eventType: 'intent_walk' },
      { type: 'gameFlow', kind: 'closePlay' }
    ])
    await note(
      file,
      `$ POST ${API}/games/${fixture.gameId}/events  (scorekeeper: roster saves, a ball, a pinch hitter for the leadoff, an intentional walk)\nsaved\n`
    )
    await query(
      file,
      `select e."atBatIndex", e.gumbo->'teamStation'->>'version' as "version",
              (select array_agg(k order by k) from jsonb_object_keys(e.gumbo->'teamStation'->'setupBefore'->'teams') k) as "setupTeams",
              e.gumbo->'teamStation'->'setupBefore' ? 'sides' as "keyedBySide",
              (select array_agg(distinct a->>'teamId') from jsonb_array_elements(e.gumbo->'teamStation'->'actions') a where a->>'teamId' is not null) as "lineupChangesNameTeams",
              g.away_team_id as "awayTeam", g.home_team_id as "homeTeam"
         from events e join games g on g.id = e."gameId"
        where e."gameId" = $1 order by 1`,
      [fixture.gameId]
    )
    const [older] = await query(
      null,
      `select id from games where "currentPlay"->'teamStation'->>'version' = '2'
          or exists (select 1 from events e where e."gameId" = games.id and e.gumbo->'teamStation'->>'version' = '2')
        order by updated_at desc limit 1`
    )
    if (older == null) {
      await note(file, 'no version 2 game in this database to refold\n')
      return
    }
    const preview = spawnText('npm', [
      'run',
      '--silent',
      'refold-scored-games',
      '--',
      '--game',
      String(older.id),
      '--preview'
    ])
    await note(
      file,
      `$ npm run refold-scored-games -- --game ${String(older.id)} --preview\n${preview}`
    )
  })

  it('T2: guests and players left off are stored by team, and the game still answers by side', async function () {
    const file = 'availability-by-team.log'
    const fixture = lineupFixture()
    await note(
      file,
      `$ npm run lineup-fixture -- --password <the fixture password>\ngame ${fixture.gameId}: Hosts (home) vs Visitors (away)\n`
    )
    const coach = await clientOf(fixture, 'headCoach')
    const guest = await coach.createGuestPlayer(fixture.gameId, 'home', {
      firstName: 'Gus',
      lastName: 'Guest',
      jersey: '77',
      positions: [],
      bats: null,
      throws: null
    })
    await note(
      file,
      `$ POST ${API}/games/${fixture.gameId}/guest-players  {"side":"home","firstName":"Gus","lastName":"Guest","jersey":"77"}\n${JSON.stringify({ gumboId: guest.gumboId })}\n`
    )
    const bench = fixture.players.away[12]
    await (
      await clientOf(fixture, 'awayCoach')
    ).setRostered(fixture.gameId, {
      side: 'away',
      userId: bench.userId,
      rostered: false
    })
    await note(
      file,
      `$ PUT ${API}/games/${fixture.gameId}/unroster  {"side":"away","userId":"<${bench.name}>","rostered":false}\nunrostered (gumbo id ${bench.gumboId})\n`
    )
    await query(
      file,
      `select away_team_id as "awayTeam", home_team_id as "homeTeam", guests, unrostered from games where id = $1`,
      [fixture.gameId]
    )
    const detail = await coach.game(fixture.gameId)
    await note(
      file,
      `$ GET ${API}/games/${fixture.gameId}\n${JSON.stringify({ guests: detail.guests, unrostered: detail.unrostered }, null, 2)}\n`
    )
  })

  it('T3: lineups before the first pitch are kept off Gumbo, and a pregame swap exchanges only the teams', async function () {
    const file = 'pregame-storage-after.log'
    const fixture = await lineupsSaved(file)
    const columns = `select "currentPlay" is null as "noAtBatStored",
        pregame->>'version' as "pregameVersion",
        (select array_agg(k order by k) from jsonb_object_keys(pregame->'setupBefore'->'teams') k) as "pregameTeams",
        jsonb_array_length(pregame->'actions') as "pregameActions",
        away_team_id as "awayTeam", home_team_id as "homeTeam", lineups_digest is not null as "digest"
      from games where id = $1`
    await query(file, columns, [fixture.gameId])
    const scorer = await clientOf(fixture, 'scorekeeper')
    const events = await scorer.gameEvents(fixture.gameId)
    const current = events.currentPlay as {
      about: unknown
      teamStation: { version: number }
    } | null
    await note(
      file,
      `$ GET ${API}/games/${fixture.gameId}/events\n${JSON.stringify({ plays: events.plays.length, currentPlay: current == null ? null : { about: current.about, recordVersion: current.teamStation.version } }, null, 2)}\n`
    )
    const lineups = await scorer.gameLineups(fixture.gameId)
    await note(
      file,
      `$ GET ${API}/games/${fixture.gameId}/lineups\naway leadoff: ${String(lineups.away.current?.batters[0]?.name)} (${String(lineups.away.current?.batters[0]?.gumboId)}), expected ${fixture.players.away[0].name}\n`
    )
    const dj = await scorer.djGame(fixture.gameId)
    await note(
      file,
      `$ GET ${API}/games/${fixture.gameId}/dj\nat bat: ${JSON.stringify(dj.atBat)}\n`
    )
    await score(fixture, [{ type: 'pitch', call: 'B' }])
    await note(
      file,
      `$ POST ${API}/games/${fixture.gameId}/events  (scorekeeper: the first pitch, a ball)\nsaved\n`
    )
    await query(file, columns, [fixture.gameId])

    const swapFile = 'pregame-swap.log'
    const other = await lineupsSaved(swapFile)
    const state = `select home_team_id as "homeTeam", away_team_id as "awayTeam", home_score, away_score,
        md5(pregame::text) as "pregame", md5(guests::text) as "guests", md5(unrostered::text) as "unrostered",
        lineups_digest as "digest", "currentPlay" is null as "noAtBatStored"
      from games where id = $1`
    await query(swapFile, state, [other.gameId])
    const scorekeeper = await clientOf(other, 'scorekeeper')
    const read = await scorekeeper.game(other.gameId)
    await scorekeeper.swapGameSides(other.gameId, {
      homeTeamId: read.homeTeamId,
      awayTeamId: read.awayTeamId
    })
    await note(
      swapFile,
      `$ POST ${API}/games/${other.gameId}/swap-sides  {"homeTeamId":"${read.homeTeamId}","awayTeamId":"${read.awayTeamId}"}\nswapped\n`
    )
    await query(swapFile, state, [other.gameId])
  })

  it('T4: a begun game resets and swaps once its plays are confirmed, and a post on the old plays is refused', async function () {
    const file = 'reset-swap.log'
    const fixture = await lineupsSaved(file)
    // Two half-innings of strikeouts, then a ball to the 2nd's leadoff.
    await score(fixture, [
      ...Array.from({ length: 18 }, (): ScoringAction => ({
        type: 'pitch',
        call: 'C'
      })),
      { type: 'pitch', call: 'B' }
    ])
    await note(
      file,
      `$ POST ${API}/games/${fixture.gameId}/events  (scorekeeper: six strikeouts, then a ball)\nsaved\n`
    )
    const state = `select home_team_id as "homeTeam", away_team_id as "awayTeam", status, home_score, away_score,
        "currentPlay" is null as "noAtBatStored", pregame->>'version' as "pregameVersion",
        play_generation as generation,
        (select count(*) from events e where e."gameId" = g.id)::int as plays,
        (select count(*) from game_play_archives a where a.game_id = g.id)::int as archives,
        (select status from game_stats_state s where s.game_id = g.id) as stats,
        (select count(*) from game_player_stats s where s.game_id = g.id)::int as "statLines"
      from games g where id = $1`
    await query(file, state, [fixture.gameId])
    const token = await tokenOf(fixture, 'scorekeeper')
    const call = async (
      method: string,
      path: string,
      body: unknown
    ): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      })
      const answer = { status: response.status, body: await response.json() }
      await note(
        file,
        `$ ${method} ${API}${path}  ${JSON.stringify(body)}\n${answer.status} ${JSON.stringify(answer.body, null, 2)}\n`
      )
      return answer
    }
    const scorer = await clientOf(fixture, 'scorekeeper')
    const read = await scorer.game(fixture.gameId)
    const events = (await (
      await fetch(`${API}/games/${fixture.gameId}/events`, {
        headers: { authorization: `Bearer ${token}` }
      })
    ).json()) as { playsDigest: string; generation: number }
    await note(
      file,
      `$ GET ${API}/games/${fixture.gameId}/events\nplaysDigest ${events.playsDigest}, generation ${events.generation}\n`
    )
    const sides = { homeTeamId: read.homeTeamId, awayTeamId: read.awayTeamId }
    const refused = await call(
      'POST',
      `/games/${fixture.gameId}/swap-sides`,
      sides
    )
    if (refused.status !== 409) throw new Error('The unconfirmed reset went')
    const reset = await call('POST', `/games/${fixture.gameId}/swap-sides`, {
      ...sides,
      playsDigest: events.playsDigest,
      generation: events.generation
    })
    if (reset.status !== 200) throw new Error('The confirmed reset failed')
    await query(file, state, [fixture.gameId])
    // The hosts, away now, bat first: their leadoff is due up.
    const lineups = await scorer.gameLineups(fixture.gameId)
    const leadoff = lineups.away.current?.batters[0]
    await note(
      file,
      `$ GET ${API}/games/${fixture.gameId}/lineups\naway (${lineups.away.teamName}) leadoff: ${String(leadoff?.name)}, expected ${fixture.players.home[0].name}\n`
    )
    if (leadoff?.gumboId !== fixture.players.home[0].gumboId)
      throw new Error('The hosts do not lead off')
    const stale = await call('POST', `/games/${fixture.gameId}/events`, {
      mode: 'live',
      source: { system: 'teamstation' },
      plays: [],
      currentPlay: null,
      generation: events.generation
    })
    if (stale.status !== 409) throw new Error('The stale post went')
    await query(file, state, [fixture.gameId])
  })

  /** Two half-innings of strikeouts, then a ball: the top of the 2nd. */
  const intoTheSecond: ScoringAction[] = [
    ...Array.from({ length: 18 }, (): ScoringAction => ({
      type: 'pitch',
      call: 'C'
    })),
    { type: 'pitch', call: 'B' }
  ]
  const playsState = `select home_team_id as "homeTeam", away_team_id as "awayTeam", status,
      play_generation as generation,
      (select count(*) from events e where e."gameId" = g.id)::int as plays,
      (select count(*) from game_play_archives a where a.game_id = g.id)::int as archives
    from games g where id = $1`

  it('T5: the scoring menu resets and swaps a begun game, and a phone open on it follows', async function () {
    const file = 'reset-menu.log'
    const fixture = await lineupsSaved(file)
    await score(fixture, intoTheSecond)
    await note(
      file,
      `$ POST ${API}/games/${fixture.gameId}/events  (scorekeeper: six strikeouts, then a ball)\nsaved\n`
    )
    await query(file, playsState, [fixture.gameId])
    await phone(async small => {
      await small.as(fixture, 'scorekeeper')
      await small.scoreGame(fixture.gameId)
      // The top of the 2nd: the visitors' fourth batter is up.
      await small.waitText(`Batter ${fixture.players.away[3].name}`, 60000)
      await browser.as(fixture, 'scorekeeper')
      await browser.scoreGame(fixture.gameId)
      await browser.waitText(`Batter ${fixture.players.away[3].name}`, 60000)
      await browser.tap('Open scoring menu')
      await browser.waitText('resets all game plays')
      const row = await browser.labelText('Swap Home and Away')
      if (row !== 'Swap Home and Away\nresets all game plays')
        throw new Error(`The menu row reads ${JSON.stringify(row)}`)
      await browser.capture('scoring-menu-after-pitch-after.png')
      await browser.tap('Swap Home and Away')
      await browser.waitText(
        'Resets all game plays: 7 at-bats in 2 innings will be lost.'
      )
      await browser.capture('reset-confirm.png')
      await note(
        file,
        `scoring menu: "${row.replace('\n', ' / ')}"; the sheet: "Resets all game plays: 7 at-bats in 2 innings will be lost." with Reset and Swap\n`
      )
      await browser.tap('Reset and Swap')
      await browser.waitText(`Batter ${fixture.players.home[0].name}`, 60000)
      await browser.waitText(
        'Home and away were swapped and the game was reset.'
      )
      await browser.capture('reset-swapped.png')
      await small.waitText(`Batter ${fixture.players.home[0].name}`, 60000)
      await small.waitText('the game was reset')
      await small.capture('reset-phone-notice.png')
      await note(
        file,
        `both screens opened again at the top of the 1st with ${fixture.players.home[0].name} due up; the phone says the game was reset\n`
      )
    })
    await query(file, playsState, [fixture.gameId])
  })

  it('T6: before the first pitch the menu swaps with no subtext and no reset', async function () {
    const file = 'swap-pregame-menu.log'
    const fixture = await lineupsSaved(file)
    await browser.as(fixture, 'scorekeeper')
    await browser.scoreGame(fixture.gameId)
    await browser.waitText(`Batter ${fixture.players.away[0].name}`, 60000)
    await browser.tap('Open scoring menu')
    await browser.waitText('Swap Home and Away')
    const row = await browser.labelText('Swap Home and Away')
    if (row !== 'Swap Home and Away')
      throw new Error(`The menu row reads ${JSON.stringify(row)}`)
    await browser.capture('scoring-menu-pregame.png')
    await browser.tap('Swap Home and Away')
    await browser.waitText('will bat first')
    if ((await browser.text()).includes('Resets all game plays'))
      throw new Error('A pregame swap names plays lost')
    await browser.capture('swap-confirm-pregame.png')
    await browser.tap('Confirm Swap')
    await browser.waitText(`Batter ${fixture.players.home[0].name}`, 60000)
    await browser.waitText('Home and away were swapped.')
    await note(
      file,
      `scoring menu: "${row}"; the sheet names no plays; Confirm Swap; ${fixture.players.home[0].name} due up\n`
    )
    await query(file, playsState, [fixture.gameId])
  })

  /** Game Settings from the game screen's gear: Swap home and away, Save. */
  async function settingsSwap(gameId: string, form?: string): Promise<void> {
    await browser.page.goto(`${APP}/games/${gameId}`, {
      waitUntil: 'domcontentloaded'
    })
    await browser.tap('Event settings')
    await browser.waitText(
      "As this game's scorekeeper you can swap home and away."
    )
    if (form != null) await browser.capture(form)
    await browser.tap('Swap home and away')
    await browser.tap('Save')
  }

  it('T7: a one-team scorekeeper swaps from Game Settings, resetting a begun game', async function () {
    const file = 'settings-scorekeeper-swap.log'
    const fresh = await lineupsSaved(file)
    await oneTeamScorekeeper(fresh, file)
    await query(file, playsState, [fresh.gameId])
    await browser.as(fresh, 'member')
    await settingsSwap(fresh.gameId, 'settings-scorekeeper-after.png')
    await browser.waitText('Home and away swapped: Visitors vs Hosts')
    await browser.capture('settings-scorekeeper-swapped.png')
    await note(
      file,
      'member (scorekeeper of the home team only): game screen gear, Swap home and away, Save; swapped at once\n'
    )
    await query(file, playsState, [fresh.gameId])

    const begun = await lineupsSaved(file)
    await oneTeamScorekeeper(begun, file)
    await score(begun, intoTheSecond)
    await browser.as(begun, 'member')
    await settingsSwap(begun.gameId)
    await browser.waitText(
      'Resets all game plays: 7 at-bats in 2 innings will be lost.'
    )
    await browser.capture('settings-reset-confirm.png')
    await browser.tap('Reset and Swap')
    await browser.waitText('Home and away swapped: Visitors vs Hosts')
    await note(
      file,
      'member on a game with plays: Save asked "Resets all game plays: 7 at-bats in 2 innings will be lost.", then Reset and Swap\n'
    )
    await query(file, playsState, [begun.gameId])
  })

  it("T8: an older app's swap-only proposal from a scorekeeper is accepted at once, and refused on a begun game", async function () {
    const file = 'settings-old-app-swap.log'
    const propose = async (
      fixture: LineupFixture,
      key: string
    ): Promise<{ status: number; answer: Record<string, unknown> }> => {
      const token = await tokenOf(fixture, 'member')
      const read = (await (
        await fetch(`${API}/games/${fixture.gameId}/scheduling`, {
          headers: { authorization: `Bearer ${token}` }
        })
      ).json()) as { version: string; game: Record<string, unknown> }
      // As Game Settings' Save builds it (gameProposalFields): the stored
      // game with its sides exchanged and this device's time zone.
      const body = {
        sender: { kind: 'team', id: fixture.teams.home },
        initiatingTeamId: fixture.teams.home,
        gameId: fixture.gameId,
        expected: read.version,
        game: {
          ...read.game,
          homeTeamId: read.game.awayTeamId,
          awayTeamId: read.game.homeTeamId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        },
        idempotencyKey: key
      }
      const response = await fetch(`${API}/game-requests`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      })
      const answer = (await response.json()) as Record<string, unknown>
      await note(
        file,
        `$ POST ${API}/game-requests  (member, scorekeeper of the home team only: Swap home and away)\n${response.status} ${JSON.stringify({ status: answer.status, message: answer.message })}\n`
      )
      return { status: response.status, answer }
    }
    const fresh = await lineupsSaved(file)
    await oneTeamScorekeeper(fresh, file)
    const accepted = await propose(fresh, `t8-fresh-${fresh.gameId}`)
    if (accepted.status !== 201 || accepted.answer.status !== 'accepted')
      throw new Error('The swap was not accepted at once')
    await query(file, playsState, [fresh.gameId])
    const begun = await lineupsSaved(file)
    await oneTeamScorekeeper(begun, file)
    await score(begun, [{ type: 'pitch', call: 'B' }])
    const refused = await propose(begun, `t8-begun-${begun.gameId}`)
    if (
      refused.status !== 409 ||
      refused.answer.message !==
        'This game has plays. Swap it from the scoring menu, which resets them.'
    )
      throw new Error('The swap of a begun game was not refused')
    await query(file, playsState, [begun.gameId])
  })

  it('is driven per milestone', async function () {
    await phone(async () => undefined)
  })
})
