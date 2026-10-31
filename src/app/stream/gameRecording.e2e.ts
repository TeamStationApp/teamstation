import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

import { build } from 'esbuild'

import {
  browserSession,
  contains,
  maestro
} from '../../test/refinementsMaestro.e2e'

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
  const server = createServer((req, res) => {
    if (req.url === '/fixture.js') {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(script)
    } else {
      res.setHeader('Content-Type', 'text/html')
      res.end(
        '<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;height:100%}#root{display:flex;flex-direction:column}</style><div id="root"></div><script src="/fixture.js"></script>'
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
    await session.m.openLink({ link: `http://127.0.0.1:${address.port}` })
    await contains(session.page, 'Record')
    await session.m.tapOn({ text: 'Record', role: 'button' })
    await contains(session.page, 'Name this camera angle')
    await session.m.waitForAnimationToEnd()
    await writeFile(join(out, 'camera-name.png'), await session.m.screenshot())
    await session.m.tapOn({ text: 'Home', role: 'button' })
    await session.m.tapOn({ text: 'Record with this phone', role: 'button' })
    await contains(session.page, 'Recording camera: Home')
    await contains(session.page, 'Automatic start requested')
    await writeFile(join(out, 'recording.png'), await session.m.screenshot())
    await session.m.tapOn({ text: 'Close camera', role: 'button' })
    await session.m.tapOn({ text: 'Record', role: 'button' })
    await contains(session.page, 'Recording camera: Home')
    assert.equal(
      await session.page.$('[data-testid="angle-name-prompt"]'),
      null
    )
    await writeFile(
      join(out, 'continued-camera.png'),
      await session.m.screenshot()
    )
    console.log(
      'PASS: hero Record asks for a camera name, requests automatic start, and continues the same device stream without the prompt; no DJ permission required. Camera engine is simulated.'
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
