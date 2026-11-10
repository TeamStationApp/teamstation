import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'
import { build } from 'esbuild'
import { describe, it } from 'mocha'

import {
  type BrowserSession,
  capture,
  fill
} from '../../e2e/rigs/refinementsMaestro'
import { TeamStationClient } from '../common/api'
import { userIdOfGumbo } from '../common/userId'
import { signInTestAccount } from '../test/passwordFixtures'
import { withUserIdsBrowser } from '../test/userIdsBrowser'
import { userIdsBrowserCoverage } from '../test/userIdsBrowserCoverage'

interface IdentityFixture {
  playerLegacyId: number
  scorerLegacyId: number
  gameId: string
  teamId: string
  local?: { email: string; passwordFile: string }
  seat?: { email: string; passwordFile: string }
}

async function seatSignIn(
  session: BrowserSession,
  origin: string,
  fixture: IdentityFixture
): Promise<void> {
  if (fixture.seat == null)
    throw new Error('Seat tests require real seat sign-in')
  const { page, m } = session
  await page.goto(origin + '/sign-in', { waitUntil: 'domcontentloaded' })
  await fill(m, 'E-mail address', fixture.seat.email)
  await m.tapOn({ text: 'Use a password instead', timeout: 15000 })
  await fill(m, 'Password', await readFile(fixture.seat.passwordFile, 'utf8'))
  await m.tapOn({ text: 'Sign in', timeout: 15000 })
  await page.waitForSelector('[aria-label^="Account, "]', { timeout: 60000 })
}

