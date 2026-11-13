import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'

import {
  DEFAULT_PRIVACY_LABEL,
  PLAYER_NAME_PRIVACY_LABELS,
  PLAYER_NAME_PRIVACY_STOPS
} from '../common/playerNamePrivacy'
import {
  pickerWheels,
  turnWheel,
  wheelAt,
  type WheelNode,
  wheelValue
} from '../test/iosWheel.e2e'
import type { NativeWheelManifest } from '../test/nativeWheelFixture.e2e'
import {
  browserSession,
  maestro,
  type MaestroHandle
} from '../test/refinementsMaestro.e2e'

/**
 * The pop-up wheel on every surface, driven by maestro-d against
 * `src/test/nativeWheelFixture.e2e.ts` (issue 245):
 *
 * - `ios-app` — the player-name privacy pop-up is one native `PickerWheel`
 *   and the time pop-up three (hour, minute, period); the value each stops on
 *   is saved (E1–E3).
 * - `ios-safari` — the time pop-up is Safari's native time wheel, its minute
 *   rounded down to five (E5); the single-column privacy pop-up keeps the
 *   scrolling column, which Safari cannot present as a wheel (E4).
 * - `android-app` and `chromium` — both keep the scrolling column (E6, E7).
 *
 * `TS_WHEEL_BEFORE=1` only opens the pop-ups this change alters on that
 * surface and photographs them, for the base branch's before screenshots.
 *
 *   TS_WHEEL_SURFACE=ios-app|ios-safari|android-app|chromium \
 *     TS_WHEEL_DEVICE=<id> TS_WHEEL_MANIFEST=<file> TS_WHEEL_ARTIFACTS=<dir> \
 *     MAESTRO_D_BIN=... TS_MAESTRO_D_CLIENT=... \
 *     node -r sucrase/register src/app/nativeWheel.e2e.ts
 *
 * Device ids come from the environment and are never written down.
 */
type Surface = 'ios-app' | 'ios-safari' | 'android-app' | 'chromium'
const SURFACES: readonly Surface[] = [
  'ios-app',
  'ios-safari',
  'android-app',
  'chromium'
]

const privacyLabels = PLAYER_NAME_PRIVACY_STOPS.map(value =>
  value == null ? DEFAULT_PRIVACY_LABEL : PLAYER_NAME_PRIVACY_LABELS[value]
)
const twoDigits = (n: number): string => String(n).padStart(2, '0')
const HOURS = Array.from({ length: 12 }, (_, i) => twoDigits(i + 1))
const MINUTES = Array.from({ length: 12 }, (_, i) => twoDigits(i * 5))
const PERIODS = ['AM', 'PM']
const SAFARI_HOURS = Array.from({ length: 12 }, (_, i) => `${i + 1} o’clock`)
// Safari reads its minutes two digits wide: `00 minutes`, `01 minute`,
// `02 minutes` … `59 minutes`.
const SAFARI_MINUTES = Array.from(
  { length: 60 },
  (_, i) => `${twoDigits(i)} ${i === 1 ? 'minute' : 'minutes'}`
)

