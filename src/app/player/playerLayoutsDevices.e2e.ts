import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  APP,
  artifacts,
  fixture,
  print
} from '../../../e2e/rigs/playerLayoutsRig'

/**
 * The player-layouts scenarios on phones and an iPad (D1–D6), and the live
 * bench (B1–B5), through maestro-d. One device a run, named only by the
 * environment, so no device is written into the repository:
 *
 *   TS_DEVICE=<serial, address or UDID> TS_DEVICE_PLATFORM=android|ios \
 *   [TS_DEVICE_SURFACE=browser|app] MAESTRO_D=playerLayoutsDev \
 *   MAESTRO_D_BIN=~/git/maestro-d/maestro-d \
 *   MAESTRO_D_CLIENT_ROOT=~/git/maestro-d/npm/maestro-d \
 *   [MAESTRO_D_TEAM_ID=<team, for WebDriverAgent on hardware>] \
 *   TS_PLAYER_APP=http://<this Mac>:8091 \
 *     npx mocha -r sucrase/register --extension ts --timeout 1800000 \
 *     src/app/player/playerLayoutsDevices.e2e.ts
 *
 * The browser is Chrome on Android and Safari on iOS; the app is
 * `app.teamstation.app`, built against `TS_PLAYER_APP`'s API.
 */
const DEVICE = process.env.TS_DEVICE
const PLATFORM = process.env.TS_DEVICE_PLATFORM ?? 'android'
const SURFACE = process.env.TS_DEVICE_SURFACE ?? 'browser'

interface Device {
  openLink: (args: Record<string, unknown>) => Promise<unknown>
  launchApp: (args?: Record<string, unknown>) => Promise<unknown>
  takeScreenshot: (args?: Record<string, unknown>) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  detach: () => Promise<void>
}
interface Daemon {
  attach: (args: Record<string, unknown>) => Promise<Device>
  shutdown: () => Promise<void>
}

describe('player layouts on a device', function () {
  let device: Device | undefined

  before(async function () {
    if (DEVICE == null || DEVICE === '') this.skip()
    const bin = process.env.MAESTRO_D_BIN
    if (bin == null) throw new Error('MAESTRO_D_BIN is required')
    console.log(execFileSync(bin, ['ps'], { encoding: 'utf8' }))
    const require =
      process.env.MAESTRO_D_CLIENT_ROOT == null
        ? createRequire(__filename)
        : createRequire(join(process.env.MAESTRO_D_CLIENT_ROOT, 'package.json'))
    const { MaestroD } = require('maestro-d')
    const daemon = (await MaestroD.connect({
      name: process.env.MAESTRO_D ?? 'playerLayoutsDev',
      bin
    })) as Daemon
    device = await daemon.attach({
      device: DEVICE,
      platform: PLATFORM,
      appId:
        SURFACE === 'app'
          ? 'app.teamstation.app'
          : PLATFORM === 'ios'
            ? 'com.apple.mobilesafari'
            : 'com.android.chrome',
      ...(process.env.MAESTRO_D_TEAM_ID == null
        ? {}
        : { teamId: process.env.MAESTRO_D_TEAM_ID })
    })
  })

  after(async function () {
    await device?.detach()
  })

  it("opens a scored game's videos page", async function () {
    const S = fixture().games.S
    await device!.openLink({
      link: `${APP}/games/${S.id}?tab=watch`,
      browser: SURFACE === 'browser'
    })
    await new Promise(resolve => setTimeout(resolve, 8000))
    const picture = await device!.screenshot()
    expect(picture.length).above(0)
    if (artifacts != null) {
      mkdirSync(artifacts, { recursive: true })
      writeFileSync(join(artifacts, `device-smoke-${PLATFORM}.png`), picture)
      print('saved the device smoke picture')
    }
  })
})
