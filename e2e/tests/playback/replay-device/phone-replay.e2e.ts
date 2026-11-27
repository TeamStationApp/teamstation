import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'

import {
  FLOATING_SIZE,
  floatingBottom,
  topLift
} from '../../../../src/app/field/fieldSafeArea'
import type { FixtureManifest } from '../../../core/fixtures'
import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { hasAudio, momentaryLoudness, recordScreen } from '../../../core/video'
import {
  clearSignInLimits,
  serverKeptOnHubPhone
} from '../../../rigs/coach/coachApp'
import { openEventWeb } from '../../../rigs/eventWeb'

/**
 * The replay and the live view in the app on a phone, recorded by maestro-d
 * with the phone's sound where its recording carries any, against the
 * `replay-games` world, signed in as its scorer.
 *
 * - `replay`: open the final game's replay, turn the sound on, pause and
 *   play, watch to the first home run, scroll the box score to the
 *   pitchers, the X. `replay-<phone>.mp4` is the recording;
 *   `crowd-levels.log` has each sentence the card showed, timed from the
 *   recording's start, beside the recording's loudness each second
 *   (FFmpeg's ebur128), so a cheer can be heard rising over the crowd at
 *   its play. A recording with no sound track blocks, once everything on
 *   the screen has been checked.
 * - The live view, the game in progress while a web scorer throws three
 *   pitches, each on the phone within 2.5 s, is `live-view.e2e.ts` and
 *   `live-view-android.e2e.ts`: they need this machine's browser beside the
 *   phone, which only a web surface is given.
 * - `layout`: the scoring screen of the game in progress, then the final
 *   game's replay paused with its box score scrolled to the end, read from
 *   the hierarchy: the volume button at the upper left of both, its top
 *   half a button into the top inset; the X at the replay's upper right; the
 *   box score's last row above rewind and pause; and the buttons centred on
 *   the bottom safe edge (`floatingBottom`). An iPhone's insets are 59 and
 *   34 points, as the bench's iPhone's are; Android's hierarchy is in
 *   pixels, which only the phone's density turns into the layout's points.
 */

/**
 * From opening to past the first home run, with room for the pause: the
 * replay waits for each sentence of the announcer.
 */
const REPLAY_SECONDS = 160

/** An iPhone's top and bottom insets, in points. */
const IPHONE_INSETS = { top: 59, bottom: 34 }

// The phone's maestro-d device, as the app platforms answer it.
type Device = any

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export type PhoneKind = 'teamstation-ios' | 'teamstation-android'

function appKind(ctx: HarnessContext): PhoneKind {
  return ctx.surface === 'android-app'
    ? 'teamstation-android'
    : 'teamstation-ios'
}

/** The phone's name in what a scenario writes. */
const phoneName = (kind: PhoneKind): string =>
  kind === 'teamstation-android' ? 'android' : 'iphone'

/** The app, cleared, pointed at the stack, and signed in as the scorer. */
async function openApp(
  ctx: HarnessContext,
  kind: PhoneKind = appKind(ctx)
): Promise<{ m: Device; world: FixtureManifest }> {
  const world = await ctx.fixture('replay-games')
  const appId = ctx.app(kind)
  const m = ctx.attached('device')
  await clearSignInLimits(ctx)
  await m.launchApp({ appId, clearState: true })
  // A clear forgets the server: the link points the app back at the stack.
  await serverKeptOnHubPhone(m, appId, ctx.stack.origin)
  await ctx.signIn('scorer', m)
  return { m, world }
}

const visible = async (
  m: Device,
  text: string,
  timeout = 3000
): Promise<boolean> =>
  await m.assertVisible({ text, timeout }).then(
    () => true,
    () => false
  )

async function shot(
  ctx: HarnessContext,
  m: Device,
  name: string
): Promise<void> {
  await m.takeScreenshot({ path: ctx.artifact(`${name}.png`) })
}

