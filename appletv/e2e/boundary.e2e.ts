import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { userIdOfGumbo } from '../../src/common/userId'
import { captureScreenshot } from './capture'
import { tvFixture } from './fixture'

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
  const { MaestroD } = createRequire(path.join(clientRoot, 'package.json'))(
    './dist/cjs/index.js'
  )
  const daemon = await MaestroD.connect({ name: process.env.MAESTRO_D })
  const tv = await daemon.attach({ device, platform: 'ios', artifacts: 'none' })
  const h = await tvFixture({
    scored: true,
    wideStats: true,
    statsInnings: Number(process.env.TV_STATS_INNINGS ?? 6)
  })
  const key = async (key: string): Promise<void> => {
    console.log('remote', key)
    if (key.startsWith('SWIPE_')) await tv.swipe({ direction: key.slice(6) })
    else await tv.pressKey({ key })
    await tv.waitForAnimationToEnd({ timeout: 1000 })
  }
  const shot = async (name: string): Promise<void> => {
    await captureScreenshot(tv, path.join(artifacts, name + '-after.png'))
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
    assert(code !== undefined)
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
    // A nonfirst camera must regain focus after its full-screen round trip.
    await key('SWIPE_RIGHT')
    await key('DPAD_CENTER')
    await tv.assertVisible({ text: 'Back to cameras' })
    await key('BACK')
    await shot('fullscreen-return')
    await key('SWIPE_LEFT')
    await tv.assertNotVisible({ id: 'tv-cameras-panel' })
    await key('SWIPE_LEFT')
    await tv.assertVisible({ id: 'tv-cameras-panel' })
    await key('SWIPE_RIGHT')
    await tv.assertNotVisible({ id: 'tv-cameras-panel' })
    const findBoard = (node: any): any =>
      node.id === 'scoreboard-overlay'
        ? node
        : node.children?.map(findBoard).find(Boolean)
    const oldBoard = findBoard(await tv.hierarchy()).bounds
    await h.db
      .updateTable('users')
      .set({ is_admin: true })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
    const settingsResponse = await h.request('GET', '/node/settings')
    assert.equal(settingsResponse.status, 200)
    const settings = await settingsResponse.json()
    settings.scoreboard.tvLandscape = { x: 0.2, y: 0.15, height: 0.2 }
    assert.equal(
      (await h.request('PUT', '/node/settings', settings)).status,
      200
    )
    let moved = false
    for (let attempt = 0; attempt < 12; attempt++) {
      const currentBoard = findBoard(await tv.hierarchy())?.bounds
      if (currentBoard !== undefined && currentBoard.x > oldBoard.x + 50) {
        moved = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    assert(moved, 'administrator TV placement updates during playback')
    await shot('four-angles-admin')

    await key('SWIPE_RIGHT')
    await tv.assertNotVisible({ id: 'tv-highlights-panel' })
    await key('SWIPE_RIGHT')
    await tv.assertVisible({ id: 'tv-highlights-panel' })
    await shot('highlights-panel')
    await key('SWIPE_LEFT')
    await tv.assertNotVisible({ id: 'tv-highlights-panel' })
    await key('SWIPE_LEFT')
    await tv.assertNotVisible({ id: 'tv-cameras-panel' })
    await key('SWIPE_LEFT')
    await tv.assertVisible({ id: 'tv-cameras-panel' })
    await shot('camera-panel')
    await key('DPAD_CENTER')
    await key('BACK')
    await shot('three-angles')
    await tv.assertVisible({ id: 'line-score-box' })
    await key('SWIPE_LEFT')
    await tv.assertVisible({ id: 'tv-cameras-panel' })
    await key('DPAD_CENTER')
    await key('BACK')
    await shot('two-angles')
    await tv.assertVisible({ id: 'line-score-box' })
    await key('SWIPE_DOWN')
    await tv.assertVisible({ id: 'tv-box-panel' })
    await tv.assertNotVisible({ id: 'tv-line-score' })
    await tv.assertVisible({ id: 'tv-stats-away' })
    await key('DPAD_DOWN')
    await shot('stats-expanded')
    console.log(
      'PASS boundary navigation, two/three static scores and stats progression'
    )
  } catch (error) {
    await captureScreenshot(tv, path.join(artifacts, 'boundary-failure.png'))
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
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
