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
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(artifacts, `${name}.png`), await browser.screenshot())
  }
  /** The accessible names of the Roster tab's cards, in order. */
  const rosterCards = async (): Promise<string[]> =>
    await probe<string[]>(
      `[...document.querySelectorAll('[data-testid="Edit roster players"] [role="button"]')].map(n => n.getAttribute('aria-label'))`
    )

  before(async function () {
    const token = await signInTestAccount(API, {
      email: fixture.emails.coach,
      password: fixture.password
    })
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
})
