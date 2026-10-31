import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'

import { expect } from 'chai'
import pg from 'pg'

import { makeId } from '../../common/ids'
import type { NamesFixture } from '../../server/dev/namesFixture'
import {
  type BrowserSession,
  browserSession,
  maestro
} from '../../test/refinementsMaestro.e2e'
import {
  API,
  APP,
  Browser,
  note,
  pause,
  writeArtifactsTo
} from '../../test/scoringBrowser.e2e'

/**
 * E8 of player-names-derived: scoring in the browser stores no names, and a
 * game-only player's corrected name lives on his account.
 *
 * In one maestro-d Chromium tab, signed in as the names fixture's team
 * administrator (who scores his team's games): a new game between the
 * fixture's teams is opened in the scoring screen, a game-only player is
 * added to the other side, the top of the first is scored (a single and
 * three strikeouts), the game-only
 * player's name is corrected in the roster editor and Save Rosters sends it,
 * and scoring is left. The stored plays, at-bat and pregame then hold no
 * name of the game's players, the guest's account carries the correction,
 * and the game reopened after a reload shows it: the guest's roster row
 * reads his corrected short name, and Edit Player on it shows his corrected
 * first and last names.
 *
 *   MAESTRO_D=playerNamesM4 MAESTRO_D_BIN=... TS_MAESTRO_D_CLIENT=... \
 *   TS_SCORING_TEST_URL=http://127.0.0.1:8080 \
 *   TS_API_TEST_URL=http://127.0.0.1:9100/api/v1 \
 *   PLAYER_NAMES_ARTIFACTS=<artifacts dir> PLAYER_NAMES_FIXTURE=<fixture.json> \
 *   PLAYER_NAMES_API_LOG=<the API's log> TS_DATABASE=<database url> \
 *   node -r sucrase/register src/app/scoring/playerNames.e2e.ts
 *
 * Sign-in is by the e-mail code the API logs when it sends no mail; the code
 * and the session are never written anywhere. The tab is closed and the
 * daemon shut down however the run ends.
 */

const LOG = 'e8-browser.log'
/** What the scorer corrects the game-only player's name to. */
const CORRECTED = { firstName: 'Willie', lastName: 'Mays' }

function env(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`Set ${key}`)
  return value
}

/** A session for `email`, from the sign-in code the API wrote to its log. */
async function signIn(email: string): Promise<string> {
  const ask = await fetch(`${API}/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email })
  })
  expect(ask.ok, 'asked for a sign-in code').equals(true)
  const pattern = new RegExp(`sign-in code for ${email}: (\\d{6})`, 'g')
  let code: string | undefined
  for (let tries = 0; tries < 40 && code == null; tries++) {
    await pause(250)
    code = [
      ...readFileSync(env('PLAYER_NAMES_API_LOG'), 'utf8').matchAll(pattern)
    ]
      .at(-1)
      ?.at(1)
  }
  if (code == null) throw new Error(`No sign-in code logged for ${email}`)
  const verified = await fetch(`${API}/auth/email-code/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code })
  })
  const body = (await verified.json()) as { token?: string }
  if (body.token == null) throw new Error('The sign-in code was refused')
  return body.token
}

async function sql<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const client = new pg.Client({ connectionString: env('TS_DATABASE') })
  await client.connect()
  try {
    return (await client.query(text, values)).rows as T[]
  } finally {
    await client.end()
  }
}

/** A database read for the log: the query on its `$` line, then its rows. */
async function logged(
  text: string,
  values: unknown[] = []
): Promise<Array<Record<string, unknown>>> {
  const rows = await sql(text, values)
  await note(
    LOG,
    `$ psql "$TS_DATABASE" -c "${text.replace(/\s+/g, ' ')}"${values.length > 0 ? `  -- ${JSON.stringify(values)}` : ''}\n${JSON.stringify(rows, null, 2)}\n`
  )
  return rows
}

