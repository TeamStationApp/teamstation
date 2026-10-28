import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { signInTestAccount } from '../../test/passwordFixtures'

/**
 * A team's players in the app theme — Player Settings on the shared player
 * form, and team settings' Create Player and Add Player — in Chrome through
 * maestro-d against this machine's server and the fixture of
 * `scripts/e2e/existingPlayer/fixture.ts`.
 *
 *   MAESTRO_D=<daemon> MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> \
 *     TS_SCORING_TEST_URL=http://127.0.0.1:8171 \
 *     TS_API_TEST_URL=http://127.0.0.1:9171/api/v1 \
 *     npx mocha -r sucrase/register --extension ts --timeout 900000 \
 *     src/app/screens/teamPlayers.e2e.ts
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

describe("a team's players in the app theme", function () {
  this.timeout(900000)
  const fixture = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as Fixture
  let browser: Browser
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
    await new Promise(resolve => setTimeout(resolve, 800))
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(artifacts, `${name}.png`), await browser.screenshot())
  }
  /** Signs `email` in and opens `path` in the app as them. */
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
  /** The team's roster as the holder of `token` reads it. */
  const roster = async (token: string, teamId: string): Promise<any[]> => {
    const response = await fetch(`${API}/teams/${teamId}/roster`, {
      headers: { authorization: `Bearer ${token}` }
    })
    return (await response.json()) as any[]
  }

  before(async function () {
    daemon = await MaestroD.connect({
      name: process.env.MAESTRO_D ?? `teamPlayers-${stamp}`
    })
    browser = await daemon.attach({
      device: `team-players-${stamp}`,
      platform: 'web',
      appId: APP,
      stepDelay: 200,
      artifacts: 'on-failure',
      extra: { browser: 'chrome', windowSize: '1280x900' }
    })
    await browser.blockNetwork({
      patterns: ['*fonts.googleapis.com*', '*fonts.gstatic.com*']
    })
  })

  after(async function () {
    try {
      await browser?.detach()
    } finally {
      await daemon?.shutdown()
    }
  })

  it("W11 changes Kershaw's throws alone, on the two-column player form", async function () {
    const falcons = fixture.teams.falcons.id
    const kershaw = fixture.players['Clayton Kershaw']
    const token = await openAs(
      fixture.emails.coach,
      `/players/${kershaw}?tab=settings&onTeam=${falcons}`
    )
    await browser.assertVisible({
      css: '[data-testid="Player form"]',
      timeout: 60000
    })
    // The fields down the left, the positions on a field to the right.
    expect(
      await probe<boolean[]>(
        `(() => { const form = document.querySelector('[data-testid="Player form"]'); return [form.children.length === 2, form.children[0].querySelector('[aria-label="Jersey number"]') != null, form.children[1].querySelector('[data-testid="Position field"]') != null] })()`
      )
    ).deep.equals([true, true, true])
    expect(
      await probe<string | null>(
        `document.querySelector('[aria-label="Player position P"]').getAttribute('aria-selected')`
      )
    ).equals('true')
    expect(
      await probe<boolean>(
        `document.querySelector('[aria-label="Player position EH"]') == null`
      )
    ).equals(true)
    await shot('web-player-settings-form')
    const before = (await roster(token, falcons)).find(
      entry => entry.userId === kershaw
    )
    expect(before).to.include({ throws: 'left', bats: 'left', jersey: '22' })
    await tap('Throws Right')
    await tap('Save')
    await browser.assertVisible({ text: 'Saved.', timeout: 15000 })
    const after = (await roster(token, falcons)).find(
      entry => entry.userId === kershaw
    )
    expect(after).to.include({ throws: 'right', bats: 'left', jersey: '22' })
    expect(after.positions).deep.equals(before.positions)
    expect(after.shortName).equals(before.shortName)
  })
})
