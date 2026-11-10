/* eslint-disable @typescript-eslint/prefer-optional-chain -- Browser callbacks cannot capture Sucrase helpers. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

import { build } from 'esbuild'

import {
  browserSession,
  contains,
  maestro
} from '../../../e2e/rigs/refinementsMaestro'

async function main(): Promise<void> {
  const out = resolve(process.env.TS_ARTIFACTS_DIR ?? 'artifacts/gameRecording')
  await mkdir(out, { recursive: true })
  const { webSettings } = await import(
    resolve('scripts/web-build-settings.mjs')
  )
  await build({
    ...webSettings,
    alias: {
      ...webSettings.alias,
      '@react-native/assets-registry/registry':
        'react-native-web/dist/modules/AssetRegistry',
      '@react-native-clipboard/clipboard': './src/test/eventClipboardStub.ts'
    },
    entryPoints: ['src/test/gameRecording.fixture.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    outfile: join(out, 'fixture.js'),
    define: {
      __DEV__: 'true',
      global: 'globalThis',
      'process.env': '{}',
      'process.env.NODE_ENV': '"development"'
    },
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl' }
  })
  const script = await readFile(join(out, 'fixture.js'))
  const awaitFont = await readFile(
    'src/app/assets/fonts/MaterialSymbolsOutlined.ttf'
  )
  const server = createServer((req, res) => {
    if (req.url === '/symbols.ttf') {
      res.setHeader('Content-Type', 'font/ttf')
      res.end(awaitFont)
    } else if (req.url === '/fixture.js') {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(script)
    } else {
      res.setHeader('Content-Type', 'text/html')
      res.end(
        '<meta name="viewport" content="width=device-width,initial-scale=1"><style>@font-face{font-family:"Material Symbols Outlined";src:url(/symbols.ttf)}html,body,#root{margin:0;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/fixture.js"></script>'
      )
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address == null || typeof address === 'string')
    throw new Error('No server')
  const daemon = await maestro(process.env.MAESTRO_D ?? 'game-recording')
  const session = await browserSession(
    daemon,
    process.env.TS_UI_DEVICE ?? 'game-recording-web',
    390,
    844,
    out
  )
  try {
    const url = `http://127.0.0.1:${address.port}`
    const tap = async (id: string): Promise<void> => {
      await session.m.tapOn({ css: `[data-testid="${id}"]` })
    }
    const calls = async (name: string): Promise<number> =>
      await session.page.evaluate(
        name =>
          (window as any).recordingFixture.native.calls.filter(
            (call: any) => call.name === name
          ).length,
        name
      )
    const idle = async (starts: number): Promise<void> => {
      await session.page.waitForFunction(() => {
        const button = document.querySelector(
          '[data-testid="broadcast-button"]'
        )
        return (
          button != null &&
          button.getAttribute('aria-label') === 'Start recording'
        )
      })
      await new Promise(resolve => setTimeout(resolve, 500))
      assert.equal(await calls('startRecording'), starts)
      assert.equal(await calls('resumeInterrupted'), 0)
      await contains(session.page, 'Press record to start stream')
    }
    const settings = async (): Promise<void> => {
      await tap('settings-button')
      await session.page.waitForSelector('[data-testid="settings-done"]')
      await tap('settings-done')
      await session.page.waitForFunction(
        () => document.querySelector('[data-testid="settings-done"]') == null
      )
    }
    const stop = async (): Promise<void> => {
      await tap('broadcast-button')
      const slider = await session.page.waitForSelector(
        '[data-testid="slide-to-stop-track"]'
      )
      await slider!.focus()
      await session.m.pressKey({ key: 'ENTER' })
      await session.page.waitForFunction(() => {
        const button = document.querySelector(
          '[data-testid="broadcast-button"]'
        )
        return (
          button != null &&
          button.getAttribute('aria-label') === 'Start recording'
        )
      })
    }
    await session.m.openLink({ link: url })
    await session.m.tapOn({ text: 'Record', role: 'button' })
    await contains(session.page, 'Use external camera')
    await session.m.waitForAnimationToEnd()
    await writeFile(
      join(out, 'hero-name-after.png'),
      await session.m.screenshot()
    )
    await session.m.tapOn({ text: 'Home', role: 'button' })
    await session.m.tapOn({ text: 'Use external camera', role: 'button' })
    await contains(session.page, 'Stream with your camera')
    for (const source of ['gopro', 'mevo', 'mevoStudio', 'rtmp'])
      assert(
        (await session.page.$(`[data-testid="camera-source-${source}"]`)) !=
          null
      )
    await tap('camera-source-rtmp')
    await contains(session.page, 'rtmp://ingest.example.test/live/ts_0000')
    await session.m.tapOn({ text: 'Done', role: 'button' })
    await session.m.tapOn({ text: 'Record', role: 'button' })
    await session.m.tapOn({ text: 'Home', role: 'button' })
    await session.m.tapOn({ text: 'Record with this phone', role: 'button' })
    const cdp = await session.page.createCDPSession()
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { width: 844, height: 475 }
    })
    await cdp.detach()
    await session.page.setViewport({ width: 844, height: 390 })
    await idle(0)
    await writeFile(
      join(out, 'camera-entry-after.png'),
      await session.m.screenshot()
    )
    await session.page.evaluate(() => {
      const label = document.createElement('div')
      label.id = 'simulation-label'
      label.textContent = 'Simulated device and server'
      label.style.cssText =
        'position:fixed;bottom:4px;left:10px;z-index:2147483647;background:#000c;color:white;font:14px sans-serif;padding:4px;pointer-events:none'
      document.body.appendChild(label)
    })
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- The installed Chromium supports CDP screencast, not the newer recording stream.
    const recording = await session.page.screencast({
      path: `${out}/recording-entry.webm`
    })
    try {
      await idle(0)
      await settings()
      await idle(0)
      await tap('broadcast-button')
      await contains(session.page, 'Broadcasting')
      await new Promise(resolve => setTimeout(resolve, 1200))
      assert.equal(await calls('startRecording'), 1)
      await stop()
      await settings()
      await idle(1)
      await tap('camera-close')
      await session.m.tapOn({ text: 'Record', role: 'button' })
      await idle(1)
      await session.page.waitForFunction(
        () =>
          document.querySelector('[data-testid="angle-name-prompt"]') == null
      )
      await tap('broadcast-button')
      await contains(session.page, 'Broadcasting')
      await new Promise(resolve => setTimeout(resolve, 1200))
      assert.equal(await calls('startRecording'), 2)
      await stop()
      await tap('camera-close')
    } finally {
      await recording.stop()
    }
    for (const query of [
      '?interrupted=same',
      '?interrupted=other',
      '?videos=1'
    ]) {
      await session.m.openLink({ link: url + query })
      await session.m.tapOn({
        text: query.includes('videos') ? 'Record Video' : 'Record',
        role: 'button'
      })
      await contains(session.page, 'Use external camera')
      await session.m.tapOn({ text: 'Home', role: 'button' })
      await session.m.tapOn({ text: 'Record with this phone', role: 'button' })
      await idle(0)
      await tap('broadcast-button')
      await contains(session.page, 'Broadcasting')
      await new Promise(resolve => setTimeout(resolve, 1200))
      await stop()
      await tap('camera-close')
      if (query.includes('videos')) {
        await tap('angle-row-liv_00000000000000000001')
      } else await session.m.tapOn({ text: 'Record', role: 'button' })
      await idle(1)
      await tap('camera-close')
    }
    console.log(
      'PASS: real hero and Videos components offer both sources; camera opens idle on first, repeated and interrupted entry; only explicit Record starts; Stop, settings and row reentry work. Device engine and server are simulated.'
    )
  } finally {
    await session.browser.disconnect()
    await session.m.detach()
    await daemon.shutdown()
    server.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
