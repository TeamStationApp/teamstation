import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { hlsFixture } from '../../../core/video'
import { pause } from '../../../rigs/media/liveCamera'
import { stackControl } from '../../../rigs/media/stackSpace'

/**
 * The web player's own code (`attachHls`, `explicitSeek`) on real HLS in
 * this machine's Chrome, through maestro-d: the live cushion, rewind and
 * pause (`cushion-rewind-and-pause`), and one diagnostic for real starvation
 * with no report on a deliberate pause (`one-stall-report`). No account or
 * live game: the player is bundled into a page of its own and, with an event
 * playlist that has no end yet, served from the stack's pages stand-in, which
 * the browser reaches over HTTPS like any page. The fixture is encoded here
 * by the video layer; the page acts on the player through maestro-d's
 * `evalBrowserScript`, as a person's controls would, and throws when what it
 * reads is wrong.
 */

const ROOT = resolve(__dirname, '../../../..')
const KEYFRAME_EVERY_FRAMES = 20

/** The player bundled with `entry`, as the browser loads it. */
async function bundle(entry: string): Promise<string> {
  const { build } = await import('esbuild')
  const built = await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'browser'
  })
  return built.outputFiles[0].text
}

/** Serves the page, its player and a fixture on the pages stand-in; answers the page's URL. */
async function servePage(
  ctx: HarnessContext,
  name: string,
  seconds: number,
  entry: string
): Promise<string> {
  const control = stackControl(ctx)
  const pagesOrigin = ctx.stack.pagesOrigin
  if (pagesOrigin == null) {
    throw new BlockedError('this stack has no pages stand-in')
  }
  const dir = join(ctx.runDir, `${name}-fixture`)
  const files = hlsFixture(dir, {
    seconds,
    size: '320x180',
    fps: 10,
    gop: KEYFRAME_EVERY_FRAMES,
    segmentSeconds: 4
  })
  const base = `/${name}-${randomUUID()}`
  const headers = { 'Cache-Control': 'no-store' }
  const pages: Record<string, unknown> = {
    [`${base}/index.html`]: {
      type: 'text/html',
      headers,
      body: `<!doctype html><title>${name}</title><video muted autoplay controls></video><script src="player.js"></script>`
    },
    [`${base}/player.js`]: {
      type: 'application/javascript',
      headers,
      body: await bundle(entry)
    }
  }
  for (const file of files) {
    pages[`${base}/${file}`] = file.endsWith('.m3u8')
      ? {
          type: 'application/vnd.apple.mpegurl',
          headers,
          body: readFileSync(join(dir, file), 'utf8')
        }
      : {
          type: 'video/mp2t',
          headers,
          encoding: 'base64',
          body: readFileSync(join(dir, file)).toString('base64')
        }
  }
  await control.pages.script(pages)
  return `${pagesOrigin.replace(/\/+$/, '')}${base}/index.html`
}

async function openPage(ctx: HarnessContext, url: string): Promise<any> {
  // The fixture is H.264, which maestro-d's own Chromium does not play.
  const { m } = await ctx.browser({ width: 1280, height: 720 }, { h264: true })
  await m.openLink({ link: url })
  return m
}

interface Read {
  paused: boolean
  ended: boolean
  currentTime: number
  /** Where the page noted the player, `window.mark`, the step before. */
  mark: number | null
  reports: number
  report: {
    message?: string
    engine?: string
    stalledSeconds?: number
    bufferedAheadSeconds?: number
  } | null
}

/**
 * One step on the page through maestro-d: reads the player first, then
 * does `act` as a viewer's controls would, and answers what it read.
 */
async function step(m: any, act: string): Promise<Read> {
  await m.evalBrowserScript({
    script: `
      const v = document.querySelector('video');
      const event = (window.reports ?? [])[0];
      const read = {
        paused: v.paused, ended: v.ended, currentTime: v.currentTime,
        mark: window.mark ?? null, reports: (window.reports ?? []).length,
        report: event == null ? null : {
          message: event.exception?.values?.[0]?.value,
          engine: event.tags?.playbackEngine,
          stalledSeconds: event.extra?.playback?.stalledSeconds,
          bufferedAheadSeconds: event.extra?.playback?.bufferedAheadSeconds
        }
      };
      ${act}
      return JSON.stringify(read);
    `,
    output: 'read'
  })
  return JSON.parse((await m.vars()).read) as Read
}

