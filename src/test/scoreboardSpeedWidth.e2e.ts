import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import express from 'express'

import { maestro } from './refinementsMaestro.e2e'

interface Measurement {
  index: number
  speed: number
  width: number
  height: number
  slotWidth: number
  contentWidth: number
}

/** Real WebKit geometry, with the production board and its bundled font. */
async function main(): Promise<void> {
  const device = process.env.TS_SCOREBOARD_SIMULATOR_UDID
  const output = process.env.TS_SCOREBOARD_ARTIFACTS
  assert(
    device != null && output != null,
    'Supply simulator and artifact directory'
  )
  const directory = path.join(output, 'fixture')
  await mkdir(directory, { recursive: true })
  const { build } = await import('esbuild')
  const { webSettings } = require('../../scripts/web-build-settings.mjs')
  const speeds = [0, 9, 11, 44, 71, 88, 99, 0]
  await build({
    ...webSettings,
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
        import React, {useEffect, useState} from 'react';
        import {createRoot} from 'react-dom/client';
        import {ScoreboardBoard} from './src/app/scoreboard/ScoreboardBoard';
        import {SAMPLE_SCOREBOARD} from './src/common/scoreboard';
        const speeds = ${JSON.stringify(speeds)};
        function Fixture() {
          const [index, setIndex] = useState(0);
          const scenario = Math.floor(index / speeds.length);
          const pitchSpeed = speeds[index % speeds.length];
          useEffect(() => {
            let current = true;
            document.fonts.ready.then(() => requestAnimationFrame(() => {
              if (!current) return;
              const board = document.querySelector('[data-scoreboard="board"]').getBoundingClientRect();
              const slot = document.querySelector('[data-scoreboard="pitchSpeed"]');
              const children = [...slot.children];
              const contentWidth = children.reduce((sum, child) => sum + child.getBoundingClientRect().width + parseFloat(getComputedStyle(child).marginLeft), 0);
              fetch('/measurement', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({index, speed:pitchSpeed, width:board.width, height:board.height, slotWidth:slot.getBoundingClientRect().width, contentWidth})});
            }));
            return () => {current = false};
          }, [index]);
          return <>
            <button onClick={() => setIndex(index + 1)}>Next speed</button>
            <div style={{width:1920, height:1080}}>
              <ScoreboardBoard state={{...SAMPLE_SCOREBOARD, pitchSpeed,
                ...(scenario === 1 ? {homeTeam:'LONG DEMO TEAM NAME', awayTeam:'DEMO VISITORS'} : {}),
                ...(scenario === 2 ? {batterName:'', pitcherName:''} : {})}} />
            </div>
          </>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      `
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    outfile: path.join(directory, 'app.js'),
    define: {
      __DEV__: 'true',
      global: 'globalThis',
      'process.env': '{}',
      'process.env.NODE_ENV': '"development"'
    }
  })
  await cp('src/app/assets/fonts', path.join(directory, 'fonts'), {
    recursive: true
  })
  const html = (await readFile('src/app/web/index.html', 'utf8'))
    .replace('width=device-width, initial-scale=1', 'width=1920')
    .replace(
      '</head>',
      '<style>body{background:#333}#root{display:block}button{font-size:60px}</style></head>'
    )
  await writeFile(path.join(directory, 'index.html'), html)
  const app = express()
  const received = new Map<number, Measurement>()
  app.use(express.json())
  app.post('/measurement', (req, res) => {
    received.set(req.body.index, req.body)
    res.sendStatus(204)
  })
  app.use(express.static(directory))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert(address != null && typeof address !== 'string')
  const daemon = await maestro('scoreboard-speed-width')
  let m: Awaited<ReturnType<typeof daemon.attach>> | undefined
  try {
    m = await daemon.attach({
      device,
      platform: 'ios',
      appId: 'com.apple.mobilesafari',
      artifacts: 'on-failure'
    })
    await m.openLink({ link: `http://127.0.0.1:${address.port}` })
    await m.assertVisible({ text: 'Next speed', timeout: 20000 })
    for (let index = 0; index < speeds.length * 3; index++) {
      if (index > 0) await m.tapOn({ text: 'Next speed' })
      for (let attempt = 0; attempt < 100 && !received.has(index); attempt++)
        await new Promise(resolve => setTimeout(resolve, 100))
      assert(received.has(index), `Missing measurement ${index}`)
      if (index === 0 || index === 3 || index === 5)
        await writeFile(
          path.join(output, `speed-${speeds[index]}.png`),
          await m.screenshot()
        )
    }
    const measurements = [...received.values()]
    await writeFile(
      path.join(output, 'measurements.json'),
      JSON.stringify(measurements, null, 2)
    )
    for (const value of measurements) {
      const baseline = received.get(
        Math.floor(value.index / speeds.length) * speeds.length
      )!
      assert(
        Math.abs(value.width - baseline.width) < 0.1,
        `Board changes width at ${value.speed}: ${baseline.width} -> ${value.width}`
      )
      assert(
        Math.abs(value.height - baseline.height) < 0.1,
        `Board changes height at ${value.speed}`
      )
      assert(
        value.contentWidth <= value.slotWidth + 0.1,
        `Speed ${value.speed} overflows its slot`
      )
    }
    console.log(
      'Stable scoreboard dimensions and readable two-digit pitch speeds in all 24 WebKit states'
    )
  } finally {
    await m?.detach()
    await daemon.shutdown()
    server.closeAllConnections()
    await new Promise<void>(resolve =>
      server.close(() => {
        resolve()
      })
    )
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
