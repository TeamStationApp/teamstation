import { statSync } from 'node:fs'

import { expect } from 'chai'

import {
  defineHarness,
  type HarnessContext,
  type HarnessScenario,
  type HarnessSpec
} from '../../../core/spec'
import { pause, playerWorld, recordedGames } from './games'

/**
 * The player-layouts scenarios on a phone or an iPad (D1–D6, and the bench
 * B1–B5): a scored game's videos page opens in the device's browser (Safari
 * on iOS, Chrome on Android) or in the app, and the screen it shows is
 * pictured.
 */

/** Opens the page and pictures the screen; answers the picture's size in bytes. */
export async function picturedVideosPage(ctx: HarnessContext): Promise<number> {
  const pw = await playerWorld(ctx)
  const { games } = await recordedGames(pw, ['S'], { quick: true })
  const link = `${ctx.stack.origin}/games/${games.S!.id}?tab=watch`
  const app = ctx.surface === 'ios-app' || ctx.surface === 'android-app'
  const m = app
    ? ctx.attached('device')
    : await ctx.mobileBrowser('device', link)
  if (app) await m.openLink({ link, browser: false })
  await pause(8000)
  const file = ctx.artifact(`device-smoke-${ctx.surface}.png`)
  await m.takeScreenshot({ path: file })
  return statSync(file).size
}

export function playerDeviceSpec(
  id: string,
  title: string,
  phone: { ios: string; android?: string },
  simulator: 'allowed' | 'never',
  scenario: HarnessScenario
): HarnessSpec {
  const role = (
    needs: string
  ): { role: string; needs: string[]; simulator: 'allowed' | 'never' } => ({
    role: 'device',
    needs: [needs],
    simulator
  })
  return defineHarness({
    id,
    title,
    kind: 'e2e',
    covers: [
      'src/app/player/MultiCamView.native.tsx',
      'src/app/player/VideoView.native.tsx',
      'src/app/player/MultiCamView.tsx',
      'src/app/player/multiCam/**'
    ],
    stack: 'isolated',
    fixtures: ['player-layouts'],
    exclusive: false,
    surfaces: {
      'web-safari-ios': { devices: [role(phone.ios)] },
      'ios-app': { devices: [role(phone.ios)] },
      ...(phone.android == null
        ? {}
        : {
            'web-chrome-android': { devices: [role(phone.android)] },
            'android-app': { devices: [role(phone.android)] }
          })
    },
    services: [],
    apps:
      phone.android == null
        ? ['teamstation-ios']
        : ['teamstation-ios', 'teamstation-android'],
    secrets: [],
    costUsd: 0,
    minutes: 8,
    guards: [],
    faults: [],
    manual: false,
    sendsNoMail: true,
    scenarios: { 'videos-page': scenario }
  })
}

// The phones are the bench's own, playing HEVC on their hardware decoders,
// as the legacy run's were.
export default playerDeviceSpec(
  'playback/player-layouts/device-videos-page',
  "A scored game's videos page opens on a phone, in its browser and in the app",
  { ios: 'ios-phone', android: 'android-phone' },
  'never',
  async ctx => {
    expect(
      await picturedVideosPage(ctx),
      'the device pictured its screen'
    ).above(0)
  }
)
