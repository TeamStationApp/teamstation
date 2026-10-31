import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'

import type { PrivacyNativeManifest } from '../../e2e/fixtures/playerNamePrivacyNativeFixture'
import { maestro } from '../../e2e/rigs/refinementsMaestro'

/**
 * Player name privacy in the phone app, driven by maestro-d against
 * `playerNamePrivacyNativeFixture.e2e.ts`. Its build is `src/MOBILE.md`'s
 * local release recipe, whose `localRelease` build type lives in the working
 * tree for the build only, with its own application id, so it installs
 * beside the TeamStation app already on the phone.
 *
 * Device ids come from the environment and are never written down. The
 * sign-in code comes from the fixture's control endpoint and is never printed.
 */
interface Node {
  text?: string
  accessibilityText?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

/** Where the mic button sits, in percent of the screen. */
function flattenBounds(root: Node): { x: number; y: number } {
  const all = flatten(root)
  const mic = all.find(node => node.accessibilityText === 'Dictation')
  const size = all[0].bounds
  if (mic?.bounds == null || size == null) return { x: 89, y: 79 }
  return {
    x: Math.round(((mic.bounds.x + mic.bounds.width / 2) / size.width) * 100),
    y: Math.round(((mic.bounds.y + mic.bounds.height / 2) / size.height) * 100)
  }
}

async function main(): Promise<void> {
  const device = process.env.TS_PRIVACY_DEVICE
  const platform = process.env.TS_PRIVACY_PLATFORM ?? 'android'
  const appId =
    process.env.TS_PRIVACY_APP_ID ??
    (platform === 'ios' ? 'app.teamstation.app' : 'app.teamstation.app.privacy')
  const manifestFile = process.env.TS_PRIVACY_NATIVE_MANIFEST
  const out = process.env.TS_CREATION_ARTIFACTS
  if (device == null || manifestFile == null || out == null)
    throw new Error(
      'Supply TS_PRIVACY_DEVICE, TS_PRIVACY_NATIVE_MANIFEST and TS_CREATION_ARTIFACTS'
    )
  const manifest = JSON.parse(
    await readFile(manifestFile, 'utf8')
  ) as PrivacyNativeManifest
  await mkdir(out, { recursive: true })
  const log = `native-${platform}.log`
  await rm(join(out, log), { force: true })
  const control = async <T>(path: string): Promise<T> =>
    (await (await fetch(manifest.control + path)).json()) as T
  const daemon = await maestro(`playerNamePrivacyNative-${process.pid}`)
  const teamId = process.env.TS_PRIVACY_TEAM_ID
  const m = await daemon.attach({
    device,
    platform,
    appId,
    ...(teamId == null ? {} : { teamId }),
    driverStartTimeout: 180
  })
  const texts = async (): Promise<string[]> =>
    flatten((await m.hierarchy()) as Node).flatMap(node =>
      node.text == null || node.text === '' ? [] : [node.text]
    )
  const show = async (text: string, timeout = 30000): Promise<void> => {
    await m.assertVisible({ text, timeout })
  }
  const tap = async (text: string): Promise<void> => {
    await m.tapOn({ text, timeout: 20000 })
  }
  /** One wheel row, by its test id: the same words also sit behind the dialog. */
  const spin = async (stop: number): Promise<void> => {
    await m.tapOn({ id: `player-name-privacy-${stop}`, timeout: 20000 })
  }
  const shot = async (name: string): Promise<void> => {
    await m.waitForAnimationToEnd()
    await writeFile(join(out, `${platform}-${name}`), await m.screenshot())
  }
  const open = async (path: string, text: string): Promise<void> => {
    // Named for this build: the phone also has TeamStation itself installed.
    const link = `teamstation://${path.replace(/^\//, '')}`
    if (platform === 'ios') await m.openLink({ link })
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
        link
      ])
    await m.tapOn({ text: 'Open', optional: true, timeout: 2000 })
    await m.scrollUntilVisible({ element: { text }, timeout: 30000 })
    await show(text)
  }
  const note = async (line: string): Promise<void> => {
    await appendFile(join(out, log), `${line}\n`)
    console.log(line)
  }
  const signIn = async (): Promise<void> => {
    await tap('E-mail address')
    await m.inputText({ text: manifest.email })
    await m.hideKeyboard()
    await m.tapOn({ text: 'Send me a sign-in code', optional: true })
    await show('Sign-in code', 30000)
    let code: string | null = null
    for (let waited = 0; code == null && waited < 15; waited++) {
      code = (
        await control<{ code: string | null }>(
          `/code?email=${encodeURIComponent(manifest.email)}`
        )
      ).code
      if (code == null) await new Promise(resolve => setTimeout(resolve, 1000))
    }
    if (code == null) throw new Error('No sign-in code was sent')
    await tap('Sign-in code')
    await m.inputText({ text: code })
    await m.hideKeyboard()
    await m.tapOn({ text: 'Sign in', optional: true })
    await show('Notifications', 45000)
  }
  const TEAM = `groups/team/${manifest.teamId}/settings`
  try {
    await m.launchApp(platform === 'ios' ? {} : { clearState: true })
    const signedIn = await m
      .assertVisible({ text: 'Notifications', timeout: 8000 })
      .then(
        () => true,
        () => false
      )
    if (!signedIn) await signIn()

    // N1: the row on a real phone.
    await open(TEAM, 'Player Name Privacy')
    await show('Default')
    await shot('native-settings-default.png')
    await note('$ N1 Team Settings: Player Name Privacy reads Default')

    // N2: the wheel, spun by touch, and Cancel.
    await tap('Player Name Privacy.*')
    await show('Show players as')
    await shot('native-wheel.png')
    await tap('Cancel')
    await show('Default')
    await note('$ N2 Cancel leaves Default')

    // N3: spun to the fourth stop, one row at a time, and Use.
    await tap('Player Name Privacy.*')
    await show('Show players as')
    for (const stop of [1, 2, 3]) {
      await spin(stop)
      await shot(`wheel-stop-${stop}.png`)
    }
    await shot('native-wheel-spun.png')
    await tap('Use')
    await show('First initial, last initial')
    await shot('native-settings-initials.png')
    await note('$ N3 Use stores First initial, last initial')

    // N4: it survives the app stopping.
    await m.command('stopApp', { appId })
    await m.launchApp()
    await open(TEAM, 'First initial, last initial')
    await note('$ N4 The value survives a relaunch')

    // N5: the public roster in the app.
    await open(`teams/${manifest.teamId}?tab=team`, 'A L')
    await shot('native-roster-initials.png')
    expect(await texts()).not.includes('Alex L')
    expect(await texts()).not.includes('Alex Lee')
    await note('$ N5 The roster shows A L')

    // N6: scoring, whose screen draws the label and whose prompt must not.
    await open(`games/${manifest.gameId}/score`, 'BUNT')
    await shot('native-scoring-initials.png')
    await note(
      '$ N6 Scoring opens, its board drawn in pixels: see the screenshot'
    )

    // N7: dictation. The mic turns on, which connects the socket, and a held
    // press sends what the model would be told.
    await m.tapOn({ id: 'Dictation', optional: true, timeout: 5000 })
    await m.tapOn({ text: 'Dictation', optional: true, timeout: 5000 })
    await m.tapOn({
      text: 'While using the app',
      optional: true,
      timeout: 3000
    })
    await m.tapOn({ text: 'Allow', optional: true, timeout: 2000 })
    await new Promise(resolve => setTimeout(resolve, 4000))
    const button = flattenBounds((await m.hierarchy()) as Node)
    await m.swipe({
      start: `${button.x}%,${button.y}%`,
      end: `${button.x}%,${button.y}%`,
      duration: 2500
    })
    await new Promise(resolve => setTimeout(resolve, 3000))
    const heard = await control<{ keyterms: string[][]; contexts: string[] }>(
      '/dictation'
    )
    await note(
      `$ keyterms sent to the recogniser\n${JSON.stringify(heard.keyterms.at(-1) ?? [])}`
    )
    await note(
      `$ context sent to the model\n${heard.contexts.at(-1) ?? '(none)'}`
    )
    const sent = JSON.stringify(heard)
    expect(sent).include('Alex L.')
    expect(sent).not.include('A L.')
    expect(sent).not.include('Lee')
    await shot('native-scoring-dictated.png')
    await note('$ N7 The model is told Alex L. while the screen draws A L.')

    // N8: the long labels on the pixel board.
    const choose = async (
      from: string,
      to: number[],
      label: string
    ): Promise<void> => {
      await open(TEAM, from)
      await tap('Player Name Privacy.*')
      await show('Show players as')
      for (const stop of to) await spin(stop)
      await tap('Use')
      await show(label)
    }
    await choose('First initial, last initial', [4], 'Full name')
    await open(`teams/${manifest.teamId}?tab=team`, 'Alex Lee')
    await open(`games/${manifest.gameId}/score`, 'BUNT')
    await new Promise(resolve => setTimeout(resolve, 3000))
    await shot('native-scoring-full.png')
    await note('$ N8 Full name: roster shows Alex Lee, board in the screenshot')
    await choose('Full name', [3, 2], 'First initial, last name')
    await open(`teams/${manifest.teamId}?tab=team`, 'A Lee')
    await open(`games/${manifest.gameId}/score`, 'BUNT')
    await new Promise(resolve => setTimeout(resolve, 3000))
    await shot('native-scoring-initial-last.png')
    await note(
      '$ N9 First initial, last name: roster shows A Lee, board in the screenshot'
    )

    // N10: the wheel spun by a finger, not a tap. A flick carries it to the
    // last stop, and it snaps there.
    await open(TEAM, 'First initial, last name')
    await tap('Player Name Privacy.*')
    await show('Show players as')
    await m.swipe({ start: '50%,50%', end: '50%,44%', duration: 500 })
    await new Promise(resolve => setTimeout(resolve, 1500))
    await shot('native-wheel-swiped.png')
    await tap('Use')
    await show('Full name')
    await note('$ N10 A flick snaps the wheel to Full name, and Use stores it')
  } finally {
    await m.detach().catch(() => undefined)
    await daemon.shutdown().catch(() => undefined)
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  }
)
