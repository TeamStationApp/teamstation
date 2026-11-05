import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { build } from 'esbuild'
import puppeteer from 'puppeteer'

import { tvFixture } from '../../appletv/e2e/fixture'
import { webSettings } from '../web-build-settings.mjs'

/** The production grid with synthetic gaps or a bounded synchronization run. */
export async function webReliability(testCase: string): Promise<void> {
  assert(['gaps', 'sync'].includes(testCase))
  const sync = testCase === 'sync'
  const seconds = Number(process.env.TS_SYNC_SECONDS ?? 1800)
  assert(Number.isFinite(seconds) && seconds >= 60 && seconds <= 1800)
  const output = process.env.TS_E2E_ARTIFACT_DIR
  const clientRoot = process.env.MAESTRO_D_CLIENT_ROOT
  assert(output != null && clientRoot != null)
  const before = process.env.TS_EXPECT_BASE_FAILURE === '1'
  const sourceRoot = resolve(process.env.TS_E2E_SOURCE_ROOT ?? '.')
  const dir = await mkdtemp(join(tmpdir(), 'streaming-grid-'))
  const fixture = await tvFixture({ gap: !sync, webRoot: dir })
  const { MaestroD } = require(clientRoot)
  let daemon: any
  let browser: any
  let cdp: Awaited<ReturnType<typeof puppeteer.connect>> | undefined
  let recorder:
    Awaited<ReturnType<import('puppeteer').Page['screencast']>> | undefined
  try {
    await mkdir(output, { recursive: true })
    if (sync)
      await fixture.db
        .updateTable('videos')
        .set({ duration_sec: seconds + 100 })
        .execute()
    const entry = `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {TeamStationClient} from './src/common/api';
      import {ThemeProvider} from './src/app/theme/ThemeContext';
      import {MultiCamView} from './src/app/player/MultiCamView';
      const client = new TeamStationClient({baseUrl: '/api/v1', token: ${JSON.stringify(fixture.tokens.get(101))}});
      const game = await client.game('gam_tv_0');
      const start = Date.parse(game.videos[0].startAt);
      const at = Number(new URLSearchParams(location.search).get('at') ?? ${sync ? 5 : 50});
      createRoot(document.getElementById('root')).render(<ThemeProvider>
        <MultiCamView client={client} videos={game.videos.slice(0,2)} order={game.videos.slice(0,2).map(v=>v.id)}
          audioId={null} zoomedId={null} atMs={start+at*1000} endAtMs={${sync ? 'undefined' : 'start+(at+0.2)*1000'}}
          onChange={()=>{}} onClose={()=>{}} />
      </ThemeProvider>);`
    await build({
      ...webSettings,
      absWorkingDir: sourceRoot,
      stdin: { contents: entry, resolveDir: sourceRoot, loader: 'tsx' },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      define: {
        'process.env': '{}',
        'process.env.NODE_ENV': '"development"',
        global: 'globalThis',
        __DEV__: 'true'
      },
      loader: {
        '.png': 'dataurl',
        '.jpg': 'dataurl',
        '.svg': 'dataurl',
        '.ttf': 'dataurl'
      },
      outfile: join(dir, 'player.js')
    })
    await writeFile(
      join(dir, 'index.html'),
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{width:100%;height:100%;margin:0;background:black}</style><div id="root"></div><script>window.fixtureErrors=[];addEventListener("error",e=>fixtureErrors.push(e.message));addEventListener("unhandledrejection",e=>fixtureErrors.push(String(e.reason)));</script><script type="module" src="/player.js"></script>'
    )
    daemon = await MaestroD.connect({ name: `streaming-grid-${process.pid}` })
    browser = await daemon.attach({
      platform: 'web',
      device: `streaming-grid-${process.pid}`,
      appId: fixture.origin + `/?at=${sync ? 5 : 50}`,
      artifacts: 'on-failure',
      extra: {
        browser: process.env.LIVE_TEST_BROWSER ?? 'chrome',
        windowSize: '1280x800',
        ...(sync ? { userDataDir: join(dir, 'profile') } : {})
      }
    })
    if (sync) {
      const [port, path] = (
        await readFile(join(dir, 'profile', 'DevToolsActivePort'), 'utf8')
      )
        .trim()
        .split('\n')
      cdp = await puppeteer.connect({
        browserWSEndpoint: `ws://127.0.0.1:${port}${path}`,
        defaultViewport: null
      })
      const page = (await cdp.pages()).find(page =>
        page.url().startsWith(fixture.origin)
      )!
      assert(page != null, 'Synthetic grid page')
      await page.waitForFunction(
        () => {
          const videos = [...document.querySelectorAll('video')]
          return (
            videos.length === 2 &&
            videos.every(video => video.readyState >= 2 && !video.paused)
          )
        },
        { timeout: 60000 }
      )
      assert(
        await page.evaluate(
          minimum =>
            [...document.querySelectorAll('video')].every(
              video => video.duration >= minimum
            ),
          seconds + 10
        ),
        'TV_PROBE_FILE must contain enough media for the synchronization run'
      )
      recorder = await page.screencast({
        path: join(output, 'web-sync.webm'),
        ffmpegPath: process.env.FFMPEG_PATH
      })
      const started = Date.now()
      const samples: Array<{ elapsed: number; positions: number[] }> = []
      for (let elapsed = 0; elapsed <= seconds; elapsed += 60) {
        await new Promise(resolve =>
          setTimeout(
            resolve,
            Math.max(0, started + elapsed * 1000 - Date.now())
          )
        )
        const positions = await page.evaluate(() =>
          [...document.querySelectorAll('video')].map(
            video => video.currentTime
          )
        )
        await writeFile(
          join(output, `sync-${elapsed}.png`),
          await browser.screenshot()
        )
        samples.push({ elapsed: (Date.now() - started) / 1000, positions })
        await writeFile(
          join(output, 'sync-samples.json'),
          JSON.stringify(samples, null, 2)
        )
        assert.equal(positions.length, 2)
        assert(Math.abs(positions[0] - positions[1]) <= 0.5, 'Cameras diverged')
        const previous = samples.at(-2)
        if (previous != null)
          assert(
            positions.every(
              (position, index) => position > previous.positions[index] + 1
            ),
            'A camera stopped advancing'
          )
      }
      console.log(
        'Position checks passed; review burned-in clocks in web-sync.webm before claiming visual synchronization'
      )
      return
    }
    await new Promise(resolve => setTimeout(resolve, 7000))
    await writeFile(
      join(output, before ? 'gap-before.png' : 'gap-after.png'),
      await browser.screenshot()
    )
    await browser.evalBrowserScript({
      script:
        'return JSON.stringify({errors:window.fixtureErrors,html:document.body.innerText,positions:[...document.querySelectorAll("video")].map(v=>v.currentTime)})',
      output: 'diagnostic'
    })
    await writeFile(
      join(output, 'diagnostic.json'),
      JSON.stringify(await browser.vars(), null, 2)
    )
    await browser.evalBrowserScript({
      script: `
      const videos=[...document.querySelectorAll('video')];
      if(videos.length!==2 || videos[0].currentTime<49 || videos[0].currentTime>52) throw new Error('Fixture did not settle at the requested instant');
      const missing=document.body.innerText.includes('Video unavailable at this moment');
      if(missing!==${!before}) throw new Error('Wrong missing-footage display: '+missing);
      if(missing){const notice=[...document.querySelectorAll('div')].find(v=>v.textContent==='Video unavailable at this moment' && v.children.length===0); if(!notice || getComputedStyle(notice.parentElement).backgroundColor!=='rgb(0, 0, 0)') throw new Error('Future footage remains visible through gap cover');}
      return JSON.stringify({positions:videos.map(v=>v.currentTime),missing});`,
      output: 'gap'
    })
    await writeFile(
      join(output, 'gap-observed.json'),
      JSON.stringify(await browser.vars(), null, 2)
    )
    await browser.openBrowser({ url: fixture.origin + '/?at=65' })
    await new Promise(resolve => setTimeout(resolve, 5000))
    await browser.evalBrowserScript({
      script: `
      if(document.body.innerText.includes('Video unavailable at this moment')) throw new Error('Gap notice did not clear');
      const videos=[...document.querySelectorAll('video')];
      if(videos.length!==2 || Math.abs(videos[0].currentTime-videos[1].currentTime-20)>0.5) throw new Error('Post-gap media not aligned');`
    })
    await writeFile(join(output, 'gap-resumed.png'), await browser.screenshot())
    console.log(
      before
        ? 'BASE REPRODUCED: future frame shown inside missing footage'
        : 'PASS: gap hidden at requested instant; both cameras aligned after gap'
    )
  } finally {
    // Keep dependent shutdowns ordered, but a failed capture must not leave
    // its browser, fixture server or scratch database behind.
    const failures: unknown[] = []
    for (const cleanup of [
      async () => await recorder?.stop(),
      async () => await cdp?.disconnect(),
      async () => await browser?.detach(),
      async () => await daemon?.shutdown(),
      async () => await fixture.close(),
      async () => await rm(dir, { recursive: true, force: true })
    ]) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'Streaming fixture cleanup failed')
  }
}
