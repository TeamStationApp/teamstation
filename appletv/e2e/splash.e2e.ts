import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { PNG } from 'pngjs'

import {
  FRAME_TIMES,
  readReport,
  referenceName,
  waitGone,
  waitReady
} from '../../e2e/rigs/app/splash'

/**
 * TeamStation TV's launch splash on a tvOS simulator, outside the e2e
 * framework, whose surfaces have no tvOS app:
 *
 *   TV_SIMULATOR_UDID=<udid> TV_ARTIFACTS=<dir> MAESTRO_D_CLIENT_ROOT=<dir> \
 *     node -r sucrase/register appletv/e2e/splash.e2e.ts
 *
 * The app is a Release simulator build (no Metro), so the freeze hook is
 * honoured because it is a simulator build. frames-tv launches frozen at each
 * time, waits for the splash to report ready, and compares a screenshot with
 * the reference page rendered at the size and scale the splash reports.
 * dismiss-tv checks the splash leaves for the code screen and the remote then
 * works.
 */

const APP_ID = 'app.teamstation.tv'
const CODE_SCREEN = 'Your games. On the big screen.'

const compare: {
  compareImages: (
    a: { width: number; height: number; data: Uint8Array },
    b: { width: number; height: number; data: Uint8Array }
  ) => { pass: boolean; reason: string }
} = require('../../scripts/splash/compareToReference.mjs')

async function main(): Promise<void> {
  const {
    TV_SIMULATOR_UDID: device,
    TV_ARTIFACTS: artifacts,
    MAESTRO_D_CLIENT_ROOT: clientRoot
  } = process.env
  assert(
    device != null && artifacts != null && clientRoot != null,
    'Set the simulator, the artifacts directory and the maestro-d client root'
  )
  const { MaestroD } = createRequire(path.join(clientRoot, 'package.json'))(
    './dist/cjs/index.js'
  )
  const daemon = await MaestroD.connect({
    name: process.env.MAESTRO_D ?? 'appleTvNative'
  })
  const tv = await daemon.attach({ device, platform: 'ios', artifacts: 'none' })
  const references = path.join(artifacts, 'reference')
  try {
    await mkdir(artifacts, { recursive: true })

    // frames-tv
    let rendered = ''
    for (const t of FRAME_TIMES) {
      await tv.launchApp({
        appId: APP_ID,
        stopApp: true,
        arguments: { TSSplashFreezeAt: t }
      })
      const report = await waitReady(tv, 60_000)
      const size = `${report.width}x${report.height}@${report.scale}`
      if (rendered !== size) {
        execFileSync(
          'node',
          [
            'scripts/splash/buildSplashAssets.mjs',
            '--frames',
            references,
            '--sizes',
            size
          ],
          { stdio: 'inherit' }
        )
        rendered = size
      }
      const shot = path.join(artifacts, `splash-tv-t${t}.png`)
      await writeFile(shot, await tv.screenshot())
      const result = compare.compareImages(
        PNG.sync.read(await readFile(shot)),
        PNG.sync.read(
          await readFile(path.join(references, referenceName(report, t)))
        )
      )
      assert(result.pass, `frames-tv t${t}: ${result.reason}`)
      console.log(`frames-tv t${t}: ${result.reason}`)
    }

    // dismiss-tv
    await tv.launchApp({ appId: APP_ID, stopApp: true })
    await tv.assertVisible({ id: 'tsSplash', timeout: 10_000 })
    await waitGone(tv, 8_000)
    await tv.assertVisible({ text: CODE_SCREEN, timeout: 30_000 })
    assert.equal(readReport(String(await tv.hierarchyRaw())), undefined)
    await tv.pressKey('select')
    console.log('dismiss-tv: the splash left for the code screen')
  } finally {
    await tv.detach().catch(() => undefined)
    await daemon.shutdown().catch(() => undefined)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
