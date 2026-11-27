import { writeFileSync } from 'node:fs'

import { BlockedError } from '../../../core/result'
import {
  defineHarness,
  type HarnessContext,
  type SurfaceNeeds
} from '../../../core/spec'
import {
  openPhoneScorer,
  type PhoneScorer,
  scorePath
} from '../../../rigs/scoring/phoneScorer'

/**
 * The scoring field with all nine positions empty (`empty-defense`: neither
 * team has a player) fits every position's label, at the phone's normal
 * text size and at its largest: P, C, 1B … RF, each "Assign …" or bare,
 * all on screen, in the app on iPhone and Android and in Safari.
 */

const POSITIONS = ['P', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF']

async function openEmpty(ctx: HarnessContext): Promise<PhoneScorer> {
  const world = await ctx.fixture('empty-defense')
  const app = await openPhoneScorer(ctx, 'scorer')
  await app.open(scorePath(world.ids.game))
  await app.m.assertVisible({ text: 'Assign a pitcher', timeout: 60000 })
  // A first-run notice, when the app shows one, is dismissed.
  if ((await app.nodes()).some(node => node.text === 'OK'))
    await app.m.tapOn({ text: '^OK$' })
  return app
}

async function capture(
  ctx: HarnessContext,
  app: PhoneScorer,
  size: string
): Promise<void> {
  for (const position of POSITIONS)
    await app.m.assertVisible({
      text: `^(Assign )?${position}$`,
      timeout: 15000
    })
  const mode = app.browser ? 'safari' : app.platform
  await app.m.takeScreenshot({ path: ctx.artifact(`${mode}-${size}.png`) })
  writeFileSync(
    ctx.artifact(`${mode}-${size}.json`),
    JSON.stringify(await app.m.hierarchy(), null, 2)
  )
}

const phone = (needs: string): SurfaceNeeds => ({
  // The scoring field draws in 3D: a GPU, so a physical phone.
  devices: [
    { role: 'device', needs: [needs, 'gpu'], simulator: 'never' as const }
  ]
})

export default defineHarness({
  id: 'scoring/position-font-fit/empty-positions',
  title: "Every empty position's label fits on the scoring field",
  kind: 'e2e',
  covers: [
    'src/app/field/NativeNameplates.tsx',
    'src/app/scoring/DefensiveField.tsx',
    'src/app/scoring/PlayerPositionField.tsx'
  ],
  stack: 'isolated',
  fixtures: ['empty-defense'],
  exclusive: false,
  surfaces: {
    'ios-app': phone('ios-phone'),
    'android-app': phone('android-phone'),
    'web-safari-ios': phone('ios-phone')
  },
  services: [],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 6,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'normal-text': async ctx => {
      await capture(ctx, await openEmpty(ctx), 'normal')
    },
    // The phone's text size is a system setting: on iOS its content size,
    // on Android its font scale. Safari's page has no such setting.
    'largest-text': async ctx => {
      if (ctx.surface === 'web-safari-ios') {
        ctx.degrade('Safari has no system text size to set for the page')
        return
      }
      throw new BlockedError(
        "maestro-d has no command to set the device's text size (iOS content size extra-extra-extra-large, Android font scale 1.3), so the largest-text labels cannot be shown"
      )
    }
  }
})
