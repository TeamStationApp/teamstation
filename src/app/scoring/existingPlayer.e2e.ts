import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { signInTestAccount } from '../../test/passwordFixtures'

/**
 * Adding a player who already exists, from Set Team Rosters, in Chrome
 * through maestro-d against this machine's server and the fixture of
 * `scripts/e2e/existingPlayer/fixture.ts`.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> \
 *     TS_SCORING_TEST_URL=http://127.0.0.1:8171 \
 *     TS_API_TEST_URL=http://127.0.0.1:9171/api/v1 \
 *     npx mocha -r sucrase/register --extension ts --timeout 900000 \
 *     src/app/scoring/existingPlayer.e2e.ts
 *
 * Needs the API (`npm start`) and the web app served against it
 * (`TS_API_BASE_URL=… node src/build.mjs --serve`), both on this machine,
 * and the fixture written into its fresh database. `TS_E2E_FIXTURE` names
 * the fixture file; `TS_E2E_ARTIFACT_DIR`, when set, receives screenshots.
 */
const APP = process.env.TS_SCORING_TEST_URL ?? 'http://127.0.0.1:8171'
const API = process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9171/api/v1'
for (const url of [APP, API])
  if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
    throw new Error(`${url} is not on this machine`)
const FIXTURE_FILE =
  process.env.TS_E2E_FIXTURE ??
  '/private/tmp/teamstation-existingPlayer/fixture.json'
const artifacts = process.env.TS_E2E_ARTIFACT_DIR
const stamp = Date.now().toString(36)

interface Fixture {
  gameId: string
  password: string
  emails: { coach: string; guardian: string; scorer: string; heron: string }
  teams: Record<string, { id: string; name: string }>
  players: Record<string, string>
}

const requireClient =
  process.env.MAESTRO_D_CLIENT_ROOT == null
    ? createRequire(__filename)
    : createRequire(join(process.env.MAESTRO_D_CLIENT_ROOT, 'package.json'))
const { MaestroD } = requireClient('maestro-d')
let daemon: Awaited<ReturnType<typeof MaestroD.connect>>
type Browser = Awaited<ReturnType<typeof daemon.attach>>

