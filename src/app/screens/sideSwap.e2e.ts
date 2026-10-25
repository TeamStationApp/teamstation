import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import pg from 'pg'

import { HttpError } from '../../common/errors'
import { setupOf } from '../../common/scoring/state'
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
  pause,
  PHONE_HEIGHT,
  PHONE_WIDTH,
  proposeSwap,
  query,
  rosterSaves,
  score,
  sides,
  spawnText,
  swapGame,
  tokenOf,
  UNLOADED,
  UNREAD,
  WIDTH,
  writeArtifactsTo
} from '../../test/scoringBrowser.e2e'

/**
 * Home and away swapped before the first pitch, end to end, against the real
 * local stack — the API with its game socket (`npm start`), the web app built
 * against it (`npm run start.web`) and a game from `npm run lineup-fixture`,
 * made afresh for each scenario — in maestro-d's Chromium.
 *
 *   MAESTRO_D=side-swap-browser MAESTRO_D_BIN=… TS_MAESTRO_D_CLIENT=… \
 *   TS_SCORING_TEST_URL=http://127.0.0.1:8190 \
 *   TS_API_TEST_URL=http://127.0.0.1:9190/api/v1 \
 *   TS_LINEUP_PASSWORD=<the fixture's password> \
 *   SIDE_SWAP_ARTIFACTS=<dir> \
 *     node_modules/.bin/mocha -r sucrase/register --extension ts \
 *     --timeout 180000 src/app/screens/sideSwap.e2e.ts
 *
 * `SIDE_SWAP_MODE=before`, run in a checkout of the code before this change,
 * records what that code does with the same steps: the swap refused, Game
 * Settings showing it, and the scoring screen of a game whose team ids and
 * lineups are exchanged straight in the database.
 */

const ARTIFACTS = process.env.SIDE_SWAP_ARTIFACTS
const BEFORE = process.env.SIDE_SWAP_MODE === 'before'
const REFUSED = 'Home and away can be swapped only before the first pitch'
writeArtifactsTo(ARTIFACTS)

