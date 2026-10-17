import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { after, before, describe, it } from 'mocha'

import { markerGeometry, readMarkerSource } from './readMarker'

/**
 * E5's browser half: real Chrome, through maestro-d's web platform, plays
 * each finished recording in the web app and reads the wall clock burned into
 * the frame on screen at every position it is asked for. `e5.mjs` runs it and
 * judges what it read against the recording's wall timeline.
 *
 *   E5_PLAN=<plan.json> E5_RESULTS=<results.json> TS_TOKEN=<session> \
 *   [E5_BROWSER=<Chromium-family binary>] \
 *   MAESTRO_D=<daemon> MAESTRO_D_CLIENT_ROOT=<maestro-d npm package> \
 *     npx mocha -r sucrase/register --extension ts --timeout 900000 \
 *     scripts/e2e/scoreboardLog/e5Browser.e2e.ts
 *
 * The plan is `{ app, api, videos: [{ gameId, videoId, positions }] }`, the
 * positions in seconds; the results are, per video, `{ videoId, reads: [{
 * position, mediaTime, currentTime, marker }] }`, `mediaTime` being the
 * presented frame's own time (`requestVideoFrameCallback`) and `marker` the
 * low 32 bits of its wall ms, or null where none could be read.
 */
interface Plan {
  app: string
  api: string
  videos: Array<{ gameId: string; videoId: string; positions: number[] }>
}
interface Read {
  position: number
  mediaTime: number
  currentTime: number
  marker: number | null
}

const planPath = process.env.E5_PLAN
const resultsPath = process.env.E5_RESULTS
const token = process.env.TS_TOKEN
/**
 * Chrome, or another Chromium-family browser's binary where Chrome is not
 * installed. Not the Chromium maestro-d downloads: it plays no H.264 and no
 * HEVC, so it never shows a picture of a recording.
 */
const browser = process.env.E5_BROWSER ?? 'chrome'
const requireClient =
  process.env.MAESTRO_D_CLIENT_ROOT == null
    ? createRequire(__filename)
    : createRequire(join(process.env.MAESTRO_D_CLIENT_ROOT, 'package.json'))
const { MaestroD } = requireClient('maestro-d')
let daemon: Awaited<ReturnType<typeof MaestroD.connect>>
type Page = Awaited<ReturnType<typeof daemon.attach>>

describe('E5: the marker on screen against the wall timeline', function () {
  let page: Page
  let plan: Plan
  const results: Array<{ videoId: string; reads: Read[] }> = []

  /** Runs `script` in the page and answers what it returned, as JSON. */
  async function probe<T>(script: string): Promise<T> {
    await page.evalBrowserScript({
      script: `return JSON.stringify(await (async () => { ${script} })())`,
      output: 'probe'
    })
    return JSON.parse((await page.vars()).probe) as T
  }

  before(async function () {
    const name = process.env.MAESTRO_D
    if (name == null || name === '') throw new Error('MAESTRO_D is required')
    if (planPath == null || resultsPath == null || token == null)
      throw new Error('E5_PLAN, E5_RESULTS and TS_TOKEN are required')
    plan = JSON.parse(readFileSync(planPath, 'utf8')) as Plan
    daemon = await MaestroD.connect({ name })
    page = await daemon.attach({
      device: `e5-${Date.now().toString(36)}`,
      platform: 'web',
      appId: plan.app,
      stepDelay: 0,
      artifacts: 'on-failure',
      extra: { browser, windowSize: '1280x720' }
    })
    await page.blockNetwork({
      patterns: ['*fonts.googleapis.com*', '*fonts.gstatic.com*']
    })
    await page.setCookies({
      cookies: [
        {
          name: 'ts_session',
          value: encodeURIComponent(token),
          domain: new URL(plan.api).hostname,
          path: '/'
        }
      ]
    })
  })

  after(async function () {
    if (resultsPath != null)
      writeFileSync(resultsPath, JSON.stringify(results, null, 2))
    await page?.detach()
    await daemon?.shutdown()
  })

  it('reads the marker at every position of every recording', async function () {
    for (const video of plan.videos) {
      await page.openBrowser({
        url: `${plan.app}/games/${video.gameId}?video=${video.videoId}`
      })
      // The recording has loaded far enough to show a picture.
      const deadline = Date.now() + 60_000
      for (;;) {
        const ready = await probe<boolean>(
          `const v = document.querySelector('video'); return v != null && v.readyState >= 2 && v.videoWidth > 0`
        )
        if (ready) break
        if (Date.now() > deadline)
          throw new Error(`${video.videoId} never showed a picture`)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      const reads: Read[] = []
      for (const position of video.positions) {
        const read = await probe<Omit<Read, 'position'>>(`
          const readMarker = ${readMarkerSource()}
          const v = document.querySelector('video')
          v.pause()
          await new Promise(resolve => {
            v.addEventListener('seeked', resolve, { once: true })
            v.currentTime = ${position}
          })
          // The frame now on screen, and its own time: the one a seek
          // lands on is the last that presents at or before it.
          const mediaTime = await new Promise(resolve => {
            const late = setTimeout(() => resolve(null), 3000)
            v.requestVideoFrameCallback((now, frame) => {
              clearTimeout(late)
              resolve(frame.mediaTime)
            })
          })
          // A frame of slack for the compositor to have it, then read it.
          await new Promise(resolve => setTimeout(resolve, 100))
          return {
            mediaTime: mediaTime ?? v.currentTime,
            currentTime: v.currentTime,
            marker: readMarker(v, ${JSON.stringify(markerGeometry(720))})
          }
        `)
        reads.push({ position, ...read })
      }
      results.push({ videoId: video.videoId, reads })
    }
  })
})
