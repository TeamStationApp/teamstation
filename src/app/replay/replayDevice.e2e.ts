import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  artifactsDir,
  attachWeb,
  connect,
  type Device,
  recordWebcam,
  required,
  shot,
  signInPhone,
  signInWeb,
  visible
} from './kit.e2e'

/**
 * The replay and the live view on a phone, filmed by the bench webcam with
 * its sound. Run against a server with the replay seed loaded (re-seeded
 * first, so the game in progress starts where the seed left it), on a build
 * pointed at it:
 *
 *   REPLAY_PLATFORM=ios|android REPLAY_DEVICE=<udid or serial>
 *   REPLAY_WEBCAM=<the bench camera's RTSPS URL> [REPLAY_TEAM_ID=<iOS team>]
 *   REPLAY_API, REPLAY_SERVER_LOG, REPLAY_WEB_URL, REPLAY_ARTIFACTS, MAESTRO_D
 *   node -r sucrase/register src/app/replay/replayDevice.e2e.ts
 *
 * The replay: open the final game's replay, turn the announcer on, pause
 * and play, watch to the first home run, scroll the box score to the
 * pitchers, Exit. replay-<phone>-webcam.mp4 has the camera and its sound.
 *
 * The live view: open the game in progress while a web scorer throws three
 * pitches; each shows on the phone. live-<phone>-webcam.mp4.
 *
 * The device is never named in this file; it comes from REPLAY_DEVICE.
 */

const APP_ID = 'app.teamstation.app'
const FINAL = process.env.REPLAY_FINAL ?? 'gam_replaySeedFinal'
const LIVE = process.env.REPLAY_LIVE ?? 'gam_replaySeedLive'
const VIEWER = 'replay-scorer@example.test'
const SCORER = 'replay-scorer@example.test'
/**
 * From opening to past the first home run, with room for the pause: the
 * replay waits for each sentence of the announcer.
 */
const REPLAY_SECONDS = 160

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * The camera, recording; `done` settles when it has finished, however long
 * the test takes to ask.
 */
function filming(path: string, seconds: number): { done: Promise<unknown> } {
  const camera = recordWebcam(path, seconds)
  return { done: new Promise(resolve => camera.on('exit', resolve)) }
}

async function replay(m: Device, name: string): Promise<void> {
  await m.openLink({ link: `teamstation://games/${FINAL}/replay` })
  await m.assertVisible({ id: 'replay-pause', timeout: 30000 })
  const video = join(await artifactsDir(), `replay-${name}-webcam.mp4`)
  const camera = filming(video, REPLAY_SECONDS)
  const started = Date.now()
  await m.tapOn({ id: 'replay-speaker' })
  await m.assertVisible({ text: 'Turn announcer off', timeout: 5000 })
  await shot(m, `replay-${name}-open`)
  await wait(25000)
  await m.tapOn({ id: 'replay-pause' })
  await m.assertVisible({ text: 'Paused', timeout: 5000 })
  await shot(m, `replay-${name}-paused`)
  await wait(5000)
  await m.tapOn({ id: 'replay-pause' })
  // The first home run comes a minute or two in, with the announcer on.
  await m.assertVisible({
    text: '.*(home run|grand slam).*',
    timeout: Math.max(
      5000,
      REPLAY_SECONDS * 1000 - 15000 - (Date.now() - started)
    )
  })
  await shot(m, `replay-${name}-home-run`)
  // Scrolls the box score itself, which fills the lower part of the screen.
  for (
    let i = 0;
    i < 8 && !(await visible(m, 'Valley Pines pitching', 1000));
    i++
  )
    await m.swipe({ start: '30%, 90%', end: '30%, 62%' })
  assert.ok(
    await visible(m, 'Valley Pines pitching'),
    'no pitchers in the box score'
  )
  await shot(m, `replay-${name}-box-pitchers`)
  await camera.done
  await m.tapOn({ text: 'Exit' })
  assert.ok(await visible(m, 'Box score', 10000), 'Exit did not show the game')
  console.log(`replay on ${name}: camera at ${video}`)
}

async function live(
  m: Device,
  name: string,
  daemon: Parameters<typeof attachWeb>[0]
): Promise<void> {
  const scorer = await attachWeb(daemon, '402x874', 'scorer')
  try {
    await signInWeb(scorer, SCORER)
    await scorer.openBrowser({
      url: `${required('REPLAY_WEB_URL')}/games/${LIVE}/score`
    })
    await scorer.assertVisible({ text: 'Ball', timeout: 30000 })
    await m.openLink({ link: `teamstation://games/${LIVE}/replay` })
    await m.assertVisible({ id: 'replay-pause', timeout: 30000 })
    const video = join(await artifactsDir(), `live-${name}-webcam.mp4`)
    const camera = filming(video, 30)
    await wait(4000)
    // Each pitch, timed from the scorer's tap until the phone's screen
    // changes. A screenshot is taken at once; a text query on iOS first waits
    // for the app to be idle, which a 3D field never quite is.
    const looks = async (): Promise<string> =>
      createHash('sha1')
        .update(await m.screenshot())
        .digest('hex')
    const lags: string[] = []
    for (const [control, card] of [
      ['Ball', 'Ball two'],
      ['Called Strike', 'Called strike one'],
      ['Foul Ball', 'Foul ball']
    ]) {
      const still = await looks()
      await scorer.tapOn({
        css: `:is(button, [role="button"])[aria-label=${JSON.stringify(control)}]`
      })
      const tapped = Date.now()
      while ((await looks()) === still && Date.now() - tapped < 15000);
      const lag = Date.now() - tapped
      lags.push(
        `${control}: the phone's screen changed ${lag} ms after the tap`
      )
      console.log(lags.at(-1))
      assert.ok(lag < 2500, `${control} took ${lag} ms`)
      await m.assertVisible({ text: `${card}.*`, timeout: 15000 })
      await shot(m, `live-${name}-${control.toLowerCase().replace(' ', '-')}`)
      await wait(3000)
    }
    await writeFile(
      join(await artifactsDir(), `live-${name}.log`),
      `$ REPLAY_PARTS=live node -r sucrase/register src/app/replay/replayDevice.e2e.ts   # ${name}\n${lags.join('\n')}\n`
    )
    await camera.done
    await m.tapOn({ text: 'Exit' })
    console.log(`live on ${name}: camera at ${video}`)
  } finally {
    await scorer.detach()
  }
}

async function main(): Promise<void> {
  const platform = required('REPLAY_PLATFORM')
  assert(['ios', 'android'].includes(platform))
  const name = platform === 'ios' ? 'iphone13pro' : 'pixel10'
  const daemon = await connect()
  let m: Device | undefined
  try {
    m = await daemon.attach({
      device: required('REPLAY_DEVICE'),
      platform,
      appId: APP_ID,
      artifacts: 'on-failure',
      ...(process.env.REPLAY_TEAM_ID == null
        ? {}
        : { teamId: process.env.REPLAY_TEAM_ID })
    })
    await m.stopApp({ appId: APP_ID })
    await m.launchApp({ appId: APP_ID })
    await signInPhone(m, VIEWER)
    const parts = (process.env.REPLAY_PARTS ?? 'replay,live').split(',')
    if (parts.includes('replay')) await replay(m, name)
    if (parts.includes('live')) await live(m, name, daemon)
    console.log(`PASS: ${name}`)
  } finally {
    await m?.detach()
    await daemon.shutdown()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
