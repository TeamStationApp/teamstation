import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import type { HTTPResponse } from '../../../core/web'
import { clearSignInLimits, stackSql } from '../../../rigs/coach/coachApp'
import {
  installSceneProbe,
  maestroDriver,
  placeFielder,
  setTrajectory
} from '../../../rigs/fieldPointer'
import {
  Browser,
  HEIGHT,
  pause,
  scoringStack,
  WIDTH
} from '../../../rigs/scoringBrowser'

/**
 * Scoring in the browser stores no names, and a game-only player's
 * corrected name lives on his account.
 *
 * In one window of this machine's browser, signed in as the `player-names`
 * world's team administrator (who scores his team's games): a new game
 * between the world's teams is opened in the scoring screen, a game-only
 * player is added to the other side, the top of the first is scored (a
 * single and three strikeouts), the game-only player's name is corrected
 * in the roster editor and Save Rosters sends it, and scoring is left. The
 * stored plays, at-bat and pregame then hold no name of the game's
 * players, the guest's account carries the correction, and the game
 * reopened after a reload shows it: the guest's roster row reads his
 * corrected short name, and Edit Player on it shows his corrected first
 * and last names.
 */

const LOG = 'e8-browser.log'
/** What the scorer corrects the game-only player's name to. */
const CORRECTED = { firstName: 'Willie', lastName: 'Mays' }