/** A sentence the card showed, seconds into the recording. */
interface Shown {
  at: number
  text: string
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

/** What the phone shows, flattened. iOS reports points. */
async function nodes(m: Device): Promise<Node[]> {
  return flatten((await m.hierarchy()) as Node)
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
  const { seconds, summary } = momentaryLoudness(video)
  return [
    `$ ffmpeg -nostdin -i ${basename(video)} -vn -af ebur128 -f null -`,
    '# second  momentary LUFS  sentence shown in that second',
    ...[...seconds].map(([second, loudness]) => {
      const said = shown.filter(line => Math.floor(line.at) === second)
      return `${String(second).padStart(6)}s  ${loudness.padStart(7)}  ${said.map(line => line.text).join(' | ')}`
    }),
    summary
  ].join('\n')
}

async function replay(ctx: HarnessContext): Promise<void> {
  const { m, world } = await openApp(ctx)
  const name = phoneName(appKind(ctx))
  await m.openLink({
    link: `teamstation://games/${world.ids.finalGame}/replay`
  })
  await m.assertVisible({ id: 'replay-pause', timeout: 30000 })
  const shown: Shown[] = []
  const recorded = await recordScreen(
    m,
    ctx.runDir,
    `replay-${name}`,
    async () => {
      const started = Date.now()
      await m.tapOn({ id: 'replay-speaker' })
      await m.assertVisible({ text: 'Mute game sounds', timeout: 5000 })
      await shot(ctx, m, `replay-${name}-open`)
      await watchLines(m, started, shown, 25000)
      await m.tapOn({ id: 'replay-pause' })
      await m.assertVisible({ text: 'Paused', timeout: 5000 })
      await shot(ctx, m, `replay-${name}-paused`)
      await wait(5000)
      await m.tapOn({ id: 'replay-pause' })
      // The first home run comes a minute or two in, with the announcer on.
      assert.ok(
        await watchLines(
          m,
          started,
          shown,
          Math.max(
            5000,
            REPLAY_SECONDS * 1000 - 15000 - (Date.now() - started)
          ),
          text => /home run|grand slam/i.test(text)
        ),
        'no home run'
      )
      await shot(ctx, m, `replay-${name}-home-run`)
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
      await shot(ctx, m, `replay-${name}-box-pitchers`)
      // The recording runs as long as the camera's did.
      await wait(Math.max(0, REPLAY_SECONDS * 1000 - (Date.now() - started)))
    }
  )
  await m.tapOn({ id: 'replay-exit' })
  assert.ok(await visible(m, 'Box score', 10000), 'the X did not show the game')
  if (!hasAudio(recorded.file)) {
    throw new BlockedError(
      `maestro-d's recording of the ${name} carries no sound, so the announcer, the idle crowd and its cheers cannot be measured (everything on the screen passed)`
    )
  }
  writeFileSync(
    ctx.artifact('crowd-levels.log'),
    `${crowdLevels(recorded.file, shown)}\n`
  )
}

/**
 * The live view on the phone in `kind`'s app while a web scorer, in this
 * run's browser, throws three pitches (`live-view.e2e.ts` and
 * `live-view-android.e2e.ts` run it, each on a web surface with the phone).
 */
export async function liveView(
  ctx: HarnessContext,
  kind: PhoneKind
): Promise<number[]> {
  const { m, world } = await openApp(ctx, kind)
  const name = phoneName(kind)
  const scorerWeb = await openEventWeb(ctx, world.accounts.scorer, {
    width: 402,
    height: 874
  })
  const scorer = scorerWeb.m
  try {
    await scorerWeb.go(`/games/${world.ids.inProgressGame}/score`)
    await scorer.assertVisible({ text: 'Ball', timeout: 30000 })
    await m.openLink({
      link: `teamstation://games/${world.ids.inProgressGame}/replay`
    })
    await m.assertVisible({ id: 'replay-pause', timeout: 30000 })
    const lags: string[] = []
    const lagsMs: number[] = []
    await recordScreen(m, ctx.runDir, `live-${name}`, async () => {
      await wait(4000)
      // Each pitch, timed from the scorer's tap until the phone's screen
      // changes. A screenshot is taken at once; a text query on iOS first
      // waits for the app to be idle, which a 3D field never quite is.
      const looks = async (): Promise<string> =>
        createHash('sha1')
          .update(await m.screenshot())
          .digest('hex')
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
        lagsMs.push(lag)
        lags.push(
          `${control}: the phone's screen changed ${lag} ms after the tap`
        )
        assert.ok(lag < 2500, `${control} took ${lag} ms`)
        await m.assertVisible({ text: `${card}.*`, timeout: 15000 })
        await shot(
          ctx,
          m,
          `live-${name}-${control.toLowerCase().replace(' ', '-')}`
        )
        await wait(3000)
      }
    })
    writeFileSync(ctx.artifact(`live-${name}.log`), `${lags.join('\n')}\n`)
    await m.tapOn({ id: 'replay-exit' })
    return lagsMs
  } finally {
    await scorerWeb.session.close()
  }
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

async function layout(ctx: HarnessContext): Promise<void> {
  if (ctx.surface === 'android-app') {
    throw new BlockedError(
      "Android's hierarchy is in pixels, and maestro-d reports no display density to turn them into the layout's points"
    )
  }
  const { m, world } = await openApp(ctx)
  const platform = 'ios'
  const kind = phoneName(appKind(ctx))
  const { top, bottom } = IPHONE_INSETS
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
    // Lifted half a button into the inset on an iPhone.
    near(
      button.y,
      Math.max(8, top - topLift(top, platform)),
      `its top ${where}`
    )
  }

