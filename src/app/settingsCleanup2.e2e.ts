/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Browser callbacks are serialized without compiler helpers. */
import assert from 'node:assert/strict'
import { appendFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { asGameDetail } from '../common/api'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { googlePlaces } from '../server/location/googlePlaces'
import { googlePlacesStub } from '../test/googlePlacesStub'
import { groupFixture } from '../test/groupFixtures'
import {
  browserSession,
  capture,
  contains,
  fill,
  maestro,
  tap
} from '../test/refinementsMaestro.e2e'
import {
  PLAYER_ID,
  PLAYER_NAME,
  TEAM_ID,
  teamScheduleAnswer
} from '../test/teamScheduleFixture'
import { recordBrowserCoverage } from './browserCoverage.e2e'
import { freezeBrowserClock } from './creationBrowserActions.e2e'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null) throw new Error('Supply TS_CREATION_ARTIFACTS')
const before = process.argv.includes('before')
const phase = before ? 'before' : 'after'
async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const stub = await googlePlacesStub()
  const f = await groupFixture(
    resolve('dist'),
    undefined,
    undefined,
    googlePlaces({ apiKey: 'placeholder-key', baseUrl: stub.baseUrl })
  )
  const daemon = await maestro(`settings2-${phase}-${process.pid}`)
  const { m, page, browser } = await browserSession(
    daemon,
    `settings2-${phase}-${process.pid}`,
    402,
    874,
    artifacts!
  )
  const note = async (message: string): Promise<void> => {
    console.log(message)
    await appendFile(join(artifacts!, 'browser.log'), message + '\n')
  }
  const shot = async (name: string): Promise<void> => {
    await capture(m, artifacts!, `${name}-${phase}.png`)
  }
  const go = async (path: string, text: string): Promise<void> => {
    await m.openLink({ link: f.h.origin + path })
    await contains(page, text)
    await page
      .waitForNetworkIdle({ idleTime: 100, timeout: 10000 })
      .catch(() => undefined)
  }
  const scroll = async (selector: string, amount: number): Promise<void> => {
    // Find the actual scroll owner and deliver the gesture through maestro-d.
    const point = await page.$eval(selector, node => {
      const r = node.getBoundingClientRect()
      return {
        x: Math.max(20, Math.min(innerWidth - 20, r.x + r.width / 2)),
        y: Math.max(160, Math.min(innerHeight - 130, r.y + 100))
      }
    })
    await m.swipe({
      startX: Math.round(point.x),
      endX: Math.round(point.x),
      startY: amount > 0 ? 710 : 200,
      endY: amount > 0 ? 200 : 710,
      duration: 400
    })
    await m.waitForAnimationToEnd()
  }
  try {
    await note(
      `$ node -r sucrase/register src/app/settingsCleanup2.e2e.ts ${phase}`
    )
    await freezeBrowserClock(page, Date.parse('2027-04-10T17:00:00Z'))
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true
    })
    await f.h.db
      .updateTable('users')
      .set({ is_admin: true })
      .where('id', '=', 101)
      .execute()
    await f.h.db
      .updateTable('teams')
      .set({ name: 'Bluebirds' })
      .where('id', '=', f.teamA)
      .execute()
    await f.h.db
      .updateTable('leagues')
      .set({ name: 'Harbor League' })
      .where('id', '=', f.leagueA)
      .execute()
    await f.h.db
      .updateTable('seasons')
      .set({ name: 'Spring 2026' })
      .where('id', '=', f.seasonA)
      .execute()
    await browser.setCookie({
      name: SESSION_COOKIE,
      value: f.h.tokens.get(101)!,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
    await go(
      '/i/unknown-placeholder',
      before ? 'That invite link is not good' : 'Invalid invite link'
    )
    await shot('invite')
    await note(`E1 ${phase}: unknown invitation rendered`)
    await go(`/groups/team/${f.teamA}/settings`, 'TEAM DETAILS')
    await m.scrollUntilVisible({ element: { text: 'Leave Harbor League' } })
    await tap(m, 'Leave Harbor League')
    await contains(page, 'will no longer manage Bluebirds')
    await shot('parent-cancel')
    if (!before) {
      const cancel = await page.$eval('[aria-label="Cancel"]', node => {
        const r = node.getBoundingClientRect()
        return {
          center: r.x + r.width / 2,
          color: getComputedStyle(
            node.firstElementChild == null ? node : node.firstElementChild
          ).color
        }
      })
      assert(Math.abs(cancel.center - 201) < 2, 'parent Cancel centered')
      assert.equal(cancel.color, 'rgb(21, 101, 192)')
    }
    await tap(m, 'Cancel')
    await contains(page, 'TEAM DETAILS')
    await note(`E2 ${phase}: parent review and cancellation`)
    await go(`/groups/team/${f.teamA}/settings/location`, 'Demo City')
    await shot('location')
    if (!before) {
      const x = await page.$eval('[aria-label="Cancel"]', node => {
        const r = node.getBoundingClientRect()
        return r.x + r.width / 2
      })
      assert(Math.abs(x - 201) < 2, 'location Cancel centered')
    }
    await tap(m, 'Cancel')
    await note(`E3 ${phase}: location footer and cancellation`)
    if (process.argv.includes('M1')) return
    await go('/node', 'Node administration')
    await shot('node')
    if (before) {
      await fill(m, 'Find an account', 'alex@example.com')
      await shot('node-search')
      await m.scrollUntilVisible({
        element: { text: 'Remove node role from Babe Ruth' }
      })
      await tap(m, 'Remove node role from Babe Ruth')
      await m.scrollUntilVisible({
        element: { text: 'Confirm account change' }
      })
      await shot('node-revoke')
      await tap(m, 'Keep account unchanged')
    }
    if (!before) {
      assert(!(await page.content()).includes('Refresh accounts'))
      assert(!(await page.content()).includes('Suspend Babe Ruth'))
      await fill(m, 'Find an account', 'fixture106')
      await contains(page, 'Tim Raines')
      await shot('node-search-after'.replace('-after', ''))
      await tap(m, 'Add Tim Raines')
      await page.waitForSelector('[aria-label="Revoke Tim Raines"]')
      await tap(m, 'Revoke Tim Raines')
      await contains(page, 'Revoke node access for Tim Raines?')
      await shot('node-revoke-after'.replace('-after', ''))
      await tap(m, 'Cancel')
      assert((await page.$('[aria-label="Revoke Tim Raines"]')) != null)
      await tap(m, 'Revoke Tim Raines')
      await tap(m, 'Confirm revoke')
      await page.waitForSelector('[aria-label="Add Tim Raines"]')
    }
    await note(
      `E4 ${phase}: node access list${before ? '' : ', email search, Add, canceled and confirmed Revoke'}`
    )
    // Layout fixtures use the same realistic game/player responses in both phases.
    let fixtureMode = false
    const now = Date.parse('2027-04-10T17:00:00Z')
    const game = {
      id: 'gam_settings2',
      homeTeamId: 'tem_home',
      awayTeamId: 'tem_away',
      homeTeamName: 'Owls',
      awayTeamName: 'Eagles',
      seasonId: null,
      startAt: '2027-04-10T19:00:00Z',
      endAt: '2027-04-10T21:00:00Z',
      timezone: 'UTC',
      venue: 'Demo Field',
      status: 'final',
      homeScore: 4,
      awayScore: 2,
      ingestStatus: 'none',
      ingestMessage: null,
      nonMemberView: false,
      videos: [],
      canScore: true,
      hasScoringEvents: true
    }
    asGameDetail(game)
    await page.setRequestInterception(true)
    page.on('request', request => {
      const url = new URL(request.url())
      if (!fixtureMode || !url.pathname.startsWith('/api/v1/')) {
        request.continue().catch(() => undefined)
        return
      }
      const route = url.pathname.replace('/api/v1', '')
      let body: unknown
      if (route === '/games/gam_settings2') body = game
      else if (route === '/events/gam_settings2/info')
        body = {
          ...game,
          eventKind: 'game',
          title: null,
          teamId: 'tem_home',
          teamName: 'Owls',
          address: null,
          latitude: null,
          longitude: null,
          canManage: true,
          attendees: Array.from({ length: 28 }, (_, i) => ({
            userId: i + 400,
            name: `Player ${i + 1}`,
            avatarUrl: null,
            jersey: String(i + 1),
            isPlayer: true,
            isTeamParticipant: true,
            response: null,
            canReply: false
          })),
          replyUserIds: []
        }
      else if (route === '/games/gam_settings2/box-score')
        body = { batting: [], pitching: [] }
      else if (route === '/games/gam_settings2/scheduling')
        body = {
          game: { ...game, outsideTournament: null, exhibition: true },
          version: 'a'.repeat(64),
          canPropose: false,
          withdrawTeamIds: [],
          administeredTeamIds: []
        }
      else
        body = teamScheduleAnswer(
          request.method(),
          url.pathname + url.search,
          now,
          () => {}
        ).body
      request
        .respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body)
        })
        .catch(() => undefined)
    })
    fixtureMode = true
    await go('/games/gam_settings2?tab=info', 'Demo Field')
    await scroll('[aria-label="Game sections"]', 550)
    await shot('event')
    if (!before) {
      const top = await page.$eval(
        '[aria-label="Game sections"]',
        node => node.getBoundingClientRect().top
      )
      assert(top >= 40 && top <= 65, `event pills at header: ${top}`)
    }
    await tap(m, 'Box score', 'tab')
    await contains(page, 'Box score')
    await tap(m, 'Info', 'tab')
    await contains(page, 'Demo Field')
    await note(`E5 ${phase}: event Info and Box score navigation`)
    await go('/games/gam_settings2?tab=watch', 'No videos.')
    await shot('video')
    await note(`E6 ${phase}: event Videos layout`)
    await go('/schedule', 'SCHEDULE')
    await scroll('[role="tab"]', 550)
    await shot('feed')
    await note(`E7 ${phase}: schedule feed navigation`)
    await go(`/players/${PLAYER_ID}?tab=stats&forTeam=${TEAM_ID}`, PLAYER_NAME)
    await contains(page, 'Career')
    await shot('stats')
    if (!before) assert((await page.$('[aria-label="Filter stats"]')) != null)
    await note(`E8 ${phase}: player Stats selected-filter control`)
  } finally {
    await recordBrowserCoverage(
      [page],
      f.h.origin,
      resolve(`coverage/settingsCleanup2/browser-${phase}.json`)
    )
    await m.detach()
    await browser.disconnect()
    await daemon.shutdown()
    await f.h.close()
    await stub.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
