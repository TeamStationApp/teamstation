import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { build } from 'esbuild'

import { tvFixture } from '../../appletv/e2e/fixture'
import { webSettings } from '../web-build-settings.mjs'

/** The production grid and real media/auth routes with a synthetic recording hole. */
export async function webReliability(testCase: string): Promise<void> {
  assert.equal(testCase, 'gaps')
  const output = process.env.TS_E2E_ARTIFACT_DIR
  const clientRoot = process.env.MAESTRO_D_CLIENT_ROOT
  assert(output != null && clientRoot != null)
  const before = process.env.TS_EXPECT_BASE_FAILURE === '1'
  const sourceRoot = resolve(process.env.TS_E2E_SOURCE_ROOT ?? '.')
  const dir = await mkdtemp(join(tmpdir(), 'streaming-grid-'))
  const fixture = await tvFixture({ gap: true, webRoot: dir })
  const { MaestroD } = require(clientRoot)
  let daemon: any
  let browser: any
  try {
    await mkdir(output, { recursive: true })
    const entry = `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {TeamStationClient} from './src/common/api';
      import {ThemeProvider} from './src/app/theme/ThemeContext';
      import {MultiCamView} from './src/app/player/MultiCamView';
      const client = new TeamStationClient({baseUrl: '/api/v1', token: ${JSON.stringify(fixture.tokens.get(101))}});
      const game = await client.game('gam_tv_0');
      const start = Date.parse(game.videos[0].startAt);
      const at = Number(new URLSearchParams(location.search).get('at') ?? 50);
      createRoot(document.getElementById('root')).render(<ThemeProvider>
        <MultiCamView client={client} videos={game.videos.slice(0,2)} order={game.videos.slice(0,2).map(v=>v.id)}
          audioId={null} zoomedId={null} atMs={start+at*1000} endAtMs={start+(at+0.2)*1000}
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
      appId: fixture.origin + '/?at=50',
      artifacts: 'on-failure',
      extra: {
        browser: process.env.LIVE_TEST_BROWSER ?? 'chrome',
        windowSize: '1280x800'
      }
    })
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
    await browser?.detach()
    await daemon?.shutdown()
    await fixture.close()
    await rm(dir, { recursive: true, force: true })
  }
}