  await m.openLink({
    link: `teamstation://games/${world.ids.inProgressGame}/score`
  })
  await m.assertVisible({ text: 'Ball', timeout: 30000 })
  await wait(3000)
  await shot(ctx, m, `scoring-volume-${kind}`)
  const scoring = await nodes(m)
  volumeTop(boundsOf(scoring, sound), 'on the scoring screen')

  await m.openLink({
    link: `teamstation://games/${world.ids.finalGame}/replay`
  })
  await m.assertVisible({ id: 'replay-pause', timeout: 30000 })
  await m.tapOn({ id: 'replay-pause' })
  await m.assertVisible({ text: 'Paused', timeout: 5000 })
  for (let i = 0; i < 12; i++)
    await m.swipe({ start: '50%, 90%', end: '50%, 62%' })
  await wait(1000)
  await shot(ctx, m, `replay-layout-${kind}`)
  const replayed = await nodes(m)
  // The largest node is the screen.
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
  writeFileSync(
    ctx.artifact(`layout-${kind}.log`),
    `layout on ${kind}: volume ${JSON.stringify(speaker)}, X ${JSON.stringify(exit)}, last row ${last}, buttons ${Math.min(rewind.y, pause.y)}\n`
  )
  assert.ok(
    last <= Math.min(rewind.y, pause.y),
    'the box score’s last row runs under the buttons'
  )
}

export default defineHarness({
  id: 'playback/replay-device/phone-replay',
  title:
    'The replay and the live view play on a phone, with sound, laid out on its safe area',
  kind: 'e2e',
  covers: [
    'src/app/replay/**',
    'src/app/field/fieldSafeArea.ts',
    'src/app/scoring/ScoringScreen.tsx'
  ],
  stack: 'isolated',
  fixtures: ['replay-games'],
  exclusive: false,
  surfaces: {
    // The replay draws in 3D (gpu) and is heard through the phone's own
    // speaker: a physical phone, never a simulator. The live view, which
    // needs a web scorer beside the phone, is `live-view.e2e.ts`.
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
  minutes: 8,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    replay,
    layout
  }
})
