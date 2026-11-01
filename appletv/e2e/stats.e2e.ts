import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { captureAllowed, captureScreenshot } from './capture'
import { tvFixture } from './fixture'

async function main(): Promise<void> {
  const {
    TV_SIMULATOR_UDID: device,
    TV_ARTIFACTS: artifacts,
    MAESTRO_D_CLIENT_ROOT: clientRoot,
    TV_METRO_URL: metro,
    TV_PROBE_FILE: media
  } = process.env
  assert(
    device !== undefined &&
      artifacts !== undefined &&
      clientRoot !== undefined &&
      metro !== undefined &&
      media !== undefined
  )
  const { MaestroD } = createRequire(path.join(clientRoot, 'package.json'))(
    './dist/cjs/index.js'
  )
  const innings = Number(process.env.TV_STATS_INNINGS ?? 25)
  const h = await tvFixture({
    scored: true,
    wideStats: true,
    statsInnings: innings
  })
  const daemon = await MaestroD.connect({
    name: process.env.MAESTRO_D ?? 'appleTvNative'
  })
  const tv = await daemon.attach({ device, platform: 'ios', artifacts: 'none' })
  let recording: ReturnType<typeof spawn> | undefined
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
    await tv.tapOn({ text: 'Dismiss', optional: true, timeout: 1000 })
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
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    recording = captureAllowed()
      ? spawn(
          'xcrun',
          [
            'simctl',
            'io',
            device,
            'recordVideo',
            '--force',
            path.join(
              artifacts,
              innings > 18 ? 'tv-extra-innings.mp4' : 'tv-compact-score.mp4'
            )
          ],
          { stdio: 'ignore' }
        )
      : undefined
    await tv.pressKey({ key: 'DPAD_CENTER' })
    await tv.assertVisible({ id: 'tv-angle-3', timeout: 30000 })
    await tv.assertVisible({ id: 'tv-scoreboard', timeout: 30000 })
    await tv.assertNotVisible({ id: 'tv-cameras-panel', timeout: 15000 })
    await tv.assertNotVisible({ id: 'tv-box-panel', timeout: 15000 })
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.assertVisible({ text: 'Demo Mountain Valley Visitors' })
    const column = (node: any): any =>
      node.id === `tv-score-column-${innings}`
        ? node
        : node.children?.map(column).find(Boolean)
    if (innings > 18) {
      const before = column(await tv.hierarchy()).bounds
      assert(
        before.x + before.width > 1880,
        'last inning starts clipped by viewport'
      )
      await tv.pressKey({ key: 'DPAD_RIGHT' })
      await tv.pressKey({ key: 'DPAD_RIGHT' })
      await tv.pressKey({ key: 'DPAD_RIGHT' })
      await tv.waitForAnimationToEnd({ timeout: 3000 })
      const after = column(await tv.hierarchy()).bounds
      assert(
        after.x < before.x && after.x + after.width <= 1880,
        'remote scroll brings the final inning fully on screen'
      )
      await captureScreenshot(tv, path.join(artifacts, 'extra-innings.png'))
      await tv.pressKey({ key: 'DPAD_LEFT' })
      await tv.waitForAnimationToEnd({ timeout: 3000 })
      await tv.assertVisible({ text: 'Demo Mountain Valley Visitors' })
    } else {
      const home = (node: any): any =>
        node.text === 'Demo Coastal Valley Hawks'
          ? node
          : node.children?.map(home).find(Boolean)
      const bounds = home(await tv.hierarchy()).bounds
      assert(
        bounds.y + bounds.height <= 1080,
        'home row remains fully on screen'
      )
      await captureScreenshot(
        tv,
        path.join(artifacts, 'compact-long-names.png')
      )
    }
    await tv.pressKey({ key: 'BACK' })
    await tv.assertNotVisible({ id: 'tv-box-panel' })
    await tv.pressKey({ key: 'BACK' })
    await tv.assertVisible({ id: 'tv-page-home' })
    console.log(`PASS long team names, ${innings} innings and panel Back`)
  } catch (error) {
    await captureScreenshot(tv, '/private/tmp/tv-playback-failure.png')
    await writeFile(
      '/private/tmp/tv-playback-hierarchy.json',
      JSON.stringify(await tv.hierarchy(), null, 2)
    )
    throw error
  } finally {
    if (recording?.exitCode === null) {
      recording.kill('SIGINT')
      await new Promise<void>(resolve =>
        recording!.once('exit', () => {
          resolve()
        })
      )
    }
    await tv.stopApp({ appId: 'app.teamstation.tv' })
    await h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