async function main(): Promise<void> {
  const surface = process.env.TS_WHEEL_SURFACE as Surface
  const device = process.env.TS_WHEEL_DEVICE
  const manifestFile = process.env.TS_WHEEL_MANIFEST
  const out = process.env.TS_WHEEL_ARTIFACTS
  if (
    !SURFACES.includes(surface) ||
    device == null ||
    manifestFile == null ||
    out == null
  )
    throw new Error(
      'Supply TS_WHEEL_SURFACE, TS_WHEEL_DEVICE, TS_WHEEL_MANIFEST and TS_WHEEL_ARTIFACTS'
    )
  const before = process.env.TS_WHEEL_BEFORE === '1'
  const manifest = JSON.parse(
    await readFile(manifestFile, 'utf8')
  ) as NativeWheelManifest
  await mkdir(out, { recursive: true })
  const note = async (line: string): Promise<void> => {
    await appendFile(join(out, 'nativeWheel-e2e.log'), `${line}\n`)
    console.log(line)
  }
  const daemon = await maestro(
    process.env.MAESTRO_D ?? `nativeWheel-${process.pid}`
  )
  const appId =
    surface === 'ios-app'
      ? 'app.teamstation.app'
      : surface === 'android-app'
        ? 'app.teamstation.app.privacy'
        : 'com.apple.mobilesafari'
  const session =
    surface === 'chromium'
      ? await browserSession(daemon, device, 1280, 900, out)
      : undefined
  const m: MaestroHandle =
    session != null
      ? session.m
      : await daemon.attach({
          device,
          platform: surface === 'android-app' ? 'android' : 'ios',
          appId,
          noAppInstall: true,
          driverStartTimeout: 180
        })
  const browser = surface === 'ios-safari' || surface === 'chromium'
  const nodes = async (): Promise<WheelNode> =>
    (await m.hierarchy()) as WheelNode
  const flat = (
    node: WheelNode & { id?: string }
  ): Array<WheelNode & { id?: string }> => [
    node,
    ...(node.children ?? []).flatMap(flat)
  ]
  const ids = async (prefix: string): Promise<string[]> =>
    flat(await nodes())
      .map(node => node.id ?? '')
      .filter(id => id.startsWith(prefix))
  const show = async (text: string, timeout = 30000): Promise<void> => {
    await m.assertVisible({ text, timeout })
  }
  const tap = async (text: string): Promise<void> => {
    await m.tapOn({ text, timeout: 20000 })
  }
  const tapId = async (id: string): Promise<void> => {
    await m.tapOn(
      surface === 'chromium'
        ? { css: `[data-testid="${id}"]`, timeout: 20000 }
        : { id, timeout: 20000 }
    )
  }
  const shot = async (name: string): Promise<void> => {
    await m.waitForAnimationToEnd()
    await writeFile(join(out, name), await m.screenshot())
    await note(`  screenshot ${name}`)
  }
  const open = async (path: string, text: string): Promise<void> => {
    if (browser)
      await m.openLink({ link: `${manifest.origin}/${path}`, browser: true })
    else if (surface === 'ios-app')
      await m.openLink({ link: `teamstation://${path}` })
    else
      execFileSync('adb', [
        '-s',
        device,
        'shell',
        'am',
        'start',
        '-a',
        'android.intent.action.VIEW',
        '-p',
        appId,
        '-d',
        `teamstation://${path}`
      ])
    await m.tapOn({ text: 'Open', optional: true, timeout: 2000 })
    await m.scrollUntilVisible({ element: { text }, timeout: 30000 })
  }
  const signIn = async (): Promise<void> => {
    const signedIn = await m
      .assertVisible({ text: 'Account, .*', timeout: 8000 })
      .then(
        () => true,
        () => false
      )
    if (signedIn) return
    await tap('E-mail address')
    // A phone's keyboard can drop a key: type until the field reads it.
    for (let attempt = 0; ; attempt++) {
      await m.inputText({ text: manifest.email })
      if (browser) break
      const typed = await m
        .assertVisible({ text: manifest.email, timeout: 3000 })
        .then(
          () => true,
          () => false
        )
      if (typed) break
      if (attempt === 2) throw new Error('The e-mail address would not type')
      await m.eraseText({ characters: 40 })
    }
    if (!browser) await m.hideKeyboard()
    await m.tapOn({ text: 'Send me a sign-in code', optional: true })
    await show('Sign-in code')
    let code: string | null = null
    for (let waited = 0; code == null && waited < 15; waited++) {
      const answer = await fetch(
        `${manifest.control}/code?email=${encodeURIComponent(manifest.email)}`
      )
      code = ((await answer.json()) as { code: string | null }).code
      if (code == null) await new Promise(resolve => setTimeout(resolve, 1000))
    }
    if (code == null) throw new Error('No sign-in code was sent')
    await tap('Sign-in code')
    await m.inputText({ text: code })
    if (!browser) await m.hideKeyboard()
    await m.tapOn({ text: 'Sign in', optional: true })
    await show('Account, .*', 45000)
  }
  const SETTINGS = `groups/team/${manifest.teamId}/settings`
  const CREATE_GAME = `groups/team/${manifest.teamId}/create-game`

  try {
    await note(
      `$ TS_WHEEL_SURFACE=${surface}${before ? ' TS_WHEEL_BEFORE=1' : ''} node -r sucrase/register src/app/nativeWheel.e2e.ts`
    )
    if (browser) await open('', 'E-mail address|Account, .*')
    else await m.launchApp()
    await signIn()

    // The player-name privacy pop-up: one column.
    if (!before || surface === 'ios-app') {
      await open(SETTINGS, 'Player Name Privacy')
      await tap('Player Name Privacy.*')
      await show('Show players as')
    }
    if (before) {
      if (surface === 'ios-app') {
        await shot('ios-app-privacy-before.png')
        await tap('Cancel')
      }
    } else if (surface === 'ios-app') {
      const wheels = pickerWheels(await nodes())
      expect(wheels.length, 'one native wheel').equals(1)
      await note(`  the app wheel reads ${JSON.stringify(wheels[0].text)}`)
      expect(wheelValue(wheels[0], privacyLabels)).equals(DEFAULT_PRIVACY_LABEL)
      expect(await ids('player-name-privacy-')).deep.equals([])
      await shot('ios-app-privacy-after.png')
      await note('E1 the privacy pop-up is one native PickerWheel at Default')
      await turnWheel(
        m,
        async () => await wheelAt(m),
        privacyLabels[2],
        privacyLabels
      )
      await tap('Use')
      await show(privacyLabels[2])
      await tap('Player Name Privacy.*')
      await show('Show players as')
      expect(wheelValue(await wheelAt(m), privacyLabels)).equals(
        privacyLabels[2]
      )
      await tap('Cancel')
      await note(`E2 the wheel stopped on ${privacyLabels[2]}, Use saved it`)
    } else {
      expect(pickerWheels(await nodes()), 'no native wheel').deep.equals([])
      if (surface === 'ios-safari') {
        // Safari publishes neither test ids nor the column's rows: the column
        // is one adjustable element named for its value, and a tap one row
        // below the band chooses the next row.
        for (const stop of [1, 2]) {
          const column = flat(await nodes()).find(
            node => node.text === `Show players as: ${privacyLabels[stop - 1]}`
          )?.bounds
          if (column == null) throw new Error('Missing the scrolling column')
          await m.tapOn({
            point: `${Math.round(column.x + column.width / 2)},${Math.round(column.y + column.height / 2 + 44)}`
          })
          await show(`Show players as: ${privacyLabels[stop]}`)
        }
        await shot('ios-safari-privacy.png')
      } else {
        // Only the rows beside the band are in view: one row at a time.
        await tapId('player-name-privacy-1')
        await tapId('player-name-privacy-2')
      }
      await tap('Use')
      await show(privacyLabels[2])
      await note(
        `${surface === 'ios-safari' ? 'E4' : surface === 'android-app' ? 'E6' : 'E7'} the privacy pop-up keeps the scrolling column; ${privacyLabels[2]} saved`
      )
    }

    // The time pop-up: hour, minute and period.
    await open(CREATE_GAME, 'TIME')
    if (surface === 'ios-safari') await tap('^Start time: .*$')
    else await tapId('event-schedule-time')
    await show('Choose time')
    if (before) {
      await shot(`${surface}-time-before.png`)
      await tap('Cancel')
      await note(`before: ${surface} pop-ups photographed`)
      return
    }
    if (surface === 'ios-app') {
      const wheels = pickerWheels(await nodes())
      expect(wheels.length, 'three native wheels').equals(3)
      for (const [index, target, options] of [
        [0, '07', HOURS],
        [1, '35', MINUTES],
        [2, 'PM', PERIODS]
      ] as const)
        await turnWheel(m, async () => await wheelAt(m, index), target, options)
      await shot('ios-app-time-after.png')
      await tap('Use time')
      await show('.*7:35 PM.*')
      await note('E3 three native wheels; 7:35 PM saved')
    } else if (surface === 'ios-safari') {
      const hourRows = flat(await nodes()).filter(node =>
        /^Hour \d\d$/.test(node.text ?? '')
      )
      expect(hourRows, 'no scrolling hour column').deep.equals([])
      await tap('^Time$')
      await m.waitForAnimationToEnd()
      const wheels = pickerWheels(await nodes())
      expect(wheels.length, 'Safari’s time wheel').equals(3)
      for (const [index, target, options] of [
        [0, '7 o’clock', SAFARI_HOURS],
        [1, '33 minutes', SAFARI_MINUTES],
        [2, 'PM', PERIODS]
      ] as const)
        await turnWheel(m, async () => await wheelAt(m, index), target, options)
      // The rounding in the page must not move Safari's open wheel.
      expect(wheelValue(await wheelAt(m, 1), SAFARI_MINUTES)).equals(
        '33 minutes'
      )
      await shot('ios-safari-time-after.png')
      // Safari's done button is the check mark below its wheel.
      const done = wheels[1].bounds!
      await m.tapOn({ text: 'Done', optional: true, timeout: 3000 })
      if (pickerWheels(await nodes()).length > 0)
        await m.tapOn({
          point: `${Math.round(done.x + done.width * 2.4)},${Math.round(done.y + done.height + 30)}`
        })
      await show('7:30 PM')
      await tap('Use time')
      await show('.*7:30 PM.*')
      await note('E5 Safari’s time wheel; 7:33 PM chosen, 7:30 PM saved')
    } else {
      expect(pickerWheels(await nodes()), 'no native wheel').deep.equals([])
      if (session != null)
        expect(
          await session.page.evaluate(
            () => document.querySelector('input[type="time"]') == null
          ),
          'no time field'
        ).equals(true)
      // From 6:00 PM, one row at a time: only the rows beside the band are
      // in view.
      await tapId('event-time-hour-7')
      for (let minute = 5; minute <= 35; minute += 5)
        await tapId(`event-time-minute-${minute}`)
      await tapId('event-time-period-1')
      await shot(`${surface}-time.png`)
      await tap('Use time')
      await show('.*7:35 PM.*')
      await note(
        `${surface === 'android-app' ? 'E6' : 'E7'} the time pop-up keeps the scrolling column; 7:35 PM saved`
      )
    }
    await note(`PASS ${surface}`)
  } finally {
    await m.detach().catch(() => undefined)
    await daemon.shutdown().catch(() => undefined)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