async function main(): Promise<void> {
  const artifacts = env('PLAYER_NAMES_ARTIFACTS')
  await mkdir(artifacts, { recursive: true })
  writeArtifactsTo(artifacts)
  const fixture = JSON.parse(
    readFileSync(env('PLAYER_NAMES_FIXTURE'), 'utf8')
  ) as NamesFixture
  // Either of the visitors' administrators, who score their games.
  const scorer =
    process.env.PLAYER_NAMES_PERSON === 'secondAdmin'
      ? fixture.people.secondAdmin
      : fixture.people.admin
  await note(
    LOG,
    `# E8 (M4): scoring in the browser stores no names; a game-only player's correction renames his account\n` +
      `# One maestro-d Chromium tab (daemon ${env('MAESTRO_D')}), web ${APP}, API ${API}\n` +
      `# Signed in as the visitors' administrator (${scorer.name}) by an e-mail code read from the API log`
  )

  // A game nobody has scored, between the fixture's teams.
  const gameId = makeId('game')
  await sql(
    `insert into games (id, home_team_id, away_team_id, season_id, start_at, venue, status)
     values ($1, $2, $3, $4, now(), 'Names Field', 'scheduled')`,
    [gameId, fixture.teams.home, fixture.teams.away, fixture.seasonId]
  )
  await note(
    LOG,
    `$ # a new game ${gameId}: visitors at hosts, in the fixture's season`
  )
  // A session already made for the scorer, kept in the environment only, or
  // a new one: sign-in codes are rate limited.
  const token = process.env.PLAYER_NAMES_TOKEN ?? (await signIn(scorer.email))

  const daemon = await maestro(env('MAESTRO_D'))
  let session: BrowserSession | undefined
  try {
    session = await browserSession(
      daemon,
      `${env('MAESTRO_D')}-web`,
      1280,
      900,
      artifacts
    )
    const { m, page } = session
    const browser = new Browser(session, page)
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await page.browserContext().setCookie({
      name: 'ts_session',
      value: encodeURIComponent(token),
      domain: new URL(APP).hostname,
      path: '/'
    })

    // The scoring screen, on the teams' default lineups.
    await browser.scoreGame(gameId)
    await note(LOG, `$ open ${APP}/games/${gameId}/score`)
    // Every save is out and answered: the screen's save status is gone.
    const saved = async (): Promise<void> => {
      await pause(1500)
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Save status"]') == null,
        { timeout: 30000 }
      )
    }
    const rosters = async (side: 'Away' | 'Home'): Promise<void> => {
      await browser.tap('Open scoring menu')
      await browser.tap('Set Team Rosters')
      await browser.waitText('Save Rosters')
      // The team slider's segments are no buttons: tapped by their label.
      await m.tapOn({ css: `[aria-label="${side} Team"]`, timeout: 15000 })
      await pause(500)
      await m.tapOn({ css: '[aria-label="Roster"]', timeout: 15000 })
      await pause(500)
    }

    // A game-only player on the hosts' side, whose roster the visitors'
    // administrator does not keep.
    await rosters('Home')
    await browser.tap('Create Player')
    await browser.waitText('Select number of players to create')
    await browser.tap('Create')
    await browser.waitText('game-only player')
    const guests = await sql<{ user_id: string; display_name: string }>(
      `select g.user_id, u.display_name from game_guest_details g
       join users u on u.id = g.user_id where g.game_id = $1`,
      [gameId]
    )
    expect(guests).length(1)
    const guest = guests[0]
    await note(
      LOG,
      `$ # Create Game Guests on the hosts' side: one game-only player, "${guest.display_name}" (${guest.user_id})`
    )
    await browser.tap('Save Rosters')
    await browser.waitText('Open scoring menu')

    // A single, then a strikeout.
    const ready = async (): Promise<void> => {
      await page.waitForFunction(
        () => {
          const ball = document.querySelector('[aria-label="Ball"]')
          return ball != null && ball.getAttribute('aria-disabled') !== 'true'
        },
        { timeout: 30000 }
      )
    }
    await ready()
    await browser.tap('Swing in Play')
    await browser.tap('Single')
    await page.waitForSelector('canvas[data-field-ready="true"]')
    await page.waitForSelector(
      '[aria-label^="Tap or drag a player to where the ball was fielded"]'
    )
    await page.focus('[role="application"]')
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await page.waitForSelector(
      '[aria-label^="Drag up and down for ball trajectory."]'
    )
    await page.keyboard.press('Enter')
    await pause(500)
    if (await browser.has('Finish at-bat')) await browser.tap('Finish at-bat')
    // Three strikeouts end the half inning.
    for (let pitch = 0; pitch < 9; pitch++) {
      await ready()
      await browser.tap('Called Strike')
    }
    await ready()
    await saved()
    await note(
      LOG,
      '$ # scored the top of the 1st: a single, then three strikeouts on called strikes'
    )
    await browser.capture('browser-scoring.png')
    const shown = await browser.text()
    const batters = fixture.players.away.slice(0, 4).map(player => player.name)
    for (const name of batters)
      expect(shown, `the scoring screen names ${name}`).include(name)
    await note(
      LOG,
      `$ # the scoring screen names the batters: ${batters.join(', ')} (browser-scoring.png)`
    )

    // The game-only player's name, corrected in the roster editor.
    await rosters('Home')
    await browser.tap(guest.display_name)
    await browser.waitText('Edit Player')
    // The field holds the placeholder's name: selected whole and typed over.
    const retype = async (label: string, value: string): Promise<void> => {
      const selector = `[aria-label="${label}"]:is(input, textarea)`
      await m.tapOn({ css: selector, timeout: 10000 })
      await m.eraseText({ characters: 40 })
      await m.inputText({ text: value, css: selector })
      await page
        .waitForFunction(
          (selector, value) => {
            // No ?. here: sucrase turns it into a helper the page lacks.
            const input = document.querySelector<HTMLInputElement>(selector)
            return input !== null && input.value === value
          },
          { timeout: 10000 },
          selector,
          value
        )
        .catch(async (error: unknown) => {
          console.error(
            label,
            'reads',
            JSON.stringify(
              await page.$$eval(selector, nodes =>
                nodes.map(node => (node as HTMLInputElement).value)
              )
            )
          )
          throw error
        })
    }
    await retype('First Name', CORRECTED.firstName)
    await retype('Last Name', CORRECTED.lastName)
    await browser.tap('Save Player')
    await browser.waitText(`${CORRECTED.firstName} ${CORRECTED.lastName}`)
    const renamed = page.waitForResponse(
      response =>
        response.request().method() === 'PUT' &&
        response.url().includes(`/games/${gameId}/guest-players/`),
      { timeout: 30000 }
    )
    await browser.tap('Save Rosters')
    const answer = await renamed
    expect(answer.status()).equals(200)
    await note(
      LOG,
      `$ # Save Rosters: PUT /api/v1/games/${gameId}/guest-players/${guest.user_id} -> ${answer.status()}`
    )
    await browser.waitText('Open scoring menu')
    await saved()
    await browser.tap('Open scoring menu')
    await browser.tap('Exit Current Game')
    await pause(1500)
    await note(LOG, '$ # Exit Current Game')

    // Nothing stored names a player of the game.
    const people = await sql<{
      display_name: string
      first_name: string | null
      last_name: string | null
    }>(
      `select u.display_name, u.first_name, u.last_name from users u
       join gumbo_ids g on g.user_id = u.id
       where g.gumbo_id in (
         select ep.gumbo_id from event_players ep join events e on e.id = ep.event_id where e."gameId" = $1
         union select (jsonb_array_elements_text(coalesce(games.guests -> $2, '[]')))::bigint from games where id = $1
         union select (jsonb_array_elements_text(coalesce(games.guests -> $3, '[]')))::bigint from games where id = $1
       ) or u.id in (select user_id from memberships where team_id in ($2, $3) and is_player)`,
      [gameId, fixture.teams.home, fixture.teams.away]
    )
    const names = [
      ...new Set(
        people
          .flatMap(person => [
            person.display_name,
            person.first_name,
            person.last_name
          ])
          .filter((name): name is string => name != null && name.length > 1)
      )
    ]
    const stored = await sql<{ text: string }>(
      `select coalesce(string_agg(gumbo::text, ' '), '') || ' ' ||
              coalesce((select "currentPlay"::text from games where id = $1), '') || ' ' ||
              coalesce((select pregame::text from games where id = $1), '') as text
       from events where "gameId" = $1`,
      [gameId]
    )
    const found = names.filter(
      name =>
        stored[0].text.includes(`"${name}"`) || stored[0].text.includes(name)
    )
    await logged(
      `select count(*) as plays, count(*) filter (where gumbo::text like '%fullName%') as "playsWithFullName" from events where "gameId" = $1`,
      [gameId]
    )
    await note(
      LOG,
      `$ # the game's players' display, first and last names (${names.length} distinct) found in its stored plays, at-bat and pregame: ${found.length}`
    )
    expect(found, 'names stored').deep.equals([])
    const account = await logged(
      'select first_name, last_name, display_name, login_enabled from users where id = $1',
      [guest.user_id]
    )
    expect(account[0]).deep.include({
      first_name: CORRECTED.firstName,
      last_name: CORRECTED.lastName,
      display_name: `${CORRECTED.firstName} ${CORRECTED.lastName}`
    })

    // Reloaded and reopened, the game shows the corrected name, and the
    // roster editor offers his corrected halves.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await browser.scoreGame(gameId)
    await rosters('Home')
    const row = `${CORRECTED.firstName} M`
    await browser.waitText(row)
    expect(await browser.text()).include(row)
    await browser.tap(row)
    await browser.waitText('Edit Player')
    await pause(500)
    const halves = await page.evaluate(() => {
      // No ?. here: sucrase turns it into a helper the page lacks.
      const value = (label: string): string | null => {
        const input = document.querySelector<HTMLInputElement>(
          `[aria-label="${label}"]:is(input, textarea)`
        )
        return input === null ? null : input.value
      }
      return { firstName: value('First Name'), lastName: value('Last Name') }
    })
    expect(halves).deep.equals(CORRECTED)
    await browser.capture('browser-after-correction.png')
    await note(
      LOG,
      `$ # reloaded and reopened: the roster row reads "${row}", and Edit Player on it shows First Name "${halves.firstName}", Last Name "${halves.lastName}" (browser-after-correction.png)`
    )
    const events = (await (
      await fetch(`${API}/games/${gameId}/events`, {
        headers: { authorization: `Bearer ${token}` }
      })
    ).json()) as unknown
    const read = JSON.stringify(events)
    const named = batters.filter(name => read.includes(name))
    await note(
      LOG,
      `$ curl -H "authorization: Bearer $TOKEN" ${API}/games/${gameId}/events\n# the answer names ${named.length} of ${batters.length} batters (${named.join(', ')}) and the guest as "${CORRECTED.firstName} M": ${read.includes(`${CORRECTED.firstName} M`)}`
    )
    expect(named).deep.equals(batters)
    expect(browser.errors, 'page errors').deep.equals([])
    await note(LOG, 'PASS E8')
  } catch (error) {
    // What the page offered when a step failed, on the console only.
    if (session != null)
      console.error(
        await session.page
          .evaluate(() =>
            Array.from(document.querySelectorAll('[aria-label]'))
              .map(node => node.getAttribute('aria-label'))
              .join(' | ')
          )
          .catch(() => '')
      )
    throw error
  } finally {
    if (session != null) {
      await session.page.close().catch(() => undefined)
      await session.browser.disconnect().catch(() => undefined)
      await session.m.detach().catch(() => undefined)
    }
    await daemon.shutdown()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
