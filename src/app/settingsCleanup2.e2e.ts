/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Browser callbacks are serialized without compiler helpers. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import express from 'express'

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
  const media = join(artifacts!, 'support', `fixture-media-${phase}`)
  await mkdir(media, { recursive: true })
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=15',
    '-t',
    '90',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '75',
    '-hls_time',
    '5',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    join(media, 'segment-%02d.ts'),
    join(media, 'index.m3u8')
  ])
  const stub = await googlePlacesStub()
  const f = await groupFixture(
    resolve(process.env.TS_SETTINGS2_WEB_ROOT ?? 'dist'),
    undefined,
    app => {
      app.use('/fixture-media', express.static(media, { dotfiles: 'allow' }))
    },
    googlePlaces({ apiKey: 'placeholder-key', baseUrl: stub.baseUrl })
  )
  const daemon = await maestro(`settings2-${phase}-${process.pid}`)
  const { m, page, browser } = await browserSession(
    daemon,
    `settings2-${phase}-${process.pid}`,
    402,
    874,
    artifacts!,
    'chrome'
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
    await page.waitForSelector(selector)
    await m.command('scroll', { direction: amount > 0 ? 'down' : 'up' })
    await m.waitForAnimationToEnd()
  }
  let stopRecording: (() => Promise<void>) | undefined
  try {
    await note(
      `$ node -r sucrase/register src/app/settingsCleanup2.e2e.ts ${phase}`
    )
    await freezeBrowserClock(page, Date.parse('2027-04-10T17:00:00Z'))
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 1,
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
    if (!process.argv.includes('layouts')) {
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
        await fill(m, 'Find an account', 'fixture106')
        await contains(page, 'Tim Raines')
        await shot('node-search')
        await tap(m, 'Grant node role to Tim Raines')
        await m.scrollUntilVisible({
          element: { text: 'Confirm account change' }
        })
        await tap(m, 'Confirm account change')
        await m.scrollUntilVisible({
          element: { text: 'Remove node role from Tim Raines' }
        })
        await tap(m, 'Remove node role from Tim Raines')
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
      if (process.argv.includes('M2')) return
    }
    // Layout fixtures use the same realistic game/player responses in both phases.
    let fixtureMode = false
    const now = Date.parse('2027-04-10T17:00:00Z')
    const game = asGameDetail({
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
      videos: ['left', 'right'].map(id => ({
        id: `vid_${id}`,
        title: id === 'left' ? 'Left field' : 'Right field',
        numCameras: 1,
        kind: 'original',
        status: 'ready',
        storage: 'spaces',
        startAt: '2027-04-10T19:00:00Z',
        durationSec: 90,
        width: 320,
        height: 180,
        codecs: 'h264'
      })),
      canScore: true,
      hasScoringEvents: true
    })
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
          eventKind: game.eventKind ?? 'game',
          eventType: game.eventType,
          title: game.title ?? null,
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
      else if (route === '/events/gam_settings2/location')
        body = {
          latitude: null,
          longitude: null,
          tileUrl: 'https://tiles.example.test/{z}/{x}/{y}.png'
        }
      else if (route === '/games/gam_settings2/box-score')
        body = { batting: [], pitching: [] }
      else if (/^\/videos\/vid_(left|right)\/playback$/.test(route))
        body = {
          videoId: route.split('/')[2],
          storage: 'spaces',
          url: f.h.origin + '/fixture-media/index.m3u8',
          expiresAt: null,
          durationSec: 90,
          unavailable: false
        }
      else if (/^\/videos\/vid_(left|right)\/highlights$/.test(route))
        body = {
          withheld: null,
          highlights: Array.from({ length: 40 }, (_, i) => ({
            eventId: `evt_${i}`,
            atBatIndex: i,
            title: `Hank Aaron play ${i + 1}`,
            startOffsetSec: i * 2,
            playOffsetSec: i * 2,
            eventType: 'single',
            isScoringPlay: i % 3 === 0,
            stillUrl:
              'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="green"/></svg>',
            description: `Hank Aaron reaches base in play ${i + 1}.`
          }))
        }
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
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await scroll('[aria-label="Game sections"]', 550)
    await shot('event-desktop')
    if (!before) {
      const top = await page.$eval(
        '[aria-label="Game sections"]',
        node => node.getBoundingClientRect().top
      )
      assert(top >= 40 && top <= 65, `desktop event sections pinned: ${top}`)
    }
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true
    })
    await tap(m, 'Box score', 'tab')
    await contains(page, 'Box score')
    await tap(m, 'Info', 'tab')
    await contains(page, 'Demo Field')
    await note(`E5 ${phase}: event Info and Box score navigation`)
    await go('/games/gam_settings2?tab=watch', 'Hank Aaron play 1')
    await page
      .waitForFunction(() => {
        const v = document.querySelector('video')
        return v != null && v.readyState >= 2
      })
      .catch(async (error: unknown) => {
        console.log(
          await page.evaluate(() =>
            [...document.querySelectorAll('video')].map(v => ({
              ready: v.readyState,
              src: v.src,
              time: v.currentTime,
              error: v.error == null ? null : v.error.message,
              canPlay: v.canPlayType('video/mp4; codecs="avc1.42E01E"')
            }))
          )
        )
        throw error
      })
    // Start at the largest viewport so the recording preserves readable
    // landscape frames instead of shrinking them to a portrait-width strip.
    if (!before)
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    const recording = before
      ? undefined
      : await page.record({
          path: join(artifacts!, 'watch-pinning.webm'),
          maxWidth: 1440,
          maxHeight: 900,
          frameRate: 15
        })
    stopRecording = recording?.stop.bind(recording)
    const hold = async (): Promise<void> => {
      if (!before) await new Promise(resolve => setTimeout(resolve, 2500))
    }
    if (!before) {
      await hold()
      await page.setViewport({
        width: 402,
        height: 874,
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true
      })
      await hold()
    }
    const center = await page.$eval('video', node => {
      const r = node.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await m.command('tapOnPoint', center)
    await page.waitForFunction(() => {
      const v = document.querySelector('video')
      return v != null && v.currentTime > 0.5
    })
    await scroll('[aria-label="Game sections"]', 550)
    await shot('video')
    if (!before) {
      const playingAt = await page.$eval('video', node => node.currentTime)
      await page.waitForFunction(
        at => {
          const v = document.querySelector('video')
          return v != null && v.currentTime >= at + 3
        },
        {},
        playingAt
      )
      const positions = await page.evaluate(() => ({
        tabs: document
          .querySelector('[aria-label="Game sections"]')!
          .getBoundingClientRect().top,
        video: document.querySelector('video')!.getBoundingClientRect().top
      }))
      assert(
        positions.tabs >= 40 && positions.tabs <= 65,
        `watch pills pinned: ${JSON.stringify(positions)}`
      )
      assert(positions.video > positions.tabs, 'video clears pinned sections')
      const video = await page.$('video')
      await page.setViewport({
        width: 874,
        height: 402,
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true
      })
      await page.waitForFunction(() => innerWidth === 874)
      assert(
        await video!.evaluate(node => node.isConnected),
        'same video survives orientation change'
      )
      await page.waitForFunction(() => {
        const v = document.querySelector('video')
        return v != null && !v.paused && v.currentTime > 1
      })
      await hold()
      await tap(m, 'Right field', 'tab')
      await page.waitForFunction(() => {
        const v = document.querySelector('video')
        return v != null && v.readyState >= 2
      })
      await hold()
      await tap(m, 'Box score', 'tab')
      await hold()
      await tap(m, 'Videos', 'tab')
      await page.waitForFunction(() => {
        const v = document.querySelector('video')
        return v != null && v.readyState >= 2
      })
      if (await page.$eval('video', node => node.paused)) {
        const point = await page.$eval('video', node => {
          const r = node.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        })
        await m.command('tapOnPoint', point)
      }
      const returnedAt = await page.$eval('video', node => node.currentTime)
      await page.waitForFunction(
        at => {
          const v = document.querySelector('video')
          return v != null && !v.paused && v.currentTime >= at + 3
        },
        {},
        returnedAt
      )
      await page.setViewport({
        width: 402,
        height: 874,
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true
      })
      await hold()
      await recording!.stop()
      stopRecording = undefined
    }
    await note(`E6 ${phase}: event Videos layout`)
    for (const eventType of ['practice', 'other'] as const) {
      game.eventKind = 'event'
      game.eventType = eventType
      game.title = eventType === 'practice' ? null : 'Team meeting'
      game.status = 'scheduled'
      await go(
        '/games/gam_settings2?tab=info',
        eventType === 'practice' ? 'Practice' : 'Team meeting'
      )
      await contains(page, 'Demo Field')
      await scroll('[aria-label="Game sections"]', 550)
      await shot(eventType)
      if (!before) {
        const top = await page.$eval(
          '[aria-label="Game sections"]',
          node => node.getBoundingClientRect().top
        )
        assert(top >= 40 && top <= 65, `${eventType} sections pinned: ${top}`)
      }
    }

    await go('/schedule', 'SCHEDULE')
    await scroll('[role="tab"]', 550)
    await shot('feed')
    if (!before) {
      const top = await page.$eval(
        '[role="tablist"]',
        node => node.getBoundingClientRect().top
      )
      assert(top >= 40 && top <= 65, `feed sections pinned: ${top}`)
      await tap(m, 'Past', 'tab')
      await contains(page, 'SCHEDULE')
      await go(`/teams/${TEAM_ID}?tab=team`, PLAYER_NAME)
      await scroll('[aria-label="Team sections"]', 550)
      const team = await page.$eval(
        '[aria-label="Team sections"]',
        node => node.getBoundingClientRect().top
      )
      assert(team >= 40 && team <= 65, `team comparison: ${team}`)
      await go(`/players/${PLAYER_ID}?tab=videos`, PLAYER_NAME)
      await scroll('[aria-label="Player sections"]', 550)
      const player = await page.$eval(
        '[aria-label="Player sections"]',
        node => node.getBoundingClientRect().top
      )
      assert(player >= 40 && player <= 65, `player comparison: ${player}`)
    }
    await note(`E7 ${phase}: schedule feed navigation`)
    await go(`/players/${PLAYER_ID}?tab=stats&forTeam=${TEAM_ID}`, PLAYER_NAME)
    await contains(page, 'Career')
    await shot('stats')
    if (!before) {
      assert((await page.$('[aria-label="Filter stats"]')) != null)
      await tap(m, 'Filter stats')
      await tap(m, 'Spring 2026', 'radio')
      await tap(m, 'Show these')
      await page.waitForFunction(() =>
        document
          .querySelector('[aria-label="Filter stats"]')!
          .textContent!.includes('Spring')
      )
      await page.reload()
      await page.waitForSelector('[aria-label="Filter stats"]')
      assert(
        (await page.$eval(
          '[aria-label="Filter stats"]',
          node => node.textContent
        ))!.includes('Spring')
      )
      await tap(m, 'Videos', 'tab')
      assert(
        (await page.$eval(
          '[aria-label="Filter videos"]',
          node => node.textContent
        ))!.includes('Career')
      )
    }
    await note(`E8 ${phase}: player Stats selected-filter control`)
  } finally {
    await stopRecording?.().catch(() => undefined)
    if (!before)
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
