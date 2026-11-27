import { writeFileSync } from 'node:fs'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import { recordScreen } from '../../../core/video'
import {
  clearSignInLimits,
  serverKeptOnHubPhone
} from '../../../rigs/coach/coachApp'

/**
 * The scoring screen's field sounds on a phone: a ball, a called strike and
 * a foul, which between them play the swish of the release, the pop of the
 * glove and the bat. The scorer opens the replay game in progress straight
 * in the scorer and throws the three pitches while maestro-d records the
 * screen, `scoring-sounds-<surface>.mp4`, for a person to hear.
 */

const PITCH_GAP_MS = 3500

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function appKind(ctx: HarnessContext): string {
  return ctx.surface === 'android-app'
    ? 'teamstation-android'
    : 'teamstation-ios'
}

export default defineHarness({
  id: 'scoring/field-sounds/pitch-sounds',
  title: 'A ball, a called strike and a foul play their field sounds',
  kind: 'e2e',
  covers: [
    'src/app/scoring/cueSoundsController.ts',
    'src/app/scoring/NativeCueSounds.ts',
    'src/app/scoring/scoringCueSamples.ts'
  ],
  stack: 'isolated',
  fixtures: ['replay-games'],
  exclusive: false,
  surfaces: {
    // The scoring screen draws in 3D (gpu), and its sounds are a phone's
    // own speaker: a physical phone, never a simulator.
    'ios-app': {
      devices: [
        { role: 'device', needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    },
    'android-app': {
      devices: [
        { role: 'device', needs: ['android-phone', 'gpu'], simulator: 'never' }
      ]
    }
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
    'three-pitches': async ctx => {
      const world = await ctx.fixture('replay-games')
      const appId = ctx.app(appKind(ctx))
      const m = ctx.attached('device')
      await clearSignInLimits(ctx)
      await m.launchApp({ appId, clearState: true })
      // A clear forgets the server: the link points the app back at the stack.
      await serverKeptOnHubPhone(m, appId, ctx.stack.origin)
      await ctx.signIn('scorer', m)
      await m.openLink({
        link: `teamstation://games/${world.ids.inProgressGame}/score`
      })
      await m.assertVisible({ text: 'Ball', timeout: 30000 })
      await m.takeScreenshot({
        path: ctx.artifact(`scoring-sounds-${ctx.surface}-screen.png`)
      })
      const thrown: string[] = []
      await recordScreen(
        m,
        ctx.runDir,
        `scoring-sounds-${ctx.surface}`,
        async () => {
          await wait(3000)
          for (const control of ['^Ball$', '^Called Strike$', '^Foul Ball$']) {
            await m.tapOn({ text: control })
            // The wall clock of each pitch, to find its sound in the recording.
            thrown.push(`${control}: tapped at ${new Date().toISOString()}`)
            await wait(PITCH_GAP_MS)
          }
        }
      )
      writeFileSync(
        ctx.artifact(`scoring-sounds-${ctx.surface}.log`),
        thrown.join('\n') + '\n'
      )
    }
  }
})
