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
    TV_METRO_URL: metro
  } = process.env
  assert(
    device !== undefined &&
      artifacts !== undefined &&
      clientRoot !== undefined &&
      metro !== undefined,
    'Set simulator, artifacts, client root and Metro URL'
  )
  const { MaestroD } = createRequire(path.join(clientRoot, 'package.json'))(
    './dist/cjs/index.js'
  )
  const h = await tvFixture()
  const daemon = await MaestroD.connect({
    name: process.env.MAESTRO_D ?? 'appleTvNative'
  })
  const tv = await daemon.attach({ device, platform: 'ios', artifacts: 'none' })
  let recording: ReturnType<typeof spawn> | undefined
  const waitForHero = async (): Promise<void> => {
    await tv.assertVisible({ id: 'tv-hero-video', timeout: 15000 })
    // Wait for the loaded midpoint frame, rather than capturing its poster.
    await new Promise(resolve => setTimeout(resolve, 2500))
  }
  const checkLayout = async (kind: string, prefix: string): Promise<void> => {
    const tree = await tv.hierarchy()
    const nodes = (node: any): any[] => [
      node,
      ...(node.children ?? []).flatMap(nodes)
    ]
    const all = nodes(tree)
    const hero = all.find(node => node.id === 'tv-hero')
    const tiles = all.filter(
      node => node.type === 'Button' && node.id?.startsWith(prefix)
    )
    assert(
      hero !== undefined && tiles.length >= 4,
      `${kind}: complete first row`
    )
    const first = tiles.slice(0, 4).map(node => node.bounds)
    const viewport =
      all.find(node => node.id === 'tv-page-home')?.bounds ?? tree.bounds
    for (let i = 0; i < 4; i++) {
      assert(
        first[i].x >= 0 && first[i].x + first[i].width <= tree.bounds.width
      )
      assert(first[i].y + first[i].height <= tree.bounds.height + 1)
      assert(Math.abs(first[i].y - first[0].y) <= 1)
      if (i > 0)
        assert(
          Math.abs(first[i].x - first[i - 1].x - first[i - 1].width - 24) <= 1
        )
    }
    if (kind === 'team' && tiles.length > 4)
      assert(
        tiles[4].bounds.y >= tree.bounds.height,
        'second grid row stays below entry viewport'
      )
    if (kind !== 'team' && tiles.length > 4)
      assert(
        tiles[4].bounds.x >= tree.bounds.width - 52,
        'fifth tile stays outside the row viewport'
      )
    const search = all.find(node => node.id === 'tv-search')
    const label = all.find(node => node.id === 'tv-search-label')
    assert(search !== undefined && label !== undefined)
    assert(
      Math.abs(
        search.bounds.y +
          search.bounds.height / 2 -
          label.bounds.y -
          label.bounds.height / 2
      ) <= 2
    )
    console.log(
      `PASS ${kind} measured hero/first-row/search bounds`,
      JSON.stringify({
        hero: hero.bounds,
        first,
        viewport,
        search: search.bounds,
        label: label.bounds
      })
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
    await tv.tapOn({ text: 'Dismiss', optional: true, timeout: 1000 })
    await captureScreenshot(tv, path.join(artifacts, 'login-after.png'))
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
    await waitForHero()
    recording = captureAllowed()
      ? spawn(
          'xcrun',
          [
            'simctl',
            'io',
            device,
            'recordVideo',
            '--force',
            path.join(artifacts, 'preview-focus.mp4')
          ],
          { stdio: 'ignore' }
        )
      : undefined
    await checkLayout('home', 'recent-')
    await captureScreenshot(tv, path.join(artifacts, 'home-after.png'))
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.pressKey({ key: 'DPAD_RIGHT' })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.assertVisible({
      text: '.*Preview: (3[0-9]|4[0-9]) seconds',
      timeout: 15000
    })
    await captureScreenshot(tv, path.join(artifacts, 'focus-after.png'))
    await tv.pressKey({ key: 'DPAD_LEFT' })
    await tv.pressKey({ key: 'DPAD_UP' })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.pressKey({ key: 'DPAD_UP' })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.tapOn({ id: 'tv-search' })
    await tv.assertVisible({ id: 'tv-native-search-field', timeout: 10000 })
    await tv.inputText({ text: 'Demo' })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.assertVisible({ id: 'tv-search-results', timeout: 15000 })
    await tv.assertVisible({ text: 'Demo Comets', timeout: 15000 })
    await tv.assertNotVisible({ text: 'Searching…', timeout: 15000 })
    await captureScreenshot(tv, path.join(artifacts, 'search-after.png'))
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.pressKey({ key: 'DPAD_CENTER' })
    await tv.assertVisible({ text: 'October 2026', timeout: 15000 })
    await waitForHero()
    await checkLayout('team', 'team-gam_')
    await captureScreenshot(tv, path.join(artifacts, 'team-after.png'))
    for (let row = 0; row < 4; row++) {
      await tv.pressKey({ key: 'DPAD_DOWN' })
      await tv.waitForAnimationToEnd({ timeout: 1500 })
    }
    await tv.pressKey({ key: 'DPAD_RIGHT' })
    await tv.pressKey({ key: 'DPAD_LEFT' })
    await tv.assertVisible({ text: 'September 2026' })
    await captureScreenshot(
      tv,
      path.join(artifacts, 'tv-team-month-scroll.png')
    )
    await tv.pressKey({ key: 'BACK' })
    await tv.assertVisible({ id: 'tv-page-home' })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.pressKey({ key: 'DPAD_UP' })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.tapOn({ id: 'tv-search' })
    await tv.inputText({ text: 'Babe' })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.assertVisible({ id: 'tv-search-results', timeout: 15000 })
    await tv.assertNotVisible({ text: 'Searching…', timeout: 15000 })
    await tv.assertVisible({ id: 'player:.*', timeout: 15000 })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.pressKey({ key: 'DPAD_CENTER' })
    await tv.assertVisible({ text: 'Recent Games', timeout: 15000 })
    await waitForHero()
    await checkLayout('player', 'recent-')
    await captureScreenshot(tv, path.join(artifacts, 'player-after.png'))
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.pressKey({ key: 'DPAD_RIGHT' })
    await tv.pressKey({ key: 'DPAD_LEFT' })
    await tv.pressKey({ key: 'BACK' })
    await tv.assertVisible({ id: 'tv-page-home' })
    await tv.waitForAnimationToEnd({ timeout: 3000 })
    await tv.tapOn({ id: 'tv-search' })
    await tv.inputText({ text: 'zzzzzz' })
    await tv.assertVisible({
      text: 'No accessible teams or players found.',
      timeout: 15000
    })
    await tv.pressKey({ key: 'BACK' })
    await tv.assertVisible({ id: 'tv-page-home', timeout: 10000 })
    h.tvMedia.searchFail = true
    await tv.tapOn({ id: 'tv-search' })
    await tv.inputText({ text: 'Demo' })
    await tv.assertVisible({
      text: 'Search is unavailable. Try again.',
      timeout: 15000
    })
    h.tvMedia.searchFail = false
    await tv.pressKey({ key: 'DPAD_DOWN' })
    await tv.pressKey({ key: 'DPAD_CENTER' })
    await tv.assertVisible({ id: 'team:tem_comets', timeout: 15000 })
    await tv.pressKey({ key: 'BACK' })
    await tv.assertVisible({ id: 'tv-page-home', timeout: 10000 })
    console.log(
      'PASS native TV home, remote directions, authorized team/player search, monthly team page, filtered player page and Back navigation'
    )
  } catch (error) {
    await writeFile(
      '/private/tmp/tv-browse-hierarchy.json',
      JSON.stringify(await tv.hierarchy(), null, 2)
    )
    await captureScreenshot(tv, '/private/tmp/tv-browse-failure.png')
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
