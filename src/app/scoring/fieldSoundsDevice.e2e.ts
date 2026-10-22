import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  artifactsDir,
  connect,
  type Device,
  recordWebcam,
  required,
  shot,
  signInPhone
} from '../replay/kit.e2e'

/**
 * The scoring screen's field sounds on a phone, heard by the bench webcam:
 * a ball, a called strike and a foul, which between them play the swish of
 * the release, the pop of the glove and the bat. Run against a server with
 * the replay seed loaded, on a build pointed at it:
 *
 *   REPLAY_PLATFORM=ios|android REPLAY_DEVICE=<udid or serial>
 *   REPLAY_PHASE=before|after REPLAY_API=<the API> REPLAY_SERVER_LOG=<its log>
 *   REPLAY_WEBCAM=<the bench camera's RTSPS URL> [REPLAY_TEAM_ID=<iOS team>]
 *   node -r sucrase/register src/app/scoring/fieldSoundsDevice.e2e.ts
 *
 * It signs in as the seed's scorer with a logged code when the app is
 * signed out, opens the seeded game in progress straight in the scorer, and
 * records the camera, with its sound, while the pitches play: scoring-sounds-<name>-<phase>.mp4.
 * The device is never named in this file; it comes from REPLAY_DEVICE.
 */

const APP_ID = 'app.teamstation.app'
const GAME = process.env.REPLAY_GAME ?? 'gam_replaySeedLive'
const PITCH_GAP_MS = 3500

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const SCORER = 'replay-scorer@example.test'

async function main(): Promise<void> {
  const platform = required('REPLAY_PLATFORM')
  assert(['ios', 'android'].includes(platform))
  const phase = required('REPLAY_PHASE')
  const name = platform === 'ios' ? 'iphone' : 'pixel10'
  const daemon = await connect()
  let m: Device | undefined
  try {
    m = await daemon.attach({
      device: required('REPLAY_DEVICE'),
      platform,
      appId: APP_ID,
      artifacts: 'on-failure',
      // An iPhone's driver is signed by a development team.
      ...(process.env.REPLAY_TEAM_ID == null
        ? {}
        : { teamId: process.env.REPLAY_TEAM_ID })
    })
    await m.stopApp({ appId: APP_ID })
    await m.launchApp({ appId: APP_ID })
    await signInPhone(m, SCORER)
    await m.openLink({ link: `teamstation://games/${GAME}/score` })
    await m.assertVisible({ text: 'Ball', timeout: 30000 })
    await shot(m, `scoring-sounds-${name}-${phase}-screen`)
    const video = join(
      await artifactsDir(),
      `scoring-sounds-${name}-${phase}.mp4`
    )
    const camera = recordWebcam(video, 5 + (PITCH_GAP_MS * 3) / 1000 + 2)
    await wait(3000)
    for (const control of ['^Ball$', '^Called Strike$', '^Foul Ball$']) {
      await m.tapOn({ text: control })
      // The wall clock of each pitch, to find its sound in the recording.
      console.log(`${control}: tapped at ${new Date().toISOString()}`)
      await wait(PITCH_GAP_MS)
    }
    await new Promise(resolve => camera.on('exit', resolve))
    console.log(`PASS: ${name} ${phase}: pitches thrown, camera at ${video}`)
  } finally {
    await m?.detach()
    await daemon.shutdown()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