async function cushionRewindAndPause(ctx: HarnessContext): Promise<void> {
  const url = await servePage(
    ctx,
    'live-buffer',
    120,
    `import { attachHls } from './src/app/player/attachHls';
      import { seekTo } from './src/app/player/explicitSeek';
      const video = document.querySelector('video');
      window.seekTo = seconds => seekTo(video, seconds);
      window.attachPlayer = () => attachHls(video, 'master.m3u8', undefined,
        {isLive: () => true, wantsToPlay: () => !video.paused});
      window.detachPlayer = window.attachPlayer();
      video.play().catch(() => {});`
  )
  const m = await openPage(ctx, url)
  await pause(5000)
  const live = await step(m, 'v.currentTime = 10;')
  expect(live.paused, 'live playback started').equals(false)
  expect(
    live.currentTime,
    'live playback starts 45 s behind the newest footage'
  ).within(70, 90)
  await pause(3000)
  const rewound = await step(m, 'v.pause(); window.mark = v.currentTime;')
  expect(rewound.paused, 'rewind keeps playing').equals(false)
  expect(rewound.currentTime, 'at the selected moment').within(11, 20)
  await pause(12_000)
  const paused = await step(
    m,
    `window.detachPlayer();
      v.autoplay = false;
      window.detachPlayer = window.attachPlayer();`
  )
  expect(paused.paused, 'the viewer stays paused').equals(true)
  expect(
    Math.abs(paused.currentTime - paused.mark!),
    'stall recovery never moves a paused viewer'
  ).at.most(0.01)
  await pause(3000)
  const second = await step(m, 'window.seekTo(10); await v.play();')
  expect(second.paused, 'the second viewer awaits Play').equals(true)
  await pause(3000)
  const highlight = await step(m, 'window.detachPlayer();')
  expect(highlight.paused, 'the highlight plays').equals(false)
  expect(
    highlight.currentTime,
    'a highlight chosen before the first Play is kept'
  ).within(11, 20)
}

async function oneStallReport(ctx: HarnessContext): Promise<void> {
  const url = await servePage(
    ctx,
    'live-diagnostics',
    12,
    `import { attachHls } from './src/app/player/attachHls';
      import { init } from '@sentry/react';
      window.reports = [];
      init({ dsn: 'https://public@example.test/1', beforeSend: event => {
        window.reports.push(event); return null;
      }});
      const video = document.querySelector('video');
      window.detachPlayer = attachHls(video, 'master.m3u8', undefined,
        {isLive: () => true, wantsToPlay: () => !video.paused,
         startAtLiveEdge: false});
      video.play().catch(() => {});`
  )
  const m = await openPage(ctx, url)
  await pause(4000)
  const playing = await step(m, 'v.pause(); window.mark = v.currentTime;')
  expect(playing.paused, 'the fixture plays').equals(false)
  expect(playing.currentTime, 'the fixture plays').at.least(1)
  await pause(17_000)
  const held = await step(m, 'await v.play();')
  expect(held.reports, 'a deliberate pause is never reported').equals(0)
  expect(
    Math.abs(held.currentTime - held.mark!),
    'the paused video is not moved'
  ).at.most(0.01)
  await pause(28_000)
  const starved = await step(m, 'window.mark = v.currentTime;')
  expect(starved.paused || starved.ended, 'still playing').equals(false)
  expect(starved.currentTime, 'the live footage ran out').at.least(10)
  expect(starved.reports, 'one stall report').equals(1)
  expect(starved.report?.message).equals(
    'Live video playback stopped advancing'
  )
  expect(starved.report?.engine).equals('hls.js')
  expect(starved.report?.stalledSeconds, 'stalled seconds').at.least(15)
  expect(
    starved.report?.bufferedAheadSeconds,
    'nothing buffered ahead'
  ).at.most(0.2)
  await pause(5000)
  const after = await step(m, 'window.detachPlayer();')
  expect(after.reports, 'the report is not repeated').equals(1)
  expect(
    Math.abs(after.currentTime - after.mark!),
    'the diagnostic never moves the viewer'
  ).at.most(0.1)
}

export default defineHarness({
  id: 'playback/live-buffer/player-on-live-hls',
  title:
    'The web player keeps its live cushion, rewinds and pauses, and reports real starvation once',
  kind: 'e2e',
  covers: [
    'src/app/player/attachHls.ts',
    'src/app/player/explicitSeek.ts',
    'src/app/player/liveStallDiagnostics.ts'
  ],
  stack: 'isolated',
  fixtures: [],
  exclusive: false,
  surfaces: {
    'web-chromium': {
      devices: [],
      // The page plays H.264 HLS in Chrome.
      browser: { role: 'browser', needs: ['video'], codecs: ['h264'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 3,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'cushion-rewind-and-pause': cushionRewindAndPause,
    'one-stall-report': oneStallReport
  }
})