describe('adding an existing player from Set Team Rosters', function () {
  this.timeout(900000)
  const fixture = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as Fixture
  let browser: Browser

  /** Reads a value out of the page. */
  const probe = async <T>(script: string): Promise<T> => {
    await browser.evalBrowserScript({
      script: `return JSON.stringify(${script})`,
      output: 'probe'
    })
    return JSON.parse((await browser.vars()).probe) as T
  }
  const label = (name: string): string => `[aria-label="${name}"]`
  const tap = async (name: string): Promise<void> => {
    await browser.tapOn({ css: label(name), timeout: 15000 })
  }
  const shot = async (name: string): Promise<void> => {
    if (artifacts == null) return
    // A sheet slides up: let it land.
    await new Promise(resolve => setTimeout(resolve, 800))
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(artifacts, `${name}.png`), await browser.screenshot())
  }
  /** Signs `email` in and opens `path` in the app as them. */
  const tokens = new Map<string, string>()
  /** One sign-in per account per run: the server limits attempts. */
  const tokenOf = async (email: string): Promise<string> => {
    const held = tokens.get(email)
    if (held != null) return held
    const token = await signInTestAccount(API, {
      email,
      password: fixture.password
    })
    tokens.set(email, token)
    return token
  }
  const openAs = async (email: string, path: string): Promise<string> => {
    const token = await tokenOf(email)
    await browser.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: encodeURIComponent(token),
          domain: new URL(API).hostname,
          path: '/'
        }
      ]
    })
    await browser.openBrowser({ url: `${APP}${path}` })
    return token
  }
  /** A GET against the API as the holder of `token`. */
  const apiGet = async (
    token: string,
    path: string
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}` }
    })
    return { status: response.status, body: await response.json() }
  }
  /** The candidate cards drawn, top to bottom, as their short names. */
  const candidates = async (): Promise<string[]> =>
    await probe<string[]>(
      `[...document.querySelectorAll('[aria-label^="Choose "]')].map(n => [n.getBoundingClientRect().top, n.getAttribute('aria-label').slice(7)]).sort((a, b) => a[0] - b[0]).map(p => p[1])`
    )
  /** Every candidate the list shows, scrolling it to its end page by page. */
  const allCandidates = async (): Promise<string[]> => {
    const seen: string[] = []
    for (let page = 0; page < 6; page++) {
      for (const name of await candidates())
        if (!seen.includes(name)) seen.push(name)
      await browser.evalBrowserScript({
        script: `const box = document.querySelector('[data-testid="Candidate list"] > div'); box.scrollTop += box.clientHeight; return ''`,
        output: 'scrolled'
      })
      await new Promise(resolve => setTimeout(resolve, 1200))
    }
    return seen
  }
  const openRosters = async (): Promise<void> => {
    await browser.assertVisible({
      css: label('Open scoring menu'),
      timeout: 60000
    })
    await tap('Open scoring menu')
    await browser.tapOn({ text: 'Set Team Rosters', timeout: 15000 })
    await browser.assertVisible({ css: label('Roster'), timeout: 15000 })
  }
  const pageText = async (): Promise<string> =>
    await probe<string>('document.body.innerText')
  /** The accessible names of the Roster tab's cards, in order. */
  const rosterCards = async (): Promise<string[]> =>
    await probe<string[]>(
      `[...document.querySelectorAll('[data-testid="Edit roster players"] [role="button"]')].map(n => n.getAttribute('aria-label'))`
    )

  let coachToken = ''
  before(async function () {
    const token = await tokenOf(fixture.emails.coach)
    coachToken = token
    daemon = await MaestroD.connect({
      name: process.env.MAESTRO_D ?? `existingPlayer-${stamp}`
    })
    const url = `${APP}/games/${fixture.gameId}/score`
    browser = await daemon.attach({
      device: `existing-player-${stamp}`,
      platform: 'web',
      appId: url,
      stepDelay: 200,
      artifacts: 'on-failure',
      extra: { browser: 'chrome', windowSize: '1280x900' }
    })
    await browser.blockNetwork({
      patterns: ['*fonts.googleapis.com*', '*fonts.gstatic.com*']
    })
    await browser.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: encodeURIComponent(token),
          domain: new URL(API).hostname,
          path: '/'
        }
      ]
    })
    await browser.openBrowser({ url })
    await browser.assertVisible({
      css: label('Open scoring menu'),
      timeout: 60000
    })
  })

  after(async function () {
    try {
      await browser?.detach()
    } finally {
      await daemon?.shutdown()
    }
  })

  it('W1 opens Set Team Rosters on the roster, which ends in the two add rows', async function () {
    await tap('Open scoring menu')
    await browser.tapOn({ text: 'Set Team Rosters', timeout: 15000 })
    await browser.assertVisible({ css: label('Roster'), timeout: 15000 })
    expect(
      await probe<string | null>(
        `document.querySelector('[aria-label="Roster"]').getAttribute('aria-selected')`
      )
    ).equals('true')
    const cards = await rosterCards()
    expect(cards.slice(-2)).deep.equals([
      'Create Player',
      'Add Existing Player'
    ])
    expect(
      await probe<string>(
        `document.querySelector('[data-testid="Roster footer bar"]').textContent`
      )
    ).equals('Save Rosters')
    await shot('web-roster-rows')
  })

  it('W2 offers placeholders only, from Create Player, for the opposing team', async function () {
    await tap('Away Team')
    await tap('Create Player')
    await browser.assertVisible({
      css: label('Number of placeholder players'),
      timeout: 15000
    })
    expect(
      await probe<boolean>(
        `document.querySelector('[aria-label="First Name"]') == null`
      )
    ).equals(true)
    await shot('web-opposing-create-player')
    const cancels = await probe<number>(
      `document.querySelectorAll('[aria-label="Cancel"]').length`
    )
    expect(cancels).greaterThan(0)
    await browser.evalBrowserScript({
      script: `const all = document.querySelectorAll('[aria-label="Cancel"]'); all[all.length - 1].click(); return ''`,
      output: 'cancelled'
    })
  })

  it('W3 lists the Owls first, then the season and league, never a stranger or a Falcon', async function () {
    await tap('Home Team')
    await tap('Add Existing Player')
    await browser.assertVisible({
      css: label('Choose Aaron J'),
      timeout: 30000
    })
    // The coach's own team, by name: every card on the first screen is an Owl.
    const first = await candidates()
    expect(first[0]).equals('Aaron J')
    expect(
      await probe<number>(
        `document.querySelector('[data-testid="Candidate list"]').innerText.split('Ridgeview Owls').length - 1`
      )
    ).greaterThanOrEqual(first.length - 1)
    await shot('web-search-first-page')
    const all = await allCandidates()
    const burnes = all.indexOf('Corbin B')
    expect(burnes, 'Burnes listed').greaterThan(-1)
    expect(all.indexOf('Max F'), 'Fried after Burnes').greaterThan(burnes)
    // Every Owl comes before anybody else.
    expect(
      all
        .slice(0, 42)
        .every(
          name => !['Corbin B', 'Max F', 'Ryan H', 'Jordan W'].includes(name)
        )
    ).equals(true)
    expect(all).not.includes('Jose R')
    expect(all).not.includes('Clayton K')
  })

  it('W4 asks once for a quickly typed search, and finds a stranger by three letters', async function () {
    // The browser's own record of what it fetched, from here on.
    await browser.evalBrowserScript({
      script: `performance.clearResourceTimings(); performance.setResourceTimingBufferSize(1000); return ''`,
      output: 'counting'
    })
    await tap('Search players')
    await browser.inputText({ text: 'ram' })
    await browser.assertVisible({ css: label('Choose Jose R'), timeout: 15000 })
    const asks = await probe<string[]>(
      `performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('forTeam'))`
    )
    expect(asks.filter(url => /[?&]q=/.test(url))).deep.equals(
      asks.filter(url => url.includes('q=ram'))
    )
    console.log(
      `      search requests while "ram" was typed: ${JSON.stringify(asks.map(url => new URL(url).search))}`
    )
    expect(asks.filter(url => url.includes('q=ram'))).has.length(1)
    expect(await pageText()).includes('Coastal Gulls')
    await shot('web-search-ram')
    await tap('Clear search')
    await browser.assertVisible({
      css: label('Choose Aaron J'),
      timeout: 15000
    })
    // "Be", "Bet", "Betts" typed at once: one search, for "Betts".
    await browser.evalBrowserScript({
      script: `performance.clearResourceTimings(); return ''`,
      output: 'counting'
    })
    await tap('Search players')
    await browser.inputText({ text: 'Betts' })
    await browser.assertVisible({
      css: label('Choose Mookie B'),
      timeout: 15000
    })
    const typed = (
      await probe<string[]>(
        `performance.getEntriesByType('resource').map(entry => entry.name).filter(name => name.includes('forTeam'))`
      )
    ).filter(url => /[?&]q=/.test(url))
    console.log(
      `      search requests while "Betts" was typed: ${JSON.stringify(typed.map(url => new URL(url).search))}`
    )
    expect(typed).has.length(1)
    expect(typed[0]).includes('q=Betts')
    await tap('Clear search')
    await browser.assertVisible({
      css: label('Choose Aaron J'),
      timeout: 15000
    })
  })

  it('W5 adds Betts to the Falcons with #50, and tells his guardian, who may reject', async function () {
    await tap('Search players')
    await browser.inputText({ text: 'Betts' })
    await tap('Choose Mookie B')
    await browser.assertVisible({ css: label('Add to Roster'), timeout: 15000 })
    expect(
      await probe<boolean[]>(
        `['First Name', 'Last Name'].map(name => document.querySelector('[aria-label="' + name + '"]').readOnly)`
      )
    ).deep.equals([true, true])
    await shot('web-add-to-roster')
    await tap('Jersey Number')
    await browser.inputText({ text: '50' })
    await tap('Add to Roster')
    await browser.assertVisible({
      text: '.*Their guardians were notified.*',
      timeout: 15000
    })
    expect(
      (await rosterCards()).some(name => name.startsWith('Mookie B, jersey 50'))
    ).equals(true)
    await shot('web-added-to-roster')
    await tap('Save Rosters')
    const roster = await apiGet(
      coachToken,
      `/teams/${fixture.teams.falcons.id}/roster`
    )
    const betts = (roster.body as any[]).find(
      entry => entry.userId === fixture.players['Mookie Betts']
    )
    expect(betts).to.include({ shortName: 'Mookie B', jersey: '50' })

    await openAs(fixture.emails.guardian, '/notifications')
    await browser.assertVisible({
      css: '[data-testid="notification-reject"]',
      timeout: 30000
    })
    expect(await pageText()).includes('Mookie B')
    await shot('web-guardian-notice')
  })

  it('W6 takes Betts off when his guardian rejects, and the next add needs approval', async function () {
    await browser.tapOn({
      css: '[data-testid="notification-reject"]',
      timeout: 15000
    })
    await browser.assertNotVisible({
      css: '[data-testid="notification-reject"]',
      timeout: 15000
    })
    const roster = await apiGet(
      coachToken,
      `/teams/${fixture.teams.falcons.id}/roster`
    )
    expect(
      (roster.body as any[]).some(
        entry =>
          entry.userId === fixture.players['Mookie Betts'] &&
          entry.isPlayer === true
      )
    ).equals(false)

    coachToken = await openAs(
      fixture.emails.coach,
      `/games/${fixture.gameId}/score`
    )
    await openRosters()
    await tap('Home Team')
    await tap('Add Existing Player')
    await tap('Search players')
    await browser.inputText({ text: 'Betts' })
    await tap('Choose Mookie B')
    await tap('Add to Roster')
    await browser.assertVisible({
      text: '.*needs approval first.*',
      timeout: 15000
    })
    await shot('web-approval-needed')
    // Back out of Add to Roster and the search.
    for (let sheet = 0; sheet < 2; sheet++)
      await browser.evalBrowserScript({
        script: `const all = document.querySelectorAll('[aria-label="Cancel"]'); all[all.length - 1].click(); return ''`,
        output: 'cancelled'
      })
  })

  it('W7 adds Freeman to the Herons for this game only, and opens his page to no Heron', async function () {
    await tap('Away Team')
    await tap('Add Existing Player')
    await tap('Search players')
    await browser.inputText({ text: 'Freeman' })
    await tap('Choose Freddie F')
    // The Herons are not the coach's to manage: the pool is all there is.
    expect(
      await probe<boolean>(
        `document.querySelector('[aria-label="Add to Roster"]') == null`
      )
    ).equals(true)
    await tap('Add as Pool Player')
    await browser.assertVisible({
      text: '.*Freddie F was added.*',
      timeout: 15000
    })
    expect(await pageText()).includes('Game-only player')
    await shot('web-pool-player')
    await tap('Save Rosters')
    const heron = await tokenOf(fixture.emails.heron)
    expect(
      (await apiGet(heron, `/players/${fixture.players['Freddie Freeman']}`))
        .status
    ).equals(404)
  })
})
