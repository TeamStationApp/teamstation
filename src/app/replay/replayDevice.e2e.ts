import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { FLOATING_SIZE, floatingBottom, topLift } from '../field/fieldSafeArea'
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
 *   [REPLAY_APP_ID=<the build's app id: app.teamstation.develop for a
 *   development build, app.teamstation.app by default>]
 *   REPLAY_API, REPLAY_SERVER_LOG, REPLAY_WEB_URL, REPLAY_ARTIFACTS, MAESTRO_D
 *   node -r sucrase/register src/app/replay/replayDevice.e2e.ts
 *
 * The replay: open the final game's replay, turn the sound on, pause
 * and play, watch to the first home run, scroll the box score to the
 * pitchers, the X. replay-<phone>-webcam.mp4 has the camera and its sound:
 * the announcer, the idle crowd and its cheers. crowd-levels.log has each
 * sentence the card showed, timed from the recording's start, and the
 * recording's loudness (FFmpeg's ebur128), each second's beside them, so a
 * cheer can be heard rising over the crowd at its play.
 *
 * The live view: open the game in progress while a web scorer throws three
 * pitches; each shows on the phone. live-<phone>-webcam.mp4.
 *
 * The layout (REPLAY_PARTS=layout, run alone): the scoring screen of the
 * game in progress, then the final game's replay paused with its box score
 * scrolled to the end, read from the hierarchy: the white volume button at
 * the upper left of both, its top half a button into the top inset; the X at
 * the replay's upper right; the box score's last row above rewind and pause;
 * and the buttons centred on the bottom safe edge (`floatingBottom`). The
 * insets are the phone's, in points: REPLAY_TOP_INSET and REPLAY_BOTTOM_INSET, an
 * iPhone's 59 and 34 by default; on Android, without them, only the order of
 * things is checked. On Android, REPLAY_DENSITY turns the hierarchy's pixels
 * into points. scoring-volume-<kind>.png and replay-layout-<kind>.png.
 *
 * The device is never named in this file; it comes from REPLAY_DEVICE.
 */

const APP_ID = process.env.REPLAY_APP_ID ?? 'app.teamstation.app'
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

/** A sentence the card showed, seconds into the camera's recording. */
interface Shown {
  at: number
  text: string
}

/**
 * Reads the card's newest line until `until` holds for it or `ms` pass,
 * noting each new one against the recording's start.
 */
async function watchLines(
  m: Device,
  recording: number,
  shown: Shown[],
  ms: number,
  until: (text: string) => boolean = () => false
): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const line = (await nodes(m)).find(
      node => node.id === 'replay-play-card-line'
    )
    const text = line?.text ?? line?.accessibilityText ?? ''
    if (text !== '' && text !== shown.at(-1)?.text)
      shown.push({ at: (Date.now() - recording) / 1000, text })
    if (until(text)) return true
    await wait(300)
  }
  return false
}

/**
 * The recording's loudness beside the sentences: FFmpeg's ebur128 momentary
 * loudness each second, the sentence the card had just shown on its line.
 */
function crowdLevels(video: string, shown: readonly Shown[]): string {
  const measured = spawnSync(
    'ffmpeg',
    ['-nostdin', '-i', video, '-vn', '-af', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8' }
  )
  assert.equal(measured.status, 0, 'ffmpeg measured nothing')
  const seconds = new Map<number, string>()
  for (const match of measured.stderr.matchAll(
    /t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+|-inf)/g
  )) {
    const second = Math.floor(Number(match[1]))
    if (!seconds.has(second)) seconds.set(second, match[2])
  }
  const summary = /Summary:[\s\S]*$/.exec(measured.stderr)?.[0] ?? ''
  return [
    `$ ffmpeg -nostdin -i ${basename(video)} -vn -af ebur128 -f null -`,
    '# second  momentary LUFS  sentence shown in that second',
    ...[...seconds].map(([second, loudness]) => {
      const said = shown.filter(line => Math.floor(line.at) === second)
      return `${String(second).padStart(6)}s  ${loudness.padStart(7)}  ${said.map(line => line.text).join(' | ')}`
    }),
    summary.trim()
  ].join('\n')
}

