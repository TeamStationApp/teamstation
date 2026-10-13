import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { join } from 'node:path'

import {
  artifactsDir,
  askForCode,
  connect,
  type Device,
  loggedCode,
  required,
  shot
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

/** The bench camera, with its sound, for `seconds`, into `path`. */
function record(path: string, seconds: number): ChildProcess {
  return spawn(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-tls_verify',
      '0',
      '-timeout',
      '15000000',
      '-i',
      required('REPLAY_WEBCAM'),
      '-t',
      String(seconds),
      '-c',
      'copy',
      '-y',
      path
    ],
    { stdio: 'inherit' }
  )
}

const SCORER = 'replay-scorer@example.test'

const visible = async (
  m: Device,
  text: string,
  timeout = 3000
): Promise<boolean> =>
  await m.assertVisible({ text, timeout }).then(
    () => true,
    () => false
  )

/**
 * Signs in as the seed's scorer with a code from the server's log, whichever
 * way the screen asks for one: a button that sends it, or a code field.
 */
async function signIn(m: Device): Promise<void> {
  if (!(await visible(m, 'Sign in to TeamStation', 8000))) return
  await m.tapOn({ text: 'E-mail address' })
  await m.eraseText({ characters: 60 })
  await m.inputText({ text: SCORER })
  await m.hideKeyboard().catch(() => undefined)
  const code = await loggedCode(SCORER, async () => {
    for (const button of ['Send me a sign-in code', 'E-mail me a code instead'])
      if (await visible(m, button)) {
        await m.tapOn({ text: button })
        return
      }
    await askForCode(SCORER)
  })
  await m.tapOn({ text: '123456' })
  await m.inputText({ text: code })
  await m.hideKeyboard().catch(() => undefined)
  // A full code signs in by itself on some screens.
  if (await visible(m, '^Sign in$')) await m.tapOn({ text: '^Sign in$' })
  // Android keeps the sign-in screen mounted under the next one; the
  // scorer's own controls, asserted next, prove the session.
}

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
    await signIn(m)
    await m.openLink({ link: `teamstation://games/${GAME}/score` })
    await m.assertVisible({ text: 'Ball', timeout: 30000 })
    await shot(m, `scoring-sounds-${name}-${phase}-screen`)
    const video = join(
      await artifactsDir(),
      `scoring-sounds-${name}-${phase}.mp4`
    )
    const camera = record(video, 5 + (PITCH_GAP_MS * 3) / 1000 + 2)
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
