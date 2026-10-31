import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { tvFixture } from './fixture'

async function main(): Promise<void> {
  const {
    TV_SIMULATOR_UDID: device,
    TV_ARTIFACTS: artifacts,
    MAESTRO_D_CLIENT_ROOT: clientRoot,
    TV_METRO_URL: metro
  } = process.env
  assert(device && artifacts && clientRoot && metro)
  const { MaestroD } = createRequire(path.join(clientRoot, 'package.json'))(
    './dist/cjs/index.js'
  )
  const daemon = await MaestroD.connect({ name: process.env.MAESTRO_D })
  const tv = await daemon.attach({ device, platform: 'ios' })
  const h = await tvFixture({
    scored: true,
    wideStats: true,
    statsInnings: Number(process.env.TV_STATS_INNINGS ?? 6)
  })
  const key = async (key: string): Promise<void> => {
    console.log('remote', key)
    await tv.pressKey({ key })
    await tv.waitForAnimationToEnd({ timeout: 1000 })
  }
  const shot = async (name: string): Promise<void> => {
    await writeFile(
      path.join(artifacts, name + '-after.png'),
      await tv.screenshot()
    )
  }
  try {
    await mkdir(artifacts, { recursive: true })
    await tv.launchApp({
      appId: 'app.teamstation.tv',
      stopApp: true,
      environment: {
        TV_API_BASE_URL: h.origin + '/api/v1',
        TV_METRO_URL: metro
      }
    })
    await tv.assertVisible({
      text: 'Your games. On the big screen.',
      timeout: 60000
    })
    const findCode = (node: any): string | undefined =>
      /[A-Z]{4}[–-][A-Z]{4}/.exec(String(node.text ?? ''))?.[0] ??
      node.children?.map(findCode).find(Boolean)
    const code = findCode(await tv.hierarchy())
    assert(code)
    assert.equal(
      (await h.request('POST', '/auth/tv/approve', { code })).status,
      204
    )
    await tv.assertVisible({ text: 'Recent Games', timeout: 30000 })
    await tv.tapOn({ id: '▶ Watch Game' })
    await tv.assertVisible({ id: 'tv-angle-3', timeout: 30000 })
    await tv.assertNotVisible({ id: 'tv-box-panel', timeout: 15000 })
    await tv.assertNotVisible({ id: 'tv-cameras-panel', timeout: 15000 })
    await shot('four-angles')
    await key('DPAD_RIGHT')
    await tv.assertNotVisible({ id: 'tv-highlights-panel' })
    await key('DPAD_RIGHT')
    await tv.assertVisible({ id: 'tv-highlights-panel' })
    await shot('highlights-panel')
    await key('DPAD_RIGHT')
    await tv.assertNotVisible({ id: 'tv-highlights-panel' })
    await key('DPAD_LEFT')
    await tv.assertNotVisible({ id: 'tv-cameras-panel' })
    await key('DPAD_LEFT')
    await tv.assertVisible({ id: 'tv-cameras-panel' })
    await shot('camera-panel')
    await key('DPAD_CENTER')
    await key('BACK')
    await shot('three-angles')
    await tv.assertVisible({ id: 'line-score-box' })
    await key('DPAD_LEFT')
    await tv.assertVisible({ id: 'tv-cameras-panel' })
    await key('DPAD_CENTER')
    await key('BACK')
    await shot('two-angles')
    await tv.assertVisible({ id: 'line-score-box' })
    await key('DPAD_DOWN')
    await tv.assertVisible({ id: 'tv-box-panel' })
    await tv.assertNotVisible({ id: 'tv-line-score' })
    await tv.assertVisible({ id: 'tv-stats-away' })
    await key('DPAD_DOWN')
    await shot('stats-expanded')
    console.log(
      'PASS boundary navigation, two/three static scores and stats progression'
    )
  } catch (error) {
    await writeFile(
      path.join(artifacts, 'boundary-failure.png'),
      await tv.screenshot()
    )
    await writeFile(
      path.join(artifacts, 'boundary-failure.json'),
      JSON.stringify(await tv.hierarchy(), null, 2)
    )
    throw error
  } finally {
    await tv.stopApp({ appId: 'app.teamstation.tv' })
    await h.close()
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