describe('home and away swapped before the first pitch', function () {
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
    daemon = await maestro(process.env.MAESTRO_D ?? 'side-swap-browser')
    const session = await browserSession(
      daemon,
      'side-swap-chromium',
      WIDTH,
      HEIGHT,
      join(tmpdir(), 'side-swap-e2e')
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

  /** A second browser at a phone's size, for what is captured there. */
  async function phone<T>(run: (phone: Browser) => Promise<T>): Promise<T> {
    const session = await browserSession(
      daemon!,
      'side-swap-phone',
      PHONE_WIDTH,
      PHONE_HEIGHT,
      join(tmpdir(), 'side-swap-e2e')
    )
    session.page.setDefaultTimeout(30000)
    try {
      return await run(new Browser(session, session.page))
    } finally {
      await session.m.detach()
      await session.browser.close()
    }
  }

  /** A fresh game with lineups saved, a home guest and an away player out. */
  async function preparedGame(file: string | null): Promise<LineupFixture> {
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
      `$ POST ${API}/games/${fixture.gameId}/guest-players  {"side":"home","firstName":"Gus","lastName":"Guest"}\n${JSON.stringify({ userId: guest.userId })}\n`
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
      `$ PUT ${API}/games/${fixture.gameId}/unroster  {"side":"away","userId":"<${bench.name}>","rostered":false}\nunrostered\n`
    )
    return fixture
  }

  if (BEFORE) {
    it('before: the swap is refused once lineups are saved, and a game swapped under the scoring screen does not load', async function () {
      const file = 'swap-refused-before.log'
      const fixture = await preparedGame(file)
      await sides(file, fixture.gameId)
      try {
        await swapGame(fixture, file)
        await note(file, 'the swap was accepted')
      } catch (error) {
        await note(
          file,
          `$ POST ${API}/game-requests  (home head coach: Swap home and away)\nrefused: ${error instanceof HttpError ? `${error.code} ${error.message}` : String(error)}\n`
        )
      }
      await sides(file, fixture.gameId)

      await browser.as(fixture, 'headCoach')
      await browser.swapInSettings(fixture.gameId)
      await browser.waitText('original teams', 30000).catch(() => undefined)
      await browser.capture('game-settings-swap-before.png')

      // Tonight's first repair: the team ids and the record's lineups
      // exchanged straight in the database, the guests left where they were.
      const client = new pg.Client({ connectionString: databaseUrl() })
      await client.connect()
      try {
        await client.query(
          `update games set home_team_id = away_team_id, away_team_id = home_team_id,
             "currentPlay" = jsonb_set("currentPlay", '{teamStation}',
               ("currentPlay"->'teamStation') || jsonb_build_object(
                 'actions', (select jsonb_agg(a || jsonb_build_object('setup',
                     (a->'setup') || jsonb_build_object('sides', jsonb_build_object(
                       'home', a->'setup'->'sides'->'away', 'away', a->'setup'->'sides'->'home'))))
                   from jsonb_array_elements("currentPlay"->'teamStation'->'actions') a),
                 'setupBefore', ("currentPlay"->'teamStation'->'setupBefore') || jsonb_build_object('sides', jsonb_build_object(
                   'home', "currentPlay"->'teamStation'->'setupBefore'->'sides'->'away',
                   'away', "currentPlay"->'teamStation'->'setupBefore'->'sides'->'home'))))
           where id = $1`,
          [fixture.gameId]
        )
      } finally {
        await client.end()
      }
      await browser.as(fixture, 'scorekeeper')
      await browser.scoreGame(fixture.gameId)
      await new Promise(resolve => setTimeout(resolve, 2000))
      await browser.capture('scoring-after-swap-before.png')
      const shown = await browser.text()
      await note(
        file,
        `scoring screen after the database swap: ${shown.includes(UNLOADED) ? UNLOADED : shown.includes(UNREAD) ? 'read-only: saved plays could not be read back' : 'opened'}\n`
      )
    })

    it('before: the scoring menu offers no swap, and the upper left no speaker', async function () {
      const fixture = await preparedGame(null)
      const batter = `Batter ${fixture.players.away[0].name}`
      await browser.as(fixture, 'scorekeeper')
      await browser.scoreGame(fixture.gameId)
      await browser.waitText(batter, 60000)
      await browser.capture('scoring-sound-before.png')
      await browser.tap('Open scoring menu')
      await browser.waitText('End Game')
      await browser.capture('scoring-menu-before.png')
      expect(await browser.text()).not.includes('Swap Home and Away')
      await phone(async phone => {
        await phone.as(fixture, 'scorekeeper')
        await phone.scoreGame(fixture.gameId)
        await phone.waitText(batter, 60000)
        await phone.capture('scoring-sound-phone-before.png')
      })
    })
    return
  }

  it('E1, E2: a game with lineups, a guest and an absence swaps, and a stale device is refused', async function () {
    const file = 'swap-with-lineups-after.log'
    const fixture = await preparedGame(file)
    const before = await sides(file, fixture.gameId)
    // What the scorekeeper's device holds: the game as it read it.
    const scorer = await clientOf(fixture, 'scorekeeper')
    const held = await scorer.gameEvents(fixture.gameId)
    expect(held.lineupsDigest).a('string')
    await swapGame(fixture, file)
    const after = await sides(file, fixture.gameId)
    expect(after.home).equals(before.away)
    expect(after.away).equals(before.home)
    // Kept by team, the guests and absences are as they were.
    expect(after.guests).deep.equals(before.guests)
    expect(after.unrostered).deep.equals(before.unrostered)
    expect(after.lineups_digest).not.equals(before.lineups_digest)
    const lineups = await (
      await clientOf(fixture, 'scorekeeper')
    ).gameLineups(fixture.gameId)
    // The hosts, away now, bat first.
    expect(lineups.away.current?.batters[0]?.name).equals(
      fixture.players.home[0].name
    )
    await note(
      file,
      `$ GET ${API}/games/${fixture.gameId}/lineups\n${JSON.stringify(lineups, null, 2).slice(0, 4000)}\n`
    )

    const stale = 'stale-after-swap.log'
    let refusal: unknown
    try {
      await scorer.saveGameEvents(fixture.gameId, {
        plays: [],
        remove: [],
        currentPlay: held.currentPlay,
        lineupsBase: held.lineupsDigest
      })
    } catch (error) {
      refusal = error
    }
    await note(
      stale,
      `$ POST ${API}/games/${fixture.gameId}/events  (scorekeeper's device: its lineups from before the swap, lineupsBase ${String(held.lineupsDigest).slice(0, 12)}…)\n${refusal instanceof HttpError ? `${refusal.status} ${refusal.code} ${refusal.message} ${JSON.stringify(refusal.details)}` : `accepted: ${String(refusal)}`}\n`
    )
    expect(refusal).instanceOf(HttpError)
    expect((refusal as HttpError).details).deep.equals({ stale: true })
    await sides(stale, fixture.gameId)
  })

  it('E3: Game Settings swaps a game with saved lineups', async function () {
    const file = 'game-settings-swap-after.log'
    const fixture = await preparedGame(file)
    await browser.as(fixture, 'headCoach')
    await browser.swapInSettings(fixture.gameId)
    await browser.waitText('Game proposal sent', 30000).catch(async () => {
      await browser.waitText('Game changes saved', 5000)
    })
    const pending = await (
      await clientOf(fixture, 'awayCoach')
    ).gameProposals({ kind: 'team', id: fixture.teams.away })
    const request = pending.find(
      r => r.gameId === fixture.gameId && r.status === 'pending'
    )
    if (request != null)
      await (
        await clientOf(fixture, 'awayCoach')
      ).decideGameRequest(request.requestId, 'accept')
    await browser.page.goto(`${APP}/games/${fixture.gameId}`, {
      waitUntil: 'domcontentloaded'
    })
    await browser.waitText('Visitors', 60000)
    await browser.capture('game-after-swap.png')
    const row = await sides(file, fixture.gameId)
    expect(row.home).equals('Visitors')
    // Game Settings again, framed as the refusal was: at Save, with no error.
    await browser.page.goto(`${APP}/games/${fixture.gameId}/settings`, {
      waitUntil: 'domcontentloaded'
    })
    await browser.page.waitForSelector('[aria-label="Swap home and away"]', {
      timeout: 60000
    })
    await browser.showButton('Save')
    const shown = await browser.text()
    expect(shown).not.includes(REFUSED)
    expect(shown).not.includes('original teams')
    await browser.capture('game-settings-swap-after.png')
    await note(
      file,
      `Game Settings after the swap: Save offered, no refusal shown\n`
    )
  })

  it('E4: an open scoring screen reopens on the swapped sides', async function () {
    const file = 'scoring-after-swap-after.log'
    const fixture = await preparedGame(file)
    await browser.as(fixture, 'scorekeeper')
    await browser.scoreGame(fixture.gameId)
    await browser.waitText(`Batter ${fixture.players.away[0].name}`, 60000)
    await swapGame(fixture, file)
    await browser.waitText(`Batter ${fixture.players.home[0].name}`, 60000)
    await new Promise(resolve => setTimeout(resolve, 1500))
    const shown = await browser.text()
    expect(shown).not.includes(UNLOADED)
    expect(shown).not.includes(UNREAD)
    await browser.capture('scoring-after-swap-after.png')
    await note(
      file,
      `scoring screen after the swap: reopened, ${fixture.players.home[0].name} due up\n`
    )
  })

  it("E5, E6: after a pitch a coach's swap is refused through the API, and a scorekeeper's in Game Settings resets the game", async function () {
    const file = 'swap-after-pitch-refused.log'
    const fixture = await preparedGame(file)
    await score(fixture, [{ type: 'pitch', call: 'B' }])
    await note(
      file,
      `$ POST ${API}/games/${fixture.gameId}/events  (scorekeeper: one pitch, a ball)\nsaved\n`
    )
    const before = await sides(file, fixture.gameId)
    try {
      await proposeSwap(fixture, 'headCoach')
      expect.fail('the swap was accepted after a pitch')
    } catch (error) {
      await note(
        file,
        `$ POST ${API}/game-requests  (home head coach: Swap home and away)\n${error instanceof HttpError ? `${error.code} ${error.message}` : String(error)}\n`
      )
      expect(error instanceof HttpError ? error.message : '').equals(REFUSED)
    }
    expect((await sides(file, fixture.gameId)).home).equals(before.home)

    // A scorekeeper may swap there: the game's plays are reset first.
    await browser.as(fixture, 'scorekeeper')
    await browser.swapInSettings(fixture.gameId)
    await browser.waitText(
      'Resets all game plays: 1 at-bat in 1 inning will be lost.',
      30000
    )
    await browser.capture('game-settings-after-pitch.png')
    await browser.tap('Reset and Swap')
    await browser.waitText('Home and away swapped', 30000)
    const reset = await sides(file, fixture.gameId)
    expect(reset.home).equals(before.away)
    await note(
      file,
      'scorekeeper in Game Settings: Swap home and away, Save, Reset and Swap; the game was reset and swapped\n'
    )
  })

  it('E7: the schedule import flips a game holding lineups', async function () {
    const file = 'schedule-import-swap.log'
    const fixture = lineupFixture()
    await query(
      file,
      `insert into scope_roles (id, user_id, scope_type, scope_id, role)
         values ('sr_' || md5(random()::text), $1, 'team', $2, 'admin'),
                ('sr_' || md5(random()::text), $1, 'season', $3, 'admin')
         on conflict do nothing returning scope_type, role`,
      [fixture.users.headCoach.userId, fixture.teams.home, fixture.seasonId]
    )
    const token = await tokenOf(fixture, 'headCoach')
    const startAt = new Date(Date.now() + 3 * 86400_000).toISOString()
    const row = (side: 'home' | 'away'): Record<string, unknown> => ({
      opponent: { name: 'Riverside Otters' },
      side,
      startAt,
      externalId: { system: 'sideSwapE2e', id: `otters-${fixture.gameId}` }
    })
    const post = async (side: 'home' | 'away'): Promise<unknown> => {
      const response = await fetch(`${API}/teams/${fixture.teams.home}/games`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ games: [row(side)] })
      })
      const body = (await response.json()) as unknown
      await note(
        file,
        `$ POST ${API}/teams/${fixture.teams.home}/games  ${JSON.stringify({ games: [row(side)] })}\n${response.status} ${JSON.stringify(body)}\n`
      )
      return body
    }
    const created = (await post('home')) as {
      results: Array<{ gameId: string }>
    }
    const gameId = created.results[0].gameId
    const imported = { ...fixture, gameId }
    // The opponent is outside TeamStation: only the home lineup is saved.
    await score(imported, state => [
      {
        type: 'lineup',
        kind: 'roster',
        setup: setupOf(state),
        confirmed: ['home']
      }
    ])
    await note(
      file,
      `$ POST ${API}/games/${gameId}/events  (scorekeeper: the home lineup saved, no pitch)\nsaved\n`
    )
    await (
      await clientOf(fixture, 'headCoach')
    ).createGuestPlayer(gameId, 'home', {
      firstName: 'Gus',
      lastName: 'Guest',
      jersey: '77',
      positions: [],
      bats: null,
      throws: null
    })
    const before = await sides(file, gameId)
    const flipped = (await post('away')) as {
      results: Array<{ result: string }>
    }
    expect(flipped.results[0].result).equals('updated')
    const after = await sides(file, gameId)
    expect(after.home).equals(before.away)
    expect((after.guests as { away: number[] }).away).deep.equals(
      (before.guests as { home: number[] }).home
    )
    // The Hosts' lineup is now the away one, in its order.
    const lineups = await (
      await clientOf(fixture, 'headCoach')
    ).gameLineups(gameId)
    await note(
      file,
      `$ GET ${API}/games/${gameId}/lineups\n${JSON.stringify(
        {
          away: {
            teamName: lineups.away.teamName,
            batters: lineups.away.current?.batters.map(batter => batter.name)
          },
          home: {
            teamName: lineups.home.teamName,
            batters: lineups.home.current?.batters.map(batter => batter.name)
          }
        },
        null,
        2
      )}\n`
    )
    expect(lineups.away.teamId).equals(fixture.teams.home)
    expect(
      lineups.away.current?.batters.map(batter => batter.name)
    ).deep.equals(fixture.players.home.slice(0, 9).map(player => player.name))
    // No matchup is written either way: the Otters, outside TeamStation,
    // have no lineup and no pitcher.
  })

  it('E8: the scoring menu swaps home and away, from right above End Game', async function () {
    const file = 'scoring-menu-swap.log'
    const fixture = await preparedGame(file)
    const before = await sides(file, fixture.gameId)
    await browser.as(fixture, 'scorekeeper')
    await browser.scoreGame(fixture.gameId)
    await browser.waitText(`Batter ${fixture.players.away[0].name}`, 60000)
    await browser.tap('Open scoring menu')
    await browser.waitText('Swap Home and Away')
    expect(await browser.menuOrder()).deep.equals([
      'Exit Current Game',
      'Settings',
      'Overrides',
      'End Half Inning',
      'Set Team Rosters',
      'Swap Home and Away',
      'End Game'
    ])
    await browser.capture('scoring-menu-after.png')
    await browser.tap('Swap Home and Away')
    await browser.tap('Confirm Swap')
    await browser.waitText(`Batter ${fixture.players.home[0].name}`, 60000)
    await browser.waitText('Home and away were swapped')
    await browser.capture('scoring-menu-swapped.png')
    const after = await sides(file, fixture.gameId)
    expect(after.home).equals(before.away)
    expect(after.away).equals(before.home)
    await note(
      file,
      `scoring menu: Swap Home and Away, then Confirm Swap; the screen opened again with ${fixture.players.home[0].name} due up\n`
    )

    // After a pitch the item is on, and says it resets the game's plays.
    const pitched = await preparedGame(null)
    await score(pitched, [{ type: 'pitch', call: 'B' }])
    await browser.as(pitched, 'scorekeeper')
    await browser.scoreGame(pitched.gameId)
    await browser.tap('Open scoring menu')
    await browser.waitText('resets all game plays')
    expect(await browser.isDisabled('Swap Home and Away')).equals(false)
    await note(
      file,
      `$ POST ${API}/games/${pitched.gameId}/events  (scorekeeper: one pitch, a ball)\nsaved\nscoring menu after the pitch: Swap Home and Away, "resets all game plays"\n`
    )

    // At a phone's size every row shows, End Game included.
    const small = await preparedGame(null)
    await phone(async phone => {
      await phone.as(small, 'scorekeeper')
      await phone.scoreGame(small.gameId)
      await phone.waitText(`Batter ${small.players.away[0].name}`, 60000)
      await phone.tap('Open scoring menu')
      await phone.waitText('End Game')
      expect(await phone.onScreen('End Game')).equals(true)
      await phone.capture('scoring-menu-phone-after.png')
    })
  })

  it('E9: the speaker at the upper left mutes the game, and stays muted', async function () {
    const file = 'scoring-sound-cues.log'
    const fixture = await preparedGame(file)
    await browser.as(fixture, 'scorekeeper')
    await browser.scoreGame(fixture.gameId)
    await browser.waitText(`Batter ${fixture.players.away[0].name}`, 60000)
    // The browser keeps the scorekeeper's preferences from run to run: start
    // from sounds on.
    await browser.waitText('game sounds')
    if (await browser.has('Unmute game sounds')) {
      await browser.tap('Unmute game sounds')
      await browser.waitText('Mute game sounds')
    }
    await browser.capture('scoring-sound-after.png')

    // The first pitch opens the page's audio; the recording takes two
    // pitches with the speaker on, then two after the tap.
    await browser.tap('Called Strike')
    await pause(2500)
    expect(await browser.page.evaluate('window.__gameAudio.start()')).equals(
      true
    )
    const started = Date.now()
    for (let pitch = 0; pitch < 2; pitch++) {
      await browser.tap('Called Strike')
      await pause(2500)
    }
    const muted = (Date.now() - started) / 1000
    await browser.tap('Mute game sounds')
    await browser.waitText('Unmute game sounds')
    await browser.capture('scoring-sound-muted.png')
    for (let pitch = 0; pitch < 2; pitch++) {
      await browser.tap('Called Strike')
      await pause(2500)
    }
    const recorded = String(
      await browser.page.evaluate('window.__gameAudio.stop()')
    )
    const length = (Date.now() - started) / 1000
    const scratch = join(tmpdir(), 'side-swap-e2e', 'scoring-sound-cues.webm')
    await mkdir(join(tmpdir(), 'side-swap-e2e'), { recursive: true })
    await writeFile(scratch, Buffer.from(recorded, 'base64'))
    const ogg = join(
      ARTIFACTS ?? join(tmpdir(), 'side-swap-e2e'),
      'scoring-sound-cues.ogg'
    )
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', scratch, ogg])
    await note(
      file,
      `$ ffmpeg -i <the page's recording>.webm scoring-sound-cues.ogg\n(the speaker tapped at ${muted.toFixed(1)} s of ${length.toFixed(1)} s)\n`
    )
    const loudness = async (
      from: number,
      span: number,
      which: string
    ): Promise<number> => {
      const args = [
        '-hide_banner',
        '-ss',
        from.toFixed(2),
        '-t',
        span.toFixed(2),
        '-i',
        ogg,
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-'
      ]
      const report = spawnText('ffmpeg', args)
      const lines = report
        .split('\n')
        .filter(line => /mean_volume|max_volume/.test(line))
        .map(line => line.replace(/^.*\] /, ''))
      await note(
        file,
        `$ ffmpeg ${args.join(' ')}   (${which})\n${lines.join('\n')}\n`
      )
      const max = /max_volume: (-?[\d.]+|-inf) dB/.exec(report)
      return max == null || max[1] === '-inf' ? -Infinity : Number(max[1])
    }
    const on = await loudness(0, muted, 'speaker on: two pitches')
    const off = await loudness(
      muted + 0.5,
      length - muted - 0.5,
      'speaker off: two pitches'
    )
    expect(on, 'the cues with the speaker on').above(-40)
    expect(off, 'nothing after the tap').below(-60)

    // Opened again, it is still muted, and Settings agrees.
    await browser.scoreGame(fixture.gameId)
    await browser.waitText('Unmute game sounds')
    await browser.tap('Open scoring menu')
    await browser.tap('Settings')
    await browser.waitText('Scoring sound')
    expect(await browser.switchOn('Toggle scoring sound')).equals(false)
    await note(
      file,
      'opened again: the speaker reads Unmute game sounds, and Settings has Scoring sound off\n'
    )
    // Settings' switch is the same setting: turned on there, the speaker
    // follows. Sounds stay on for the next run.
    await browser.tap('Toggle scoring sound')
    await browser.waitText('Mute game sounds')
    expect(await browser.switchOn('Toggle scoring sound')).equals(true)
    await note(
      file,
      "Settings' Scoring sound switched back on: the speaker reads Mute game sounds\n"
    )

    // At a phone's size: the speaker clear of the scoreboard and ☰, and the
    // instruction toast between them.
    const small = await preparedGame(null)
    await phone(async phone => {
      await phone.as(small, 'scorekeeper')
      await phone.scoreGame(small.gameId)
      await phone.waitText(`Batter ${small.players.away[0].name}`, 60000)
      await phone.waitText('game sounds')
      const speaker = (await phone.has('Mute game sounds'))
        ? 'Mute game sounds'
        : 'Unmute game sounds'
      await phone.capture('scoring-sound-phone-after.png')
      // A single: the screen asks where the ball went.
      await phone.tap('Swing in Play')
      await phone.tap('Single')
      await pause(800)
      expect(await phone.uncovered(speaker)).equals(true)
      expect(await phone.uncovered('Open scoring menu')).equals(true)
      await phone.capture('scoring-sound-phone-instruction.png')
    })
  })
})