export default defineHarness({
  id: 'scoring/player-names/no-names-stored',
  title: "Scoring stores no names, and a guest's correction renames him",
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/scoring/RosterEditor.tsx',
    'src/common/scoring/storedNames.ts',
    'src/server/games/guestPlayers.ts',
    'src/server/routes/events.ts'
  ],
  stack: 'isolated',
  fixtures: ['player-names'],
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
  minutes: 10,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'browser-scoring': async ctx => {
      await clearSignInLimits(ctx)
      const manifest = await ctx.fixture('player-names')
      const stack = await scoringStack(ctx)
      const scorer = manifest.accounts.admin
      const awayPlayers = JSON.parse(manifest.ids.awayPlayers) as Array<{
        name: string
      }>
      const sql = async <T = Record<string, unknown>>(
        text: string,
        values: unknown[] = []
      ): Promise<T[]> => (await stackSql(ctx, text, values)).rows as T[]
      stack.note(
        LOG,
        `# E8 (M4): scoring in the browser stores no names; a game-only player's correction renames his account\n` +
          `# One window of this machine's browser, web ${ctx.stack.origin}, API ${stack.api}\n` +
          `# Signed in as the visitors' administrator (${scorer.displayName}) by the password route`
      )

      // A game nobody has scored, between the world's teams.
      const { makeId } = await import('../../../../src/common/ids')
      const gameId = makeId('game')
      await sql(
        `insert into games (id, home_team_id, away_team_id, season_id, start_at, venue, status)
         values ($1, $2, $3, $4, now(), 'Names Field', 'scheduled')`,
        [
          gameId,
          manifest.ids.homeTeam,
          manifest.ids.awayTeam,
          manifest.ids.season
        ]
      )
      stack.note(
        LOG,
        `$ # a new game ${gameId}: visitors at hosts, in the world's season`
      )
      const token = await stack.signInAs(scorer)

      const browser = await Browser.open(ctx, { width: WIDTH, height: HEIGHT })
      const { m, page } = browser
      try {
        await installSceneProbe(page)
        await browser.go('/')
        await browser.as(token)

        // The scoring screen, on the teams' default lineups.
        await browser.scoreGame(gameId)
        stack.note(LOG, `$ open ${ctx.stack.origin}/games/${gameId}/score`)
        // Every save is out and answered: the screen's save status is gone.
        const saved = async (): Promise<void> => {
          await pause(1500)
          await page.waitForFunction(
            `document.querySelector('[aria-label="Save status"]') == null`,
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
        stack.note(
          LOG,
          `$ # Create Game Guests on the hosts' side: one game-only player, "${guest.display_name}" (${guest.user_id})`
        )
        await browser.tap('Save Rosters')
        await browser.waitText('Open scoring menu')

        // A single, then a strikeout.
        const ready = async (): Promise<void> => {
          await page.waitForFunction(
            `(() => { const ball = document.querySelector('[aria-label="Ball"]'); return ball != null && ball.getAttribute('aria-disabled') !== 'true' })()`,
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
        // The pitcher fields it, at the angle the screen offers.
        const field = maestroDriver(m)
        await placeFielder(field, 'P')
        await setTrajectory(field)
        await pause(500)
        if (await browser.has('Finish at-bat'))
          await browser.tap('Finish at-bat')
        // Three strikeouts end the half inning.
        for (let pitch = 0; pitch < 9; pitch++) {
          await ready()
          await browser.tap('Called Strike')
        }
        await ready()
        await saved()
        stack.note(
          LOG,
          '$ # scored the top of the 1st: a single, then three strikeouts on called strikes'
        )
        await browser.capture('browser-scoring.png')
        const shown = await browser.text()
        const batters = awayPlayers.slice(0, 4).map(player => player.name)
        for (const name of batters)
          expect(shown, `the scoring screen names ${name}`).include(name)
        stack.note(
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
          const check = `(() => { const input = document.querySelector(${JSON.stringify(selector)}); return input !== null && input.value === ${JSON.stringify(value)} })()`
          await page
            .waitForFunction(check, { timeout: 10000 })
            .catch(async (error: unknown) => {
              const values = await page.evaluate(
                `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(node => node.value))`
              )
              throw new Error(
                `${label} reads ${String(values)}: ${String(error)}`
              )
            })
        }
        await retype('First Name', CORRECTED.firstName)
        await retype('Last Name', CORRECTED.lastName)
        await browser.tap('Save Player')
        await browser.waitText(`${CORRECTED.firstName} ${CORRECTED.lastName}`)
        const renamed = page.waitForResponse(
          (response: HTTPResponse) =>
            response.request().method() === 'PUT' &&
            response.url().includes(`/games/${gameId}/guest-players/`),
          { timeout: 30000 }
        )
        await browser.tap('Save Rosters')
        const answer = await renamed
        expect(answer.status()).equals(200)
        stack.note(
          LOG,
          `$ # Save Rosters: PUT /api/v1/games/${gameId}/guest-players/${guest.user_id} -> ${answer.status()}`
        )
        await browser.waitText('Open scoring menu')
        await saved()
        await browser.tap('Open scoring menu')
        await browser.tap('Exit Current Game')
        await pause(1500)
        stack.note(LOG, '$ # Exit Current Game')

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
          [gameId, manifest.ids.homeTeam, manifest.ids.awayTeam]
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
            stored[0].text.includes(`"${name}"`) ||
            stored[0].text.includes(name)
        )
        await stack.query(
          LOG,
          `select count(*) as plays, count(*) filter (where gumbo::text like '%fullName%') as "playsWithFullName" from events where "gameId" = $1`,
          [gameId]
        )
        stack.note(
          LOG,
          `$ # the game's players' display, first and last names (${names.length} distinct) found in its stored plays, at-bat and pregame: ${found.length}`
        )
        expect(found, 'names stored').deep.equals([])
        const account = await stack.query(
          LOG,
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
        await browser.scoreGame(gameId)
        await rosters('Home')
        const row = `${CORRECTED.firstName} M`
        await browser.waitText(row)
        expect(await browser.text()).include(row)
        await browser.tap(row)
        await browser.waitText('Edit Player')
        await pause(500)
        const halves = (await page.evaluate(`(() => {
          const value = label => {
            const input = document.querySelector('[aria-label="' + label + '"]:is(input, textarea)')
            return input === null ? null : input.value
          }
          return { firstName: value('First Name'), lastName: value('Last Name') }
        })()`)) as { firstName: string | null; lastName: string | null }
        expect(halves).deep.equals(CORRECTED)
        await browser.capture('browser-after-correction.png')
        stack.note(
          LOG,
          `$ # reloaded and reopened: the roster row reads "${row}", and Edit Player on it shows First Name "${halves.firstName}", Last Name "${halves.lastName}" (browser-after-correction.png)`
        )
        const events = (await (
          await fetch(`${stack.api}/games/${gameId}/events`, {
            headers: { authorization: `Bearer ${token}` }
          })
        ).json()) as unknown
        const read = JSON.stringify(events)
        const named = batters.filter(name => read.includes(name))
        stack.note(
          LOG,
          `$ curl -H "authorization: Bearer $TOKEN" ${stack.api}/games/${gameId}/events\n# the answer names ${named.length} of ${batters.length} batters (${named.join(', ')}) and the guest as "${CORRECTED.firstName} M": ${read.includes(`${CORRECTED.firstName} M`)}`
        )
        expect(named).deep.equals(batters)
        expect(browser.errors, 'page errors').deep.equals([])
        stack.note(LOG, 'PASS E8')
      } catch (error) {
        // What the page offered when a step failed, in the run's log.
        const labels = await page
          .evaluate(
            `Array.from(document.querySelectorAll('[aria-label]')).map(node => node.getAttribute('aria-label')).join(' | ')`
          )
          .catch(() => '')
        stack.note('e8-failure-labels.log', String(labels))
        throw error
      } finally {
        await browser.close()
      }
    }
  }
})