describe('canonical account IDs in Maestro D Chromium', function () {
  this.timeout(240000)
  it('preserves the player page, upgrades the old URL and stored scoring preferences', async () => {
    const file = process.env.TS_USER_IDS_FIXTURE
    const artifacts = process.env.TS_USER_IDS_ARTIFACTS
    if (file == null || artifacts == null)
      throw new Error('Supply TS_USER_IDS_FIXTURE and TS_USER_IDS_ARTIFACTS')
    const fixture: IdentityFixture = JSON.parse(await readFile(file, 'utf8'))
    const before = process.env.TS_USER_IDS_PHASE === 'before'
    const hosted = process.env.TS_USER_IDS_SEAT_ORIGIN != null
    let passed = 0
    await withUserIdsBrowser(
      artifacts,
      async (session, origin) => {
        const { page, m } = session
        page.setDefaultTimeout(60000)
        const api = hosted
          ? origin + '/api/v1'
          : (process.env.TS_API_TEST_URL ?? 'http://127.0.0.1:9180/api/v1')
        if (hosted) await seatSignIn(session, origin, fixture)
        else {
          if (fixture.local == null)
            throw new Error('Local tests require a synthetic fixture account')
          const token = await signInTestAccount(api, {
            email: fixture.local.email,
            password: await readFile(fixture.local.passwordFile, 'utf8')
          })
          await page.browserContext().setCookie({
            name: 'ts_session',
            value: encodeURIComponent(token),
            domain: new URL(origin).hostname,
            path: '/'
          })
        }
        const cookies = await page.browserContext().cookies()
        const cookie = cookies.find(item => item.name === 'ts_session')
        if (cookie == null)
          throw new Error('Sign-in did not establish a session')
        const token = decodeURIComponent(cookie.value)
        const suffix = before
          ? '?tab=stats'
          : '?tab=stats&identityProof=1#stats'
        await page.goto(
          `${origin}/players/${fixture.playerLegacyId}${suffix}`,
          { waitUntil: 'domcontentloaded' }
        )
        const playerId = before
          ? String(fixture.playerLegacyId)
          : userIdOfGumbo(fixture.playerLegacyId)
        await page.waitForFunction(
          expected => location.pathname === expected,
          {},
          '/players/' + playerId
        )
        if (!before) {
          expect(new URL(page.url()).search).equals(
            '?tab=stats&identityProof=1'
          )
          expect(new URL(page.url()).hash).equals('#stats')
        }
        await m.assertVisible({ text: 'Stats', timeout: 60000 })
        await m.tapOn({ text: 'Stats', timeout: 15000 })
        if (hosted) {
          const response = await fetch(`${api}/players/${playerId}/stats`, {
            headers: { Authorization: `Bearer ${token}` }
          })
          expect(response.status).equals(200)
          const stats = await response.json()
          expect(stats.batting != null || stats.pitching != null).equals(true)
          await m.assertVisible({
            text: stats.batting != null ? 'Batting' : 'Pitching',
            timeout: 60000
          })
        }
        await capture(
          m,
          artifacts,
          `player-page-${before ? 'before' : 'after'}.png`
        )
        const playerResponse = await fetch(`${api}/players/${playerId}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
        expect(playerResponse.status).equals(200)
        const player = await playerResponse.json()
        if (!hosted)
          await writeFile(
            join(artifacts, `player-page-${before ? 'before' : 'after'}.json`),
            JSON.stringify(player),
            { mode: 0o600 }
          )
        if (!before) {
          expect(
            (
              await fetch(`${api}/players/${fixture.playerLegacyId}`, {
                headers: { Authorization: `Bearer ${token}` }
              })
            ).status
          ).equals(400)
          const client = new TeamStationClient({ baseUrl: api, token })
          const roster = await client.roster(fixture.teamId)
          expect(
            roster.some(
              entry =>
                entry.userId === playerId &&
                entry.gumboId === fixture.playerLegacyId
            )
          ).equals(true)
          const legacyKey = `teamstation:scoring:${fixture.scorerLegacyId}:switch-hitter`
          const currentKey = `teamstation:scoring:${userIdOfGumbo(fixture.scorerLegacyId)}:switch-hitter`
          await page.evaluate(
            (old, current) => {
              localStorage.removeItem(current)
              localStorage.setItem(
                old,
                JSON.stringify({
                  help: false,
                  shown: 3,
                  sound: false,
                  animations: false
                })
              )
            },
            legacyKey,
            currentKey
          )
          await page.goto(`${origin}/games/${fixture.gameId}/score`, {
            waitUntil: 'domcontentloaded'
          })
          await page.waitForSelector('[aria-label="Open scoring menu"]')
          await page.waitForFunction(
            (old, current) =>
              localStorage.getItem(old) === null &&
              localStorage.getItem(current) !== null,
            {},
            legacyKey,
            currentKey
          )
          const saved = await page.evaluate(
            key => localStorage.getItem(key),
            currentKey
          )
          expect(JSON.parse(saved!)).includes({
            help: false,
            sound: false,
            animations: false
          })
          await capture(m, artifacts, 'scoring-preferences-after.png')
          if (!hosted) {
            // Exercise the real device-link reader against Chromium storage;
            // browser music playback is outside this migration scenario.
            const probe = await build({
              stdin: {
                contents: `import { deviceLinks } from './src/app/walkup/resolveSong'; window.readMigratedDeviceLink = deviceLinks.read`,
                resolveDir: process.cwd()
              },
              bundle: true,
              write: false,
              platform: 'browser',
              format: 'iife'
            })
            await page.addScriptTag({ content: probe.outputFiles[0].text })
            const old = `walkUp:${fixture.teamId}:${fixture.playerLegacyId}:fixture-song`
            const current = `walkUp:${fixture.teamId}:${playerId}:fixture-song`
            const result = await page.evaluate(
              async (old, current, teamId, userId) => {
                localStorage.removeItem(current)
                localStorage.setItem(old, 'fixture-device-handle')
                const read = (
                  window as unknown as {
                    readMigratedDeviceLink: (
                      owner: { teamId: string; userId: string },
                      providerId: string
                    ) => Promise<string | null>
                  }
                ).readMigratedDeviceLink
                return {
                  handle: await read({ teamId, userId }, 'fixture-song'),
                  old: localStorage.getItem(old),
                  current: localStorage.getItem(current)
                }
              },
              old,
              current,
              fixture.teamId,
              playerId
            )
            expect(result).deep.equals({
              handle: 'fixture-device-handle',
              old: null,
              current: 'fixture-device-handle'
            })
          }
        }
        passed++
      },
      !hosted && !before
        ? async session => {
            if (passed === 0) return
            await userIdsBrowserCoverage(
              session.page,
              new URL(session.page.url()).origin,
              join(artifacts, 'browser-coverage.json'),
              passed
            )
          }
        : undefined
    )
  })
})