async function replay(m: Device, name: string): Promise<void> {
  await m.openLink({ link: `teamstation://games/${FINAL}/replay` })
  await m.assertVisible({ id: 'replay-pause', timeout: 30000 })
  const video = join(await artifactsDir(), `replay-${name}-webcam.mp4`)
  const camera = filming(video, REPLAY_SECONDS)
  const started = Date.now()
  const shown: Shown[] = []
  await m.tapOn({ id: 'replay-speaker' })
  await m.assertVisible({ text: 'Mute game sounds', timeout: 5000 })
  await shot(m, `replay-${name}-open`)
  await watchLines(m, started, shown, 25000)
  await m.tapOn({ id: 'replay-pause' })
  await m.assertVisible({ text: 'Paused', timeout: 5000 })
  await shot(m, `replay-${name}-paused`)
  await wait(5000)
  await m.tapOn({ id: 'replay-pause' })
  // The first home run comes a minute or two in, with the announcer on.
  assert.ok(
    await watchLines(
      m,
      started,
      shown,
      Math.max(5000, REPLAY_SECONDS * 1000 - 15000 - (Date.now() - started)),
      text => /home run|grand slam/i.test(text)
    ),
    'no home run'
  )
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
  await writeFile(
    join(await artifactsDir(), 'crowd-levels.log'),
    `${crowdLevels(video, shown)}\n`
  )
  await m.tapOn({ id: 'replay-exit' })
  assert.ok(await visible(m, 'Box score', 10000), 'the X did not show the game')
  console.log(`replay on ${name}: camera at ${video}`)
}

