import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'

import { expect } from 'chai'

import type { RecapDocument } from '../../common/gameRecap'
import { asPostEventsBody } from '../../common/gumboPlay'
import { postGamePlays } from '../../server/events/postPlays'
import { runRecap } from '../../server/recap/worker'
import { mediaRoutes } from '../../server/routes/media'
import { recapRoutes } from '../../server/routes/recap'
import { groupFixture } from '../../test/groupFixtures'
import {
  browserSession,
  capture,
  maestro
} from '../../test/refinementsMaestro.e2e'
import { databaseUrlOf } from '../../test/screenScopeNotices'

async function main(): Promise<void> {
  const out = process.env.TS_ARTIFACTS_DIR
  if (out == null) throw new Error('Supply TS_ARTIFACTS_DIR')
  const mediaDir = join(out, 'support', 'recap-media')
  mkdirSync(mediaDir, { recursive: true })
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=24',
    '-t',
    '70',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '48',
    '-hls_segment_type',
    'fmp4',
    '-hls_segment_filename',
    join(mediaDir, 'seg%06d.m4s'),
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    join(mediaDir, 'index.m3u8')
  ])
  writeFileSync(
    join(mediaDir, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360\nindex.m3u8\n'
  )
  const f = await groupFixture(
    resolve('dist'),
    undefined,
    (app, { db, media }) => {
      app.get('/account-test/{*key}', (req, res) => {
        const data = f.h.objects.get(req.path)
        if (data == null) res.sendStatus(404)
        else res.end(data)
      })
      app.use('/api/v1', recapRoutes(db))
      app.use('/api/v1', mediaRoutes(db, media))
    }
  )
  // Keep the fake object store same-origin under the app's real CSP.
  f.h.space.endpoint = f.h.origin
  const { attachGameSocket } = createRequire(resolve('package.json'))(
    './src/server/socket/gameSocket'
  ) as {
    attachGameSocket: (
      server: Server,
      db: typeof f.h.db,
      url: string,
      options: { stopSignals: null }
    ) => { close: () => Promise<void> }
  }
  const socket = attachGameSocket(
    f.h.server,
    f.h.db,
    await databaseUrlOf(f.h.db),
    { stopSignals: null }
  )
  const d = await maestro('game-recap')
  const s = await browserSession(
    d,
    'game-recap-web',
    390,
    844,
    out,
    process.env.TS_RECAP_BROWSER ?? 'chrome'
  )
  try {
    const id = 'gam_recap_proof'
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date('2026-01-01T18:00:00Z'),
        status: 'scheduled'
      })
      .execute()
    await postGamePlays(
      f.h.db,
      id,
      asPostEventsBody({
        mode: 'live',
        source: { system: 'teamstation' },
        plays: [
          {
            about: { atBatIndex: 0, endTime: '2026-01-01T18:00:20Z' },
            result: { eventType: 'single', homeScore: 1, awayScore: 0 }
          },
          {
            about: {
              atBatIndex: 1,
              endTime: '2026-01-01T18:00:50Z',
              isScoringPlay: true
            },
            result: { eventType: 'home_run', homeScore: 4, awayScore: 2 }
          },
          {
            about: { atBatIndex: 2 },
            result: { eventType: 'final_score', homeScore: 4, awayScore: 2 }
          }
        ]
      })
    )
    const doc: RecapDocument = {
      headline: 'Demo Hawks defeat Demo Eagles 4–2',
      dateLine: 'January 1, 2026',
      paragraphs: [
        [{ text: 'A single opened the scoring.', kind: 'play', plays: [0] }],
        [{ text: 'A home run extended the lead.', kind: 'play', plays: [1] }],
        [
          {
            text: 'The two plays shaped the game.',
            kind: 'summary',
            plays: [0, 1]
          },
          {
            text: 'The teams combined for six runs.',
            kind: 'totals',
            plays: []
          }
        ],
        ...Array.from({ length: 12 }, () => [
          {
            text: 'Demo Hawks finished with four runs and Demo Eagles finished with two.',
            kind: 'totals' as const,
            plays: []
          }
        ])
      ]
    }
    await f.h.db
      .insertInto('videos')
      .values({
        id: 'vid_recap',
        game_id: id,
        kind: 'live',
        title: 'Synthetic recap recording',
        storage: 'local',
        status: 'ready',
        start_at: new Date('2026-01-01T18:00:00Z'),
        duration_sec: 70
      })
      .execute()
    for (const name of readdirSync(mediaDir))
      f.h.objects.set(
        `/${f.h.space.bucket}/videos/vid_recap/${name}`,
        readFileSync(join(mediaDir, name))
      )
    await s.browser.setCookie({
      name: 'ts_session',
      value: f.h.tokens.get(101)!,
      domain: new URL(f.h.origin).hostname,
      path: '/'
    })
    const visit = async (query = ''): Promise<void> => {
      await s.m.openBrowser({ url: `${f.h.origin}/games/${id}${query}` })
      await s.page.waitForSelector('[data-testid="recapArticle"]')
    }
    // An older final game has no persisted recap until its first member visit.
    await f.h.db.deleteFrom('game_recaps').where('game_id', '=', id).execute()
    await visit()
    await s.page.waitForFunction(() =>
      document.body.textContent!.includes('waiting for recap')
    )
    writeFileSync(join(out, 'recap-pending.png'), await s.m.screenshot())
    let recapReads = 0
    s.page.on('request', request => {
      if (request.url().endsWith(`/games/${id}/recap`)) recapReads++
    })
    await new Promise(resolve => setTimeout(resolve, 4500))
    expect(recapReads).equals(0)
    await runRecap(f.h.db, async () => doc, new AbortController().signal)
    await s.page.waitForFunction(() =>
      document.body.textContent!.includes('Demo Hawks defeat')
    )
    expect(
      await s.page.$eval(
        '[role="tab"][aria-selected="true"]',
        el => el.textContent
      )
    ).equals('Recap')
    expect(
      await s.page.$$eval(
        '[data-testid="recapArticle"] [role="link"]',
        els => els.length
      )
    ).equals(2)
    await capture(s.m, out, 'recap-after.png')
    const recording = await s.page.screencast({
      path: join(out, 'recap-playback.webm') as `${string}.webm`
    })
    const publication = s.page.waitForResponse(response =>
      response.url().endsWith('/videos/vid_recap/playback')
    )
    await s.m.tapOn({
      css: '[role="link"][aria-label="A single opened the scoring."]'
    })
    expect((await (await publication).json()).pending).equals(true)
    expect(await s.page.evaluate(() => document.body.textContent)).not.contains(
      'not available'
    )
    await f.h.db
      .updateTable('videos')
      .set({ storage: 'spaces' })
      .where('id', '=', 'vid_recap')
      .execute()
    await s.page.waitForFunction(() => {
      const v = document.querySelector('video')
      return v != null && !v.paused && v.currentTime > 0
    })
    const clips = await fetch(`${f.h.origin}/api/v1/games/${id}/recap`, {
      headers: { cookie: `ts_session=${f.h.tokens.get(101)!}` }
    }).then(async r => await r.json())
    const first = clips.clips['0']
    const initial = await s.page.$eval('video', v => v.currentTime)
    expect(initial).within(first.start, first.start + 3)
    // Scroll through the actual UI; the article moves while the player remains below the pills.
    await s.m.scroll({ direction: 'down' })
    await new Promise(resolve => setTimeout(resolve, 300))
    const articleTop = await s.page.$eval(
      '[data-testid="recapArticle"]',
      el => el.getBoundingClientRect().top
    )
    const rect = await s.page.$eval('[data-testid="recapPlayer"]', el => ({
      top: el.getBoundingClientRect().top,
      bottom: el.getBoundingClientRect().bottom
    }))
    await s.m.scroll({ direction: 'down' })
    await new Promise(resolve => setTimeout(resolve, 300))
    const next = await s.page.$eval('[data-testid="recapPlayer"]', el => ({
      top: el.getBoundingClientRect().top,
      bottom: el.getBoundingClientRect().bottom
    }))
    const articleNext = await s.page.$eval(
      '[data-testid="recapArticle"]',
      el => el.getBoundingClientRect().top
    )
    expect(articleNext).lessThan(articleTop - 100)
    expect(next.top).closeTo(rect.top, 2)
    expect(next.top).greaterThan(0)
    await s.page.waitForFunction(
      (end: number) => {
        const v = document.querySelector('video')
        return v != null && v.paused && Math.abs(v.currentTime - end) < 0.5
      },
      { timeout: 60000 },
      first.end
    )
    await visit('?tab=recap')
    await s.page.waitForFunction(() =>
      document.body.textContent!.includes('A home run extended')
    )
    await s.m.tapOn({
      css: '[role="link"][aria-label="A single opened the scoring."]'
    })
    await s.page.waitForFunction(
      () =>
        document.querySelector('video') != null &&
        !document.querySelector('video')!.paused
    )
    await s.m.tapOn({
      css: '[role="link"][aria-label="A home run extended the lead."]'
    })
    const second = clips.clips['1']
    await s.page.waitForFunction(
      (start: number) => {
        const v = document.querySelector('video')
        return (
          v != null &&
          !v.paused &&
          v.currentTime >= start &&
          v.currentTime < start + 4
        )
      },
      {},
      second.start
    )
    expect(await s.page.$$eval('video', els => els.length)).equals(1)
    await s.page.waitForFunction(
      (end: number) => {
        const v = document.querySelector('video')
        return v != null && v.paused && Math.abs(v.currentTime - end) < 0.5
      },
      { timeout: 60000 },
      second.end
    )
    const repeatedSeeks = await s.page.evaluate(async () => {
      const video = document.querySelector('video')!
      let seeks = 0
      const count = (): void => {
        seeks++
      }
      video.addEventListener('seeking', count)
      await new Promise(resolve => setTimeout(resolve, 400))
      video.removeEventListener('seeking', count)
      return seeks
    })
    expect(repeatedSeeks).at.most(1)
    await recording.stop()
    await s.page.setViewport({ width: 844, height: 390 })
    await visit('?tab=recap')
    await s.m.scrollUntilVisible({
      element: {
        css: '[role="link"][aria-label="A single opened the scoring."]'
      },
      direction: 'DOWN',
      maxScrolls: 8
    })
    await s.m.tapOn({
      css: '[role="link"][aria-label="A single opened the scoring."]'
    })
    await s.page.waitForFunction(
      () =>
        document.querySelector('video') != null &&
        !document.querySelector('video')!.paused
    )
    await s.m.scrollUntilVisible({
      element: {
        css: '[role="link"][aria-label="A home run extended the lead."]'
      },
      direction: 'DOWN',
      maxScrolls: 8
    })
    const landscape = await s.page.evaluate(() => {
      const player = document
        .querySelector('[data-testid="recapPlayer"]')!
        .getBoundingClientRect()
      const band = document
        .querySelector('[data-testid="recapPinnedBand"]')!
        .getBoundingClientRect()
      return { height: player.height, remaining: innerHeight - band.bottom }
    })
    expect(landscape.height).at.most(390 * 0.35 + 1)
    expect(landscape.remaining).at.least(100)
    await s.m.tapOn({
      css: '[role="link"][aria-label="A home run extended the lead."]'
    })
    await s.page.waitForFunction(
      (start: number) => {
        const video = document.querySelector('video')
        return (
          video != null &&
          !video.paused &&
          video.currentTime >= start &&
          video.currentTime < start + 4
        )
      },
      {},
      second.start
    )
    await s.m.scroll({ direction: 'down' })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(
      await s.page.evaluate(() => {
        const band = document
          .querySelector('[data-testid="recapPinnedBand"]')!
          .getBoundingClientRect()
        const hit = document.elementFromPoint(innerWidth / 2, band.bottom + 40)
        if (hit == null) return false
        return hit.closest('[data-testid="recapArticle"]') != null
      })
    ).equals(true)
    await capture(s.m, out, 'recap-landscape.png')
    await s.page.setViewport({ width: 390, height: 844 })

    await f.h.db
      .updateTable('videos')
      .set({ hidden: true })
      .where('id', '=', 'vid_recap')
      .execute()
    await visit()
    await s.page.waitForFunction(() =>
      document.body.textContent!.includes('A single opened')
    )
    expect(
      await s.page.$$eval(
        '[data-testid="recapArticle"] [role="link"]',
        els => els.length
      )
    ).equals(0)
    await f.h.db
      .updateTable('game_recaps')
      .set({ status: 'failed', document: null })
      .where('game_id', '=', id)
      .execute()
    await visit()
    await s.page.waitForFunction(() =>
      document.body.textContent!.includes('could not be written')
    )
    await capture(s.m, out, 'recap-failed.png')
    await s.browser.setCookie({
      name: 'ts_session',
      value: f.h.tokens.get(103)!,
      domain: new URL(f.h.origin).hostname,
      path: '/'
    })
    const protectedRequests: string[] = []
    s.page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (path.endsWith('/recap') || path.endsWith('/playback'))
        protectedRequests.push(path)
    })
    await visit()
    await s.page.waitForFunction(() =>
      document.body.textContent!.includes('Request membership')
    )
    expect(await s.page.$('[data-testid="recapArticle"] [role="link"]')).equals(
      null
    )
    expect(protectedRequests).deep.equals([])
    await capture(s.m, out, 'recap-membership.png')
    for (const cookie of await s.browser.cookies())
      await s.browser.deleteCookie(cookie)
    await visit()
    await s.page.waitForFunction(() =>
      document.body.textContent!.includes('Sign in')
    )
    expect(
      await s.page.$$eval(
        '[data-testid="recapArticle"] [role="link"]',
        els => els.length
      )
    ).equals(0)
    expect(protectedRequests).deep.equals([])
    for (const status of ['inProgress', 'cancelled'] as const) {
      await f.h.db
        .updateTable('games')
        .set({ status })
        .where('id', '=', id)
        .execute()
      await s.m.openBrowser({ url: `${f.h.origin}/games/${id}?tab=recap` })
      await s.page.waitForSelector('[role="tab"]')
      expect(
        await s.page.$$eval('[role="tab"]', els =>
          els.some(el => el.textContent === 'Recap')
        )
      ).equals(false)
    }
    const req = createRequire(join(process.cwd(), 'package.json'))
    const convert = req('v8-to-istanbul')
    const map = req('istanbul-lib-coverage').createCoverageMap({})
    for (const script of await s.page.coverage.stopJSCoverage()) {
      if (
        !script.url.startsWith(f.h.origin + '/app-') ||
        script.rawScriptCoverage == null
      )
        continue
      const generated = resolve('dist', basename(new URL(script.url).pathname))
      const converter = convert(generated, 0, {
        source: script.text,
        sourceMap: {
          sourcemap: JSON.parse(readFileSync(generated + '.map', 'utf8'))
        }
      })
      await converter.load()
      converter.applyCoverage(script.rawScriptCoverage.functions)
      map.merge(converter.toIstanbul())
    }
    writeFileSync(
      join(out, 'support', 'recap-browser-coverage.json'),
      JSON.stringify(map.toJSON())
    )
    console.log(
      'Recap default, loading, access, pinned playback, clip switching and exact stopping verified'
    )
  } catch (error) {
    console.log(
      'Video state:',
      await s.page.$$eval('video', els =>
        els.map(v => ({
          time: v.currentTime,
          paused: v.paused,
          ready: v.readyState,
          src: v.currentSrc,
          error: v.error == null ? null : v.error.message
        }))
      )
    )
    console.log(
      'Failure page:',
      await s.page.evaluate(() => document.body.textContent)
    )
    await capture(s.m, out, 'support/recap-debug.png')
    throw error
  } finally {
    await s.browser.disconnect()
    await s.m.detach()
    await d.shutdown()
    await socket.close()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
