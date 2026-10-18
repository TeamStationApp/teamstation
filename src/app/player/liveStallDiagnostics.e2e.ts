import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { buildSync } from 'esbuild'

/**
 * Real HLS starvation through maestro-d: one diagnostic, no report on pause.
 * Run with MAESTRO_D_CLIENT_ROOT pointing to the maestro-d npm package and
 * MAESTRO_D_BIN to its binary. LIVE_TEST_BROWSER optionally selects Chrome.
 * The fixture is generated locally; no account or live game is needed.
 */
interface Browser {
  evalBrowserScript: (options: { script: string }) => Promise<unknown>
  detach: () => Promise<unknown>
}
interface Daemon {
  attach: (options: Record<string, unknown>) => Promise<Browser>
  shutdown: () => Promise<unknown>
}

async function main(): Promise<void> {
  const client = process.env.MAESTRO_D_CLIENT_ROOT
  if (client == null) throw new Error('Set MAESTRO_D_CLIENT_ROOT')
  const { MaestroD } = require(client) as {
    MaestroD: { connect: (options: Record<string, unknown>) => Promise<Daemon> }
  }
  const dir = mkdtempSync(join(tmpdir(), 'live-diagnostics-'))
  let daemon: Daemon | undefined
  let browser: Browser | undefined
  const server = createServer((request, response) => {
    const file = basename(
      request.url === '/' ? 'index.html' : (request.url ?? '')
    )
    try {
      const bytes = readFileSync(join(dir, file))
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader(
        'Content-Type',
        file.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : file.endsWith('.js')
            ? 'application/javascript'
            : file.endsWith('.html')
              ? 'text/html'
              : 'video/mp2t'
      )
      response.end(bytes)
    } catch {
      response.writeHead(404).end()
    }
  })
  try {
    execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=10',
      '-t',
      '12',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '20',
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_list_size',
      '0',
      '-hls_playlist_type',
      'event',
      '-hls_flags',
      'omit_endlist',
      join(dir, 'master.m3u8')
    ])
    buildSync({
      stdin: {
        contents: `import { attachHls } from './src/app/player/attachHls';
          import { init } from '@sentry/react';
          window.reports = [];
          init({ dsn: 'https://public@example.test/1', beforeSend: event => {
            window.reports.push(event); return null;
          }});
          const video = document.querySelector('video');
          window.detachPlayer = attachHls(video, '/master.m3u8', undefined,
            {isLive: () => true, wantsToPlay: () => !video.paused,
             startAtLiveEdge: false});
          video.play().catch(() => {});`,
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      bundle: true,
      outfile: join(dir, 'player.js'),
      platform: 'browser'
    })
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><title>Live stall diagnostic test</title><video muted autoplay controls></video><script src="/player.js"></script>'
    )
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address == null || typeof address === 'string')
      throw new Error('No port')
    daemon = await MaestroD.connect({ name: `live-diagnostics-${process.pid}` })
    browser = await daemon.attach({
      device: `live-diagnostics-web-${process.pid}`,
      platform: 'web',
      appId: `http://127.0.0.1:${address.port}`,
      artifacts: 'on-failure',
      extra: { browser: process.env.LIVE_TEST_BROWSER ?? 'chrome' }
    })
    await new Promise(resolve => setTimeout(resolve, 4000))
    await browser.evalBrowserScript({
      script: `
      const v = document.querySelector('video');
      if (v.paused || v.currentTime < 1) throw new Error('Fixture did not play');
      v.pause(); window.pausedAt = v.currentTime;
    `
    })
    await new Promise(resolve => setTimeout(resolve, 17000))
    await browser.evalBrowserScript({
      script: `
      const v = document.querySelector('video');
      if (window.reports.length !== 0) throw new Error('Reported a deliberate pause');
      if (Math.abs(v.currentTime - window.pausedAt) > 0.01) throw new Error('Moved paused video');
      await v.play();
    `
    })
    await new Promise(resolve => setTimeout(resolve, 28000))
    await browser.evalBrowserScript({
      script: `
      const v = document.querySelector('video');
      if (v.paused || v.ended || v.currentTime < 10) throw new Error('Fixture did not exhaust live footage');
      if (window.reports.length !== 1) throw new Error('Expected one stall report, got ' + window.reports.length);
      const event = window.reports[0];
      if (event.exception.values[0].value !== 'Live video playback stopped advancing')
        throw new Error('Unexpected error report');
      if (event.tags.playbackEngine !== 'hls.js') throw new Error('Wrong engine');
      if (event.extra.playback.stalledSeconds < 15 || event.extra.playback.bufferedAheadSeconds > 0.2)
        throw new Error('Report did not describe exhausted video');
      window.stalledAt = v.currentTime;
    `
    })
    await new Promise(resolve => setTimeout(resolve, 5000))
    await browser.evalBrowserScript({
      script: `
      const v = document.querySelector('video');
      if (window.reports.length !== 1) throw new Error('Repeated the report');
      if (Math.abs(v.currentTime - window.stalledAt) > 0.1) throw new Error('Diagnostic moved the viewer');
      window.detachPlayer();
    `
    })
    console.log(
      'PASS: real HLS starvation reported once, deliberate pause ignored, playback unchanged'
    )
  } finally {
    await browser?.detach()
    await daemon?.shutdown()
    server.closeAllConnections()
    await new Promise<void>(resolve =>
      server.close(() => {
        resolve()
      })
    )
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
