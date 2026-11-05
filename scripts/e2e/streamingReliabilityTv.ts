import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { tvFixture } from '../../appletv/e2e/fixture'

interface Tree {
  id?: string
  text?: string
  children?: Tree[]
}
const find = (tree: Tree, id: string): Tree | undefined =>
  tree.id === id
    ? tree
    : tree.children?.map(child => find(child, id)).find(Boolean)
const allText = (tree: Tree): string =>
  [tree.text ?? '', ...(tree.children ?? []).map(allText)].join('\n')
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Finished TV app against isolated synthetic media and authorization routes. */
export async function tvReliability(testCase: string): Promise<void> {
  const {
    TV_SIMULATOR_UDID: device,
    TV_METRO_URL: metro,
    TS_E2E_ARTIFACT_DIR: output,
    MAESTRO_D_CLIENT_ROOT: clientRoot
  } = process.env
  assert(
    device != null && metro != null && output != null && clientRoot != null
  )
  assert(['transport', 'archive'].includes(testCase), 'Unsupported TV case')
  const before = process.env.TS_EXPECT_BASE_FAILURE === '1'
  const { MaestroD } = createRequire(join(clientRoot, 'package.json'))(
    './dist/cjs/index.js'
  )
  const daemon = await MaestroD.connect({
    name: process.env.MAESTRO_D ?? 'streamingReliabilityTv'
  })
  const tv = await daemon.attach({ device, platform: 'ios', artifacts: 'none' })
  const fixture = await tvFixture({ scored: true })
  let recording: ChildProcess | undefined
  try {
    await mkdir(output, { recursive: true })
    fixture.tvMedia.live = true
    await fixture.db
      .updateTable('videos')
      .set({ status: 'live' })
      .where('game_id', '=', 'gam_tv_0')
      .execute()
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
    const code = /[A-Z]{4}[–-][A-Z]{4}/.exec(allText(await tv.hierarchy()))?.[0]
    assert(code != null, 'TV pairing code')
    assert.equal(
      (await fixture.request('POST', '/auth/tv/approve', { code })).status,
      204
    )
    await tv.assertVisible({ text: 'Recent Games', timeout: 30000 })
    await tv.tapOn({ id: 'tv-watch-game' })
    await tv.assertVisible({ id: 'tv-angle-3', timeout: 30000 })
    await delay(6000)
    await tv.pressKey({ key: 'playPause' })
    await tv.pressKey({ key: 'DPAD_LEFT' })
    const tree = (await tv.hierarchy()) as Tree
    await writeFile(
      join(output, before ? 'tv-before.png' : 'tv-after.png'),
      await tv.screenshot()
    )
    await writeFile(
      join(output, 'tv-transport.json'),
      JSON.stringify({ synthetic: true, before, tree }, null, 2)
    )
    if (before) assert.match(allText(tree), /Seeking unavailable/i)
    else {
      assert.doesNotMatch(allText(tree), /Seeking unavailable/i)
      assert(
        find(tree, 'tv-current-time') !== undefined,
        'Live transport shows a finite position'
      )
    }
    if (testCase === 'archive') {
      const at = find(tree, 'tv-current-time')?.text
      assert(at !== undefined)
      recording = spawn(
        'xcrun',
        [
          'simctl',
          'io',
          device,
          'recordVideo',
          '--force',
          join(output, 'tv-recovery.mp4')
        ],
        { stdio: 'ignore' }
      )
      fixture.tvMedia.live = false
      await fixture.db
        .updateTable('videos')
        .set({ status: 'ready' })
        .where('game_id', '=', 'gam_tv_0')
        .execute()
      await delay(13000)
      await tv.pressKey({ key: 'DPAD_RIGHT' })
      await tv.pressKey({ key: 'DPAD_LEFT' })
      const after = (await tv.hierarchy()) as Tree
      assert.doesNotMatch(
        allText(after),
        /could not play|Try again|Seeking unavailable/i
      )
      assert.equal(
        find(after, 'tv-current-time')?.text,
        at,
        'Paused viewer retains the same moment across archive publication'
      )
      await writeFile(join(output, 'tv-archive.png'), await tv.screenshot())
      console.log(
        'PASS: live-to-archive refresh retains a paused rewind and permits seeking'
      )
    }
    console.log(
      before
        ? 'BASE REPRODUCED: live seeking unavailable'
        : 'PASS: live seeking exposes finite transport'
    )
  } finally {
    if (recording?.exitCode === null) {
      const stopped = new Promise<void>(resolve =>
        recording!.once('exit', () => {
          resolve()
        })
      )
      recording.kill('SIGINT')
      const deadline = setTimeout(() => recording?.kill('SIGKILL'), 5000)
      await stopped
      clearTimeout(deadline)
    }
    await tv.stopApp({ appId: 'app.teamstation.tv' }).catch(() => undefined)
    await fixture.close()
  }
}
