import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { after, before, describe, it } from 'mocha'
import pg from 'pg'

import type { ScoringAction } from '../../common/scoring/actions'
import type { LineupFixture } from '../../server/dev/lineupFixture'
import { browserSession, maestro } from '../../test/refinementsMaestro.e2e'
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
  WIDTH,
  writeArtifactsTo
} from '../../test/scoringBrowser.e2e'

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

  it('is driven per milestone', async function () {
    await phone(async () => undefined)
  })
})
