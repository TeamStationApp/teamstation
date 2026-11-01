import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { captureAllowed, captureScreenshot } from './capture'
import { tvFixture } from './fixture'

interface Node {
  id?: string
  text?: string
  focused?: boolean
  children?: Node[]
}
const find = (node: Node, id: string): Node | undefined =>
  node.id === id ? node : node.children?.map(n => find(n, id)).find(Boolean)
const seconds = (node: Node): number => {
  const text = find(node, 'tv-current-time')?.text
  assert(text !== undefined && /^\d+:\d\d/.test(text), 'Finite scrub time')
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0)
}

/** A real input probe: unsupported driver gestures are reported, never injected into JS. */
async function main(): Promise<void> {
  const {
    TV_SIMULATOR_UDID: device,
    TV_ARTIFACTS: artifacts,
    MAESTRO_D_CLIENT_ROOT: clientRoot,
    TV_METRO_URL: metro
  } = process.env
  assert(
    device !== undefined &&
      artifacts !== undefined &&
      clientRoot !== undefined &&
      metro !== undefined
  )
  const real = captureAllowed()
  assert(
    real || process.env.TV_PROBE_FILE !== undefined,
    'Fixture playback requires TV_PROBE_FILE'
  )
  const { MaestroD } = createRequire(path.join(clientRoot, 'package.json'))(
    './dist/cjs/index.js'
  )
  const daemon = await MaestroD.connect({ name: process.env.MAESTRO_D })
  const tv = await daemon.attach({ device, platform: 'ios', artifacts: 'none' })
  // Real-data mode uses the already signed-in, paused recording selected in the private manifest.
  const fixture = real ? undefined : await tvFixture({ scored: true })
  const results: string[] = []
  try {
    await mkdir(artifacts, { recursive: true })
    if (fixture !== undefined) {
      await tv.launchApp({
        appId: 'app.teamstation.tv',
        stopApp: true,
        environment: {
          TV_API_BASE_URL: fixture.origin + '/api/v1',
          TV_METRO_URL: metro
        }
      })
      await tv.assertVisible({
        text: 'Your games. On the big screen.',
        timeout: 60000
      })
      const codeOf = (n: Node): string | undefined =>
        /[A-Z]{4}[–-][A-Z]{4}/.exec(n.text ?? '')?.[0] ??
        n.children?.map(codeOf).find(Boolean)
      const code = codeOf(await tv.hierarchy())
      assert(code !== undefined)
      assert.equal(
        (await fixture.request('POST', '/auth/tv/approve', { code })).status,
        204
      )
      await tv.assertVisible({ text: 'Recent Games', timeout: 30000 })
      await tv.tapOn({ id: '▶ Watch Game' })
      await tv.assertVisible({ id: 'tv-angle-3', timeout: 30000 })
      await tv.assertNotVisible({ id: 'tv-box-panel', timeout: 15000 })
      await tv.assertNotVisible({ id: 'tv-cameras-panel', timeout: 15000 })
      await tv.pressKey({ key: 'playPause' })
    }
    const began = Date.now()
    await tv.pressKey({ key: 'DPAD_RIGHT' })
    const first = await tv.hierarchy()
    console.log('Click and hierarchy latency', Date.now() - began)
    await writeFile(
      path.join(artifacts, 'transport-hierarchy.json'),
      JSON.stringify(first, null, 2)
    )
    const start = seconds(first)
    assert(find(first, 'tv-highlights-panel') === undefined)
    await tv.pressKey({ key: 'DPAD_RIGHT' })
    const second = await tv.hierarchy()
    assert.equal(seconds(second) - start, 10)
    await tv.pressKey({ key: 'DPAD_LEFT' })
    assert.equal(seconds(await tv.hierarchy()), start)
    results.push(
      'PASS: real directional clicks seek +10/-10 while paused, without opening a panel.'
    )
    await captureScreenshot(tv, path.join(artifacts, 'transport-after.png'))
    // This command opens the app-owned pan window before the capability probe.
    await tv.pressKey({ key: 'DPAD_RIGHT' })
    await tv.assertVisible({ id: 'tv-scrubber' })
    try {
      await tv.swipe({ start: '40%, 50%', end: '60%, 50%', duration: 700 })
      const after = await tv.hierarchy()
      results.push(
        `PAN PROBE: current time ${find(after, 'tv-current-time')?.text ?? 'not visible'}; native phase evidence still required.`
      )
    } catch (error) {
      results.push(
        `NOT TESTED: driver cannot deliver continuous TV pan: ${String(error)}`
      )
    }
    await tv.assertNotVisible({ id: 'tv-scrubber', timeout: 5000 })
    results.push('PASS: scrub controls expire after interaction.')
    results.push(
      'NOT TESTED: pressKey has no hold duration/release API. Paired remote session required for holds, slow motion and continuous pan.'
    )
    console.log(results.join('\n'))
  } finally {
    await writeFile(
      path.join(artifacts, 'transport-input-capability.log'),
      '$ node -r sucrase/register appletv/e2e/transport.e2e.ts\n' +
        results.join('\n') +
        '\n'
    )
    if (fixture !== undefined) {
      await tv.stopApp({ appId: 'app.teamstation.tv' })
      await fixture.close()
    }
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