interface Node {
  id?: string
  text?: string
  accessibilityText?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
type Bounds = NonNullable<Node['bounds']>
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

/**
 * Pixels to the layout's points: Android's hierarchy is in pixels, so
 * REPLAY_DENSITY (`adb shell wm density` / 160) turns it into the dp the
 * layout is written in. iOS reports points already.
 */
const DENSITY = Number(process.env.REPLAY_DENSITY ?? 1)
const inPoints = (node: Node): Node =>
  node.bounds == null
    ? node
    : {
        ...node,
        bounds: {
          x: node.bounds.x / DENSITY,
          y: node.bounds.y / DENSITY,
          width: node.bounds.width / DENSITY,
          height: node.bounds.height / DENSITY
        }
      }

/** What the phone shows, flattened, in points, with the screen's own size first. */
async function nodes(m: Device): Promise<Node[]> {
  return flatten((await m.hierarchy()) as Node).map(inPoints)
}
function boundsOf(all: Node[], match: (node: Node) => boolean): Bounds {
  const found = all.find(node => node.bounds != null && match(node))?.bounds
  assert.ok(found != null, 'not on the screen')
  return found
}
const labelled =
  (...labels: string[]) =>
  (node: Node): boolean =>
    labels.some(
      label => node.accessibilityText === label || node.text === label
    )

async function layout(m: Device, platform: string): Promise<void> {
  const kind = platform === 'ios' ? 'iphone' : 'android'
  const inset = (key: string, ios: number): number | undefined => {
    const value = process.env[key]
    return value != null ? Number(value) : platform === 'ios' ? ios : undefined
  }
  const top = inset('REPLAY_TOP_INSET', 59)
  const bottom = inset('REPLAY_BOTTOM_INSET', 34)
  const near = (actual: number, expected: number, what: string): void => {
    assert.ok(
      Math.abs(actual - expected) <= 1,
      `${what}: ${actual}, not ${expected}`
    )
  }
  const sound = labelled('Mute game sounds', 'Unmute game sounds')
  const volumeTop = (button: Bounds, where: string): void => {
    assert.ok(button.x < 60, `the volume button is not at the left ${where}`)
    near(button.width, 48, `the volume button's width ${where}`)
    // Lifted half a button into the inset on an iPhone; just below the
    // status bar, max(8, inset), on Android.
    if (top != null)
      near(
        button.y,
        Math.max(8, top - topLift(top, platform)),
        `its top ${where}`
      )
  }

  await m.openLink({ link: `teamstation://games/${LIVE}/score` })
  await m.assertVisible({ text: 'Ball', timeout: 30000 })
  await wait(3000)
  await shot(m, `scoring-volume-${kind}`)
  const scoring = await nodes(m)
  volumeTop(boundsOf(scoring, sound), 'on the scoring screen')

  await m.openLink({ link: `teamstation://games/${FINAL}/replay` })
  await m.assertVisible({ id: 'replay-pause', timeout: 30000 })
  await m.tapOn({ id: 'replay-pause' })
  await m.assertVisible({ text: 'Paused', timeout: 5000 })
  for (let i = 0; i < 12; i++)
    await m.swipe({ start: '50%, 90%', end: '50%, 62%' })
  await wait(1000)
  await shot(m, `replay-layout-${kind}`)
  const replayed = await nodes(m)
  // The largest node is the screen: Android's root has no bounds, and the
  // app's window can stop above the navigation bar the buttons sit on.
  const screen = replayed
    .flatMap(node => (node.bounds == null ? [] : [node.bounds]))
    .reduce<Bounds | undefined>(
      (largest, bounds) =>
        largest == null ||
        bounds.width * bounds.height > largest.width * largest.height
          ? bounds
          : largest,
      undefined
    )
  assert.ok(screen != null, 'the screen has no size')
  const byId = (id: string) => (node: Node) => node.id === id
  const speaker = boundsOf(replayed, byId('replay-speaker'))
  volumeTop(speaker, 'on the replay')
  const exit = boundsOf(replayed, byId('replay-exit'))
  assert.ok(
    exit.x + exit.width > screen.width - 60,
    'the X is not at the right'
  )
  near(exit.y, speaker.y, "the X's top")
  const rewind = boundsOf(replayed, byId('replay-rewind'))
  const pause = boundsOf(replayed, byId('replay-pause'))
  assert.ok(rewind.x < screen.width / 2, 'rewind is not at the left')
  assert.ok(pause.x > screen.width / 2, 'pause is not at the right')
  for (const [name, button] of [
    ['rewind', rewind],
    ['pause', pause]
  ] as const) {
    near(button.height, FLOATING_SIZE, `${name}'s size`)
    assert.ok(
      button.y + button.height <= screen.height,
      `${name} runs off the screen`
    )
    if (bottom != null)
      near(
        screen.height - (button.y + button.height),
        floatingBottom(bottom, platform),
        `${name}'s distance from the bottom`
      )
  }
  // The box score's last row: the lowest text inside it, not counting the
  // glyphs of the buttons drawn over it.
  const box = boundsOf(replayed, byId('replay-box-score'))
  const within = (inner: Bounds, outer: Bounds): boolean =>
    inner.y >= outer.y && inner.y + inner.height <= outer.y + outer.height
  const rows = replayed.filter(
    node =>
      node.bounds != null &&
      (node.text ?? '') !== '' &&
      within(node.bounds, box) &&
      !within(node.bounds, rewind) &&
      !within(node.bounds, pause)
  )
  const last = Math.max(
    ...rows.map(node => node.bounds!.y + node.bounds!.height)
  )
  console.log(
    `layout on ${kind}: volume ${JSON.stringify(speaker)}, X ${JSON.stringify(exit)}, last row ${last}, buttons ${Math.min(rewind.y, pause.y)}`
  )
  assert.ok(
    last <= Math.min(rewind.y, pause.y),
    'the box score’s last row runs under the buttons'
  )
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
    await m.tapOn({ id: 'replay-exit' })
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
    if (parts.includes('layout')) await layout(m, platform)
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
