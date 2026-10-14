/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Serialized browser callbacks cannot capture compiler helpers. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import express from 'express'

import { asGameDetail, TeamStationClient } from '../common/api'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { googlePlaces } from '../server/location/googlePlaces'
import { googlePlacesStub } from '../test/googlePlacesStub'
import { groupFixture } from '../test/groupFixtures'
import {
  browserSession,
  contains,
  fill,
  maestro,
  tap
} from '../test/refinementsMaestro.e2e'
import { seedSettingsCleanup3 } from '../test/settingsCleanup3Fixture'
import { teamScheduleAnswer } from '../test/teamScheduleFixture'
import { teamTint } from './components/teamTile'
import { freezeBrowserClock } from './creationBrowserActions.e2e'

const artifacts = process.env.TS_CREATION_ARTIFACTS
if (artifacts == null) throw new Error('Supply TS_CREATION_ARTIFACTS')
const before = process.argv.includes('--base')
const phase = before ? 'before' : 'after'
const only = process.env.TS_SETTINGS3_SCENARIO

async function main(): Promise<void> {
  await mkdir(artifacts!, { recursive: true })
  const media = join(artifacts!, 'support', 'fixture-media')
  if (only === 'video') {
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
  }
  let stopRecording: (() => Promise<void>) | undefined
  const stub = await googlePlacesStub()
  const f = await groupFixture(
    resolve(process.env.TS_SETTINGS3_WEB_ROOT ?? 'dist'),
    undefined,
    app => {
      if (only === 'video') app.use('/fixture-media', express.static(media))
    },
    googlePlaces({ apiKey: 'placeholder-key', baseUrl: stub.baseUrl })
  )
  const daemon = await maestro(`settings3-${phase}-${process.pid}`)
  const { m, page, browser } = await browserSession(
    daemon,
    `settings3-${phase}-${process.pid}`,
    402,
    874,
    artifacts!,
    'chrome'
  )
  const note = async (line: string): Promise<void> => {
    console.log(line)
    await appendFile(join(artifacts!, 'settings-cleanup3-e2e.log'), line + '\n')
  }
  page.on('pageerror', error => {
    console.error('Browser error:', String(error))
  })
  const go = async (path: string, text: string): Promise<void> => {
    await m.openLink({ link: f.h.origin + path })
    await contains(page, text)
    await page.waitForNetworkIdle({ idleTime: 150, timeout: 10000 })
  }
  const shot = async (name: string): Promise<void> => {
    // Live indicators animate continuously; each route's loaded state is
    // asserted before capturing rather than waiting for the entire DOM to stop.
    // Modal content mounts before its 300ms entrance transition completes.
    await new Promise(resolve => setTimeout(resolve, 450))
    await writeFile(
      join(artifacts!, `${name}-${phase}.png`),
      await m.screenshot()
    )
    await note(`Captured ${name}-${phase}.png`)
  }
  const show = async (text: string): Promise<void> => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const position = await page.evaluate(text => {
        const node = [...document.querySelectorAll<HTMLElement>('*')].find(
          node =>
            node.getAttribute('aria-label') === text ||
            (node.children.length === 0 && node.textContent === text)
        )
        if (node == null) throw new Error('Missing scroll target: ' + text)
        const box = node.getBoundingClientRect()
        return { y: box.y + box.height / 2, height: innerHeight }
      }, text)
      if (position.y > 90 && position.y < position.height - 100) return
      await m.command('scroll', {
        direction: position.y > position.height - 100 ? 'down' : 'up'
      })
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    await writeFile(
      join(artifacts!, 'support/scroll-failure.png'),
      await m.screenshot()
    )
    const positions = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('*')]
        .filter(
          node =>
            node.scrollHeight > node.clientHeight + 20 &&
            node.clientHeight > 100
        )
        .map(node => ({
          tag: node.tagName,
          scroll: node.scrollTop,
          height: node.clientHeight,
          total: node.scrollHeight
        }))
    )
    throw new Error(
      'Scroll target remained outside usable viewport: ' +
        text +
        ' ' +
        JSON.stringify(positions)
    )
  }
  const cancelCheck = async (destructive: boolean): Promise<void> => {
    if (before) return
    const result = await page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll<HTMLElement>('[role="button"]')
      ].filter(node => node.textContent === 'Cancel')
      const button = candidates[candidates.length - 1]
      const text = button.firstElementChild as HTMLElement
      const rect = button.getBoundingClientRect()
      const parent = button.parentElement!.getBoundingClientRect()
      return {
        delta: Math.abs(rect.x + rect.width / 2 - parent.x - parent.width / 2),
        color: getComputedStyle(text).color,
        height: rect.height
      }
    })
    assert(result.delta <= 2, 'Cancel centered: ' + JSON.stringify(result))
    assert(result.height >= 48, 'Cancel full touch target')
    assert.equal(
      result.color,
      destructive ? 'rgb(21, 101, 192)' : 'rgb(186, 26, 26)'
    )
  }
  const pickerCheck = async (): Promise<void> => {
    if (before) return
    await page.waitForSelector('[data-testid^="team-result-"]')
    const result = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(
        '[data-testid^="team-result-"]'
      )!
      const leaves = [...row.querySelectorAll<HTMLElement>('*')].filter(
        node => node.children.length === 0
      )
      const title = leaves.find(node =>
        /^(Winter|Orchard)/.test(
          node.textContent == null ? '' : node.textContent
        )
      )!
      const headerCancel = document.querySelector<HTMLElement>(
        '[aria-label="Cancel team selector"]'
      )!
      const label = headerCancel.firstElementChild!.getBoundingClientRect()
      const header = headerCancel.parentElement!.getBoundingClientRect()
      return {
        radios: document.querySelectorAll(
          '[data-testid="team-selector"] [role="radio"]'
        ).length,
        fontSize: getComputedStyle(title).fontSize,
        weight: getComputedStyle(title).fontWeight,
        chevron: row.textContent!.includes('chevron_right'),
        offset: header.right - label.right,
        background: getComputedStyle(row.parentElement!).backgroundColor
      }
    })
    assert.equal(result.radios, 0)
    assert.equal(result.fontSize, '16px')
    assert.equal(result.weight, '600')
    assert(result.chevron)
    assert(
      Math.abs(result.offset - 16) <= 2,
      'header Cancel matches right inset: ' + JSON.stringify(result)
    )
    await note(
      'E7 PASS: standalone Home typography, chevron/no radio and flush-right Cancel'
    )
  }
  const initialsCheck = async (): Promise<void> => {
    if (before) return
    await page.evaluate(async () => await document.fonts.ready)
    const metrics = await page.evaluate(() => {
      const preview = document.querySelector<HTMLElement>(
        '[aria-label^="Initials preview:"]'
      )!
      const tile = preview.firstElementChild! as HTMLElement
      const text = tile.firstElementChild! as HTMLElement
      const font = getComputedStyle(text)
      const canvas = document.createElement('canvas').getContext('2d')!
      canvas.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`
      const measured = canvas.measureText(text.textContent!)
      const box = tile.getBoundingClientRect()
      return {
        width: measured.width,
        height:
          measured.actualBoundingBoxAscent + measured.actualBoundingBoxDescent,
        box: box.width,
        font: parseFloat(font.fontSize)
      }
    })
    assert(
      metrics.width <= metrics.box * 0.81 &&
        metrics.height <= metrics.box * 0.81,
      'glyphs contained: ' + JSON.stringify(metrics)
    )
    assert(
      Math.max(metrics.width, metrics.height) >= metrics.box * 0.75,
      'initials fill inner area: ' + JSON.stringify(metrics)
    )
    assert(metrics.font > 32)
    await note('E9 PASS measured initials bounds: ' + JSON.stringify(metrics))
  }
  try {
    await note(
      `$ node -r sucrase/register src/app/settingsCleanup3.e2e.ts ${before ? '--base' : ''}`
    )
    await seedSettingsCleanup3(f)
    await freezeBrowserClock(page, Date.parse('2027-04-10T17:00:00Z'))
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true
    })
    await browser.setCookie({
      name: SESSION_COOKIE,
      value: f.h.tokens.get(101)!,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
    const settings = `/groups/team/${f.teamA}/settings`
    const api = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      token: f.h.tokens.get(101)!
    })
    if (only == null || only === 'overview') {
      await go(settings, 'TEAM DETAILS')
      await show('Winter Weekends')
      await shot('season-participations')
      if (before) await shot('leave-season')
      else {
        await tap(m, 'Leave season Winter Weekends')
        await contains(page, 'Leave Winter Weekends?')
        await shot('leave-season')
        await tap(m, 'Cancel')
        const beforeParents = (await api.group({ kind: 'team', id: f.teamA }))
          .parents
        assert.equal(
          (
            await f.h.db
              .selectFrom('season_teams')
              .select('active')
              .where('team_id', '=', f.teamA)
              .where('season_id', '=', f.seasonA)
              .executeTakeFirstOrThrow()
          ).active,
          true
        )
        await tap(m, 'Leave season Winter Weekends')
        await m.tapOn({
          css: '[data-testid="confirm-season-departure"]',
          timeout: 15000
        })
        await page.waitForFunction(
          () =>
            document.querySelector(
              '[aria-label="Leave season Winter Weekends"]'
            ) == null
        )
        const updated = await api.group({ kind: 'team', id: f.teamA })
        assert.deepEqual(updated.parents, beforeParents)
        assert(
          updated.participatingSeasons.some(season => season.id === f.playoffs)
        )
        assert.equal(
          (
            await f.h.db
              .selectFrom('games')
              .select('status')
              .where('id', '=', 'gam_settings3_scheduled')
              .executeTakeFirstOrThrow()
          ).status,
          'scheduled'
        )
        await note(
          'E1 PASS: canceled and confirmed departure; other season, parents and scheduled game preserved'
        )
        // Other scenarios start from the same fictional membership as their
        // before captures, independently of the departure mutation above.
        await f.h.db
          .updateTable('season_teams')
          .set({ active: true })
          .where('team_id', '=', f.teamA)
          .where('season_id', '=', f.seasonA)
          .execute()
      }
      for (const [name, path, text] of [
        ['team-gear', `/groups/team/${f.teamA}`, 'Winter Wolves'],
        ['league-gear', `/groups/league/${f.leagueA}`, 'Willow Woods'],
        ['season-gear', `/groups/season/${f.seasonA}`, 'Winter Weekends'],
        ['game-live-gear', '/games/gam_settings3_live?tab=info', 'Demo Field'],
        [
          'game-final-gear',
          '/games/gam_settings3_final?tab=info',
          'Demo Field'
        ],
        ['player-gear', `/players/104?onTeam=${f.teamA}`, 'Ichiro'],
        [
          'player-team-tiles',
          `/players/104?onTeam=${f.teamA}&tab=teams`,
          'Winter Wolves'
        ],
        ['home-team-tiles', '/', 'Winter Wolves'],
        ['discovery-team-tiles', '/discover?kind=team', 'Discover'],
        [
          'standings-team-tiles',
          `/groups/season/${f.seasonA}?tab=standings`,
          'Winter Weekends'
        ],
        ['team-settings-tile', settings, 'TEAM DETAILS']
      ]) {
        await go(path, text)
        if (name === 'discovery-team-tiles') {
          const searched = page.waitForResponse(
            response =>
              new URL(response.url()).pathname.endsWith('/teams') &&
              new URL(response.url()).searchParams.get('query') === 'Winter'
          )
          await fill(m, 'Search by name or city', 'Winter')
          await searched
          await contains(page, 'Winter Wolves')
          await page.waitForFunction(
            () => !document.body.textContent!.includes('Orchard Owls')
          )
        }
        await shot(name)
        if (
          !before &&
          [
            'team-gear',
            'team-settings-tile',
            'home-team-tiles',
            'discovery-team-tiles',
            'standings-team-tiles',
            'player-team-tiles'
          ].includes(name)
        ) {
          const actual = await page.evaluate(() => {
            return [...document.querySelectorAll<HTMLElement>('*')]
              .filter(
                node => node.children.length === 0 && node.textContent === 'WW'
              )
              .map(
                node => getComputedStyle(node.parentElement!).backgroundColor
              )
          })
          const expected = teamTint('Winter Wolves')
          assert(
            actual.includes(
              `rgb(${[1, 3, 5].map(i => parseInt(expected.slice(i, i + 2), 16)).join(', ')})`
            ),
            name + ' uses shared name tint'
          )
          await note('E8 PASS ' + name + ': matching initials and name hash')
        }
        if (!before && name.endsWith('-gear')) {
          const label = name.startsWith('game-')
            ? 'Event settings'
            : name.startsWith('team-')
              ? 'Manage'
              : name.startsWith('league-')
                ? 'League settings'
                : name.startsWith('season-')
                  ? 'Season settings'
                  : 'Player settings'
          await page.waitForSelector(`[aria-label="${label}"]`)
          const metrics = await page.$eval(`[aria-label="${label}"]`, node => {
            const box = node.getBoundingClientRect()
            return { width: box.width, height: box.height }
          })
          assert(
            metrics.width >= 48 && metrics.height >= 48,
            label + ' full touch target'
          )
          assert.equal(
            await page.$('[role="tab"][aria-label="Settings"]'),
            null
          )
          await tap(m, label)
          await contains(
            page,
            name === 'player-gear'
              ? 'FIRST NAME'
              : name.startsWith('game-')
                ? 'Game Settings'
                : 'DETAILS'
          )
          await note(
            `${name} PASS: hero gear opens authorized settings; no Settings pill`
          )
        }
      }
    }
    if (only === 'video') {
      // Layout fixtures use the same realistic game/player responses in both phases.
      let fixtureMode = false
      const now = Date.parse('2027-04-10T17:00:00Z')
      const game = asGameDetail({
        id: 'gam_settings3_video',
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
        if (route === '/games/gam_settings3_video') body = game
        else if (route === '/events/gam_settings3_video/info')
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
        else if (route === '/events/gam_settings3_video/location')
          body = {
            latitude: null,
            longitude: null,
            tileUrl: 'https://tiles.example.test/{z}/{x}/{y}.png'
          }
        else if (route === '/games/gam_settings3_video/box-score')
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
        else if (route === '/games/gam_settings3_video/scheduling')
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
      await go('/games/gam_settings3_video?tab=watch', 'Hank Aaron play 1')
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
        await page.setViewport({
          width: 1440,
          height: 900,
          deviceScaleFactor: 1
        })
      const recording = before
        ? undefined
        : await page.record({
            path: join(artifacts!, 'hero-tabs-rotation.webm'),
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
      await m.command('scroll', { direction: 'down' })
      await m.command('scroll', { direction: 'down' })
      await new Promise(resolve => setTimeout(resolve, 350))
      await shot('hero-tabs-video')
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
      await note(
        'E6 PASS: pinned watch pills, playback progression, same video through rotation and playable tab return'
      )
    }
    if (only === 'events') {
      await go('/games/tev_settings3_other?tab=info', 'Team meeting')
      await shot('event-gear')
      if (!before) {
        await tap(m, 'Event settings')
        await contains(page, 'Event Settings')
      }
      await go('/games/tev_settings3_practice?tab=info', 'Practice')
      await shot('practice-gear')
      if (!before) {
        await tap(m, 'Event settings')
        await contains(page, 'Event Settings')
        await note('E3 PASS practice and titled-event hero gears')
      }
    }
    if (only === 'cancel-audit') {
      for (const [scene, primary] of [
        ['date-range', 'Use this range'],
        ['stat-filter', 'Show these'],
        ['roles', 'Save'],
        ['promote', 'Send administrator invitation'],
        ['group-link', 'Send invitation'],
        ['game-form', 'Save'],
        ['game-retry', 'Retry game'],
        ['event-date', 'Use date'],
        ['event-time', 'Use time'],
        ['placeholder', 'Continue'],
        ['location-error', 'Retry'],
        ['people-error', 'Retry']
      ]) {
        await page.setViewport({
          width: 402,
          height:
            scene === 'roles'
              ? 1500
              : scene === 'date-range' || scene === 'event-date'
                ? 1200
                : 874,
          deviceScaleFactor: 1,
          isMobile: true,
          hasTouch: true
        })
        await m.openLink({
          link:
            f.h.origin +
            '/cancel-visual.html?case=' +
            scene +
            '&team=' +
            f.teamA
        })
        if (scene === 'group-link') {
          await page.waitForSelector('[aria-label="Search by name or city"]')
          await fill(m, 'Search by name or city', 'Demo League B')
          await tap(m, 'Choose Demo League B')
        }
        await contains(page, primary)
        await show(primary)
        await show('Cancel')
        if (!before) await cancelCheck(false)
        await shot('cancel-audit-' + scene)
        await note(
          'Cancel audit rendered ' + scene + ': primary and Cancel in frame'
        )
      }
    }
    if (only === 'evidence') {
      await go('/discover?kind=team', 'Discover')
      const searched = page.waitForResponse(
        response =>
          new URL(response.url()).pathname.endsWith('/teams') &&
          new URL(response.url()).searchParams.get('query') === 'Winter'
      )
      await fill(m, 'Search by name or city', 'Winter')
      await searched
      await contains(page, 'Winter Wolves')
      await page.waitForFunction(
        () => !document.body.textContent!.includes('Orchard Owls')
      )
      await shot('discovery-team-tiles')
      await go(settings + '/people', 'Add People')
      await show('Send invite')
      await cancelCheck(false)
      await shot('cancel-add-people')
      await note(
        'Evidence PASS: completed Winter search and visible Send/Cancel footer'
      )
    }
    if (only === 'invite') {
      await go(settings + '/invites', 'Create invite link')
      await tap(m, 'Create invite link')
      await contains(page, 'INVITE CODE')
      await cancelCheck(false)
      await shot('cancel-invite-link')
    }
    if (only == null || only === 'schedule') {
      await go(`/groups/team/${f.teamA}?tab=schedule`, 'Add Event')
      await show('Add Event')
      await shot('add-event')
      if (!before) {
        const style = await page.$eval(
          '[data-testid="add-event-card"]',
          node => ({
            background: getComputedStyle(node).backgroundColor,
            border: getComputedStyle(node).borderTopWidth,
            shadow: getComputedStyle(node).boxShadow,
            centered: getComputedStyle(node).alignItems
          })
        )
        assert.equal(style.background, 'rgb(21, 101, 192)')
        assert.equal(style.border, '0px')
        assert.notEqual(style.shadow, 'none')
        assert.equal(style.centered, 'center')
        await tap(m, 'Add Event')
        await contains(page, 'Choose Away Team')
        await note('E5 PASS: blue borderless shadow card opens event creation')
      }
    }
    if (only == null || only === 'forms') {
      await go(`/groups/team/${f.teamA}/create-game`, 'Choose Away Team')
      await show('Choose Away Team, Away')
      await m.tapOn({
        css: '[aria-label^="Choose Away Team,"]',
        timeout: 15000
      })
      await contains(page, 'Create Placeholder Team')
      await fill(m, 'Search all teams', 'Orchard')
      await contains(page, 'Orchard Owls')
      await pickerCheck()
      await shot('team-picker-create')
      if (before) await tap(m, 'Cancel team selector')
      else {
        await tap(m, 'Choose Orchard Owls')
        await page.waitForSelector('[aria-label="Orchard Owls, Away"]')
        await note(
          'E7 PASS: selecting the team immediately returns to the new-game draft'
        )
      }
      await go('/games/gam_settings3_scheduled/settings', 'Game Settings')
      await show('Winter Wolves, Home')
      await tap(m, 'Winter Wolves, Home')
      await contains(page, 'Create Placeholder Team')
      await pickerCheck()
      await shot('team-picker-edit')
      if (before) await tap(m, 'Cancel team selector')
      else {
        const selected = await page.$eval(
          `[data-testid="team-result-${f.teamA}"]`,
          node => node.getAttribute('aria-selected')
        )
        assert.equal(selected, 'true')
        await tap(m, 'Choose Winter Wolves')
        await page.waitForSelector('[aria-label="Winter Wolves, Home"]')
        await note(
          'E7 PASS: current team remains accessible-selected without a radio; choosing immediately returns to editing'
        )
      }
      await go(settings, 'TEAM DETAILS')
      await show('Remove Ichiro')
      await tap(m, 'Remove Ichiro')
      await contains(page, 'Remove Ichiro from Winter Wolves?')
      await cancelCheck(true)
      await shot('cancel-manage-player')
      await tap(m, 'Cancel')
      await go(
        `/players/104?onTeam=${f.teamA}&tab=settings`,
        'Remove from Winter Wolves'
      )
      await show('Remove from Winter Wolves')
      await tap(m, 'Remove from Winter Wolves')
      await contains(page, 'Remove Ichiro from Winter Wolves?')
      await cancelCheck(true)
      await shot('cancel-player-page')
      await tap(m, 'Cancel')
      await go('/node', 'Node administration')
      await fill(m, 'Find an account', 'fixture106')
      await contains(page, 'Tim Raines')
      await tap(m, 'Add Tim Raines')
      await page.waitForSelector('[aria-label="Revoke Tim Raines"]')
      await tap(m, 'Revoke Tim Raines')
      await contains(page, 'Revoke node access for Tim Raines?')
      await cancelCheck(true)
      await shot('cancel-revoke')
      await tap(m, 'Cancel')
      await go(settings, 'TEAM DETAILS')
      await tap(m, 'Add picture')
      await contains(page, 'Save photo')
      await cancelCheck(false)
      await shot('cancel-photo')
      await tap(m, 'Cancel')
      await go(settings + '/people', 'Add People')
      await show('Send invite')
      await cancelCheck(false)
      await shot('cancel-add-people')
      await go(settings + '/invites', 'Create invite link')
      await tap(m, 'Create invite link')
      await contains(page, 'INVITE CODE')
      await cancelCheck(false)
      await shot('cancel-invite-link')
    }
    if (only == null || only === 'preview') {
      for (const kind of ['team', 'season', 'league'] as const) {
        const noun = kind[0].toUpperCase() + kind.slice(1)
        const parent =
          kind === 'team' ? `?parentKind=season&parentId=${f.seasonA}` : ''
        await go(`/create/${kind}${parent}`, `Create ${noun}`)
        await fill(m, `${noun} name`, 'Winter Wolves')
        await tap(m, 'Continue')
        if (kind === 'season') {
          const label = await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>('[role="button"]')]
              .map(node => {
                const label = node.getAttribute('aria-label')
                return label == null
                  ? node.textContent == null
                    ? ''
                    : node.textContent
                  : label
              })
              .find(text => /^(Spring|Summer|Fall|Winter) 20/.test(text))
          )
          assert(label != null, 'season preset exists')
          await tap(m, label)
        } else {
          if (
            (await page.$('[aria-label="Location not set, Add a city"]')) !=
            null
          ) {
            await tap(m, 'Location not set, Add a city')
            await fill(m, 'City', 'tor')
            await m.tapOn({
              css: '[aria-label^="Choose Toronto,"]',
              timeout: 10000
            })
            await tap(m, 'Save')
          }
        }
        await tap(m, 'Continue')
        await tap(m, 'Use initials')
        await initialsCheck()
        await shot(`${kind}-wide-initials`)
        if (kind === 'team') await shot('team-initials-preview')
        if (kind === 'season') {
          await tap(m, 'Previous step')
          await tap(m, 'Previous step')
          await fill(m, 'Season name', 'W')
          await tap(m, 'Continue')
          await tap(m, 'Continue')
          await tap(m, 'Use initials')
          await initialsCheck()
          await shot('single-initial-preview')
        }
      }
    }
    await note(`${phase}: baseline/UI tour completed`)
  } finally {
    await stopRecording?.().catch(() => undefined)
    // A failed driver command must not leave the fixture or owned daemon alive.
    await Promise.allSettled([m.detach(), browser.disconnect()])
    await Promise.allSettled([daemon.shutdown(), f.h.close(), stub.close()])
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
