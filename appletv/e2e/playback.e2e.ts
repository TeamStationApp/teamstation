import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

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
  const h = await tvFixture({ scored: true })
  const daemon = await MaestroD.connect({
    name: process.env.MAESTRO_D ?? 'appleTvNative'
  })
  const tv = await daemon.attach({ device, platform: 'ios' })
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
    recording = spawn(
      'xcrun',
      [
        'simctl',
        'io',
        device,
        'recordVideo',
        '--force',
        path.join(artifacts, 'tv-playback.mp4')
      ],
      { stdio: 'ignore' }
    )
    await tv.pressKey({ key: 'DPAD_CENTER' })
    await tv.assertVisible({ id: 'tv-angle-3', timeout: 30000 })
    await tv.assertVisible({ id: 'tv-scoreboard', timeout: 30000 })
    await tv.assertNotVisible({ id: 'tv-cameras-panel', timeout: 15000 })
    await tv.assertNotVisible({ id: 'tv-box-panel', timeout: 15000 })
    await tv.pressKey({ key: 'DPAD_LEFT' })
    await tv.tapOn({ id: 'tv-toggle-1' })
    await writeFile(
      path.join(artifacts, 'tv-camera-panel.png'),
      await tv.screenshot()
    )
    await tv.tapOn({ id: 'tv-toggle-1' })
    await tv.pressKey({ key: 'BACK' })
    await tv.assertNotVisible({ id: 'tv-cameras-panel' })
    await tv.tapOn({ id: 'tv-angle-0' })
    await tv.assertVisible({ id: 'Back to cameras' })
    await writeFile(
      path.join(artifacts, 'tv-fullscreen.png'),
      await tv.screenshot()
    )
    await tv.pressKey({ key: 'BACK' })
    await tv.assertVisible({ id: 'Back to games' })
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await writeFile(
      path.join(artifacts, 'score-after.png'),
      await tv.screenshot()
    )
    await tv.tapOn({ id: 'Team and player statistics' })
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.assertVisible({ text: 'Batting', timeout: 15000 })
    await writeFile(
      path.join(artifacts, 'stats-after.png'),
      await tv.screenshot()
    )
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.pressKey({ key: 'BACK' })
    await tv.assertNotVisible({ id: 'tv-box-panel' })
    await tv.pressKey({ key: 'DPAD_RIGHT' })
    await tv.pressKey({ key: 'DPAD_RIGHT' })
    await tv.tapOn({ id: 'tv-highlight-0' })
    await tv.assertNotVisible({ id: 'tv-highlights-panel', timeout: 5000 })
    await tv.assertVisible({ id: 'tv-highlights-panel', timeout: 30000 })
    await writeFile(
      path.join(artifacts, 'tv-highlights.png'),
      await tv.screenshot()
    )
    await tv.pressKey({ key: 'BACK' })
    await tv.assertNotVisible({ id: 'tv-highlights-panel' })
    await tv.assertVisible({ id: 'tv-player' })
    await tv.pressKey({ key: 'BACK' })
    await tv.assertVisible({ id: 'tv-page-home' })
    console.log('PASS four-camera playback and highlight continuation')
    // Reuse this isolated database to exercise a single live-labeled source and a real media failure.
    await h.db
      .updateTable('videos')
      .set({ status: 'error' })
      .where('game_id', '=', 'gam_tv_0')
      .where('id', '!=', 'vid_tv_0_0')
      .execute()
    h.tvMedia.live = true
    await h.db
      .updateTable('videos')
      .set({ status: 'live' })
      .where('id', '=', 'vid_tv_0_0')
      .execute()
    await tv.launchApp({
      appId: 'app.teamstation.tv',
      stopApp: true,
      environment: {
        TV_API_BASE_URL: h.origin + '/api/v1',
        TV_METRO_URL: metro
      }
    })
    await tv.assertVisible({ text: 'Watch Live', timeout: 30000 })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.pressKey({ key: 'DPAD_CENTER' })
    await tv.assertVisible({ id: 'tv-angle-0', timeout: 30000 })
    await tv.assertNotVisible({ id: 'tv-angle-1' })
    await tv.assertNotVisible({ id: 'tv-cameras-panel' })
    await tv.assertNotVisible({ id: 'tv-box-panel', timeout: 15000 })
    await writeFile(
      path.join(artifacts, 'tv-single-live.png'),
      await tv.screenshot()
    )
    await tv.pressKey({ key: 'BACK' })
    await tv.assertVisible({ id: 'tv-page-home' })
    h.tvMedia.fail = true
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.pressKey({ key: 'DPAD_CENTER' })
    await tv.assertVisible({ text: 'cameras could not play', timeout: 60000 })
    await writeFile(
      path.join(artifacts, 'tv-unavailable.png'),
      await tv.screenshot()
    )
    h.tvMedia.fail = false
    await tv.tapOn({ id: 'Retry video' })
    await tv.assertVisible({ id: 'tv-scoreboard', timeout: 30000 })
    console.log(
      'PASS native four-stream playback, initial timeout, camera toggle/reflow, enlargement/Back, historical score panel, seek, highlight auto-return and playback exit'
    )
  } catch (error) {
    await writeFile(
      '/private/tmp/tv-playback-failure.png',
      await tv.screenshot()
    )
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
