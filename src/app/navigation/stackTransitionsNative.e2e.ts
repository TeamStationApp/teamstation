import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { log, maestro } from '../../test/refinementsMaestro.e2e'

/**
 * Pushed screens, the scoring cover, drags back and pill pages on a real phone,
 * through maestro-d's JavaScript library, against
 * `src/test/stackTransitionsFixture.e2e.ts`.
 *
 *   TS_STACK_ARTIFACTS=… TS_STACK_DEVICE=<id> TS_STACK_PLATFORM=ios|android \
 *   TS_STACK_CASES=N1,N2 TS_MAESTRO_D_CLIENT=… MAESTRO_D_BIN=… \
 *     node -r sucrase/register src/app/navigation/stackTransitionsNative.e2e.ts
 *
 * `TS_STACK_DEVICE` is looked up when the run starts, never written here.
 * Each case is recorded with `startRecording`/`stopRecording` into
 * `<platform>-<case>.mp4`; what each saw goes to `native-<platform>.log`.
 */
interface Node {
  text?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
interface Device {
  launchApp: (options?: unknown) => Promise<unknown>
  stopApp: (options?: unknown) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (selector: unknown) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  assertVisible: (selector: unknown) => Promise<unknown>
  assertNotVisible: (selector: unknown) => Promise<unknown>
  swipe: (options: unknown) => Promise<unknown>
  scroll: () => Promise<unknown>
  back: () => Promise<unknown>
  pressKey: (options: { key: string }) => Promise<unknown>
  hierarchy: () => Promise<Node>
  screenshot: () => Promise<Uint8Array>
  startRecording: (options: { path: string }) => Promise<unknown>
  stopRecording: () => Promise<unknown>
  detach: () => Promise<unknown>
}

const APP_ID = 'app.teamstation.app'

function required(name: string): string {
  const value = process.env[name]
  if (value == null || value === '') throw new Error(`Supply ${name}`)
  return value
}

function flatten(node: Node): Node[] {
  return [node, ...(node.children ?? []).flatMap(flatten)]
}

async function main(): Promise<void> {
  const artifacts = required('TS_STACK_ARTIFACTS')
  const device = required('TS_STACK_DEVICE')
  const platform = required('TS_STACK_PLATFORM')
  assert.ok(platform === 'ios' || platform === 'android', platform)
  const cases = new Set(
    (process.env.TS_STACK_CASES ?? 'N1,N2,N3,N4').split(',').map(c => c.trim())
  )
  const manifest = JSON.parse(
    await readFile(join(artifacts, 'support', 'native-manifest.json'), 'utf8')
  ) as {
    origin: string
    email: string
    team: string
    player: string
    game: string
  }
  const file = `native-${platform}.log`
  const note = async (line: string): Promise<void> => {
    await log(artifacts, file, line)
  }
  const daemon = await maestro(`stackTransitionsNative-${platform}`)
  const teamId = process.env.MAESTRO_D_TEAM_ID
  const m = (await daemon.attach({
    device,
    platform,
    appId: APP_ID,
    artifacts: 'on-failure',
    ...(teamId != null && teamId !== '' ? { teamId } : {})
  })) as unknown as Device
  const visible = async (text: string, timeout = 15000): Promise<void> => {
    await m.assertVisible({ text, timeout })
  }
  const shown = async (text: string, timeout = 3000): Promise<boolean> =>
    await m
      .assertVisible({ text, timeout })
      .then(() => true)
      .catch(() => false)
  /** A tap, then long enough for any push, cover or page slide to finish. */
  const tap = async (text: string): Promise<void> => {
    await m.tapOn({ text, timeout: 15000 })
    await new Promise(resolve => setTimeout(resolve, 700))
  }
  /**
   * A tap that opens `then`. A list that re-renders as its read lands can
   * swallow the first tap, so a tap that opened nothing is tried again.
   */
  const open = async (text: string, then: string): Promise<void> => {
    for (let tries = 0; ; tries++) {
      await tap(text)
      if (await shown(then, 5000)) return
      if (tries === 2) await visible(then)
      await note(`  ${text} opened nothing; tapping again`)
    }
  }
  /**
   * A debug build's warning toast — the scorer's field logs a three.js
   * deprecation — sits over the navbar in a window of its own that no
   * hierarchy shows. It is a dark bar where every page is light, so a dark
   * pixel in its body says it is there, and its close button goes.
   */
  const closeWarnings = async (): Promise<void> => {
    const shot = join(tmpdir(), `ts-stack-${platform}-warnings.png`)
    await writeFile(shot, await m.screenshot())
    const [r, g, b] = execFileSync('ffmpeg', [
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      shot,
      '-vf',
      'crop=1:1:iw*0.85:ih*0.925',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ])
    if (r + g + b > 240) return
    await note('  closing the warning toast over the navbar')
    await m.tapOn({ point: '92%, 92.5%' })
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  /** The navbar by its glyph's position: a text tap can hit a card first. */
  const tab = async (label: string): Promise<void> => {
    await closeWarnings()
    const nodes = flatten(await m.hierarchy()).filter(
      node => node.text === label && node.bounds != null
    )
    const target = nodes.sort((a, b) => b.bounds!.y - a.bounds!.y)[0]?.bounds
    assert.ok(target != null, `Missing ${label} tab`)
    await m.tapOn({
      point: `${Math.round(target.x + target.width / 2)},${Math.round(target.y + target.height / 2)}`
    })
  }
  const recorded = async (
    name: string,
    run: () => Promise<void>
  ): Promise<void> => {
    await note(`${name}: start`)
    const path = join(artifacts, 'support', `${platform}-${name}.mp4`)
    // Each device records itself: a simulator through simctl, an Android
    // phone through screenrecord, pulled when the case ends.
    const onDevice = `/sdcard/ts-${name}.mp4`
    const recorder =
      platform === 'ios'
        ? spawn('xcrun', [
            'simctl',
            'io',
            device,
            'recordVideo',
            '--force',
            path
          ])
        : spawn('adb', ['-s', device, 'shell', 'screenrecord', onDevice])
    await new Promise(resolve => setTimeout(resolve, 1000))
    try {
      await run()
      await note(`${name}: passed`)
    } finally {
      if (platform === 'ios')
        await new Promise(resolve => {
          recorder.once('exit', resolve)
          recorder.kill('SIGINT')
        })
      else {
        execFileSync('adb', [
          '-s',
          device,
          'shell',
          'pkill',
          '-INT',
          'screenrecord'
        ])
        await new Promise(resolve => recorder.once('exit', resolve))
        await new Promise(resolve => setTimeout(resolve, 1000))
        execFileSync('adb', ['-s', device, 'pull', onDevice, path])
        execFileSync('adb', ['-s', device, 'shell', 'rm', onDevice])
      }
    }
  }
  const signIn = async (): Promise<void> => {
    await m.launchApp({ appId: APP_ID, stopApp: true })
    if (!(await shown('Sign in to TeamStation', 15000))) return
    const asked = await fetch(`${manifest.origin}/api/v1/auth/email-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: manifest.email })
    })
    assert.equal(asked.status, 202)
    const answer = await fetch(
      `${manifest.origin}/__stack/code?email=${encodeURIComponent(manifest.email)}`
    )
    assert.ok(answer.ok, 'No sign-in mail')
    const { link } = (await answer.json()) as { link?: string }
    const token = link?.split('/signin/')[1]
    assert.ok(token != null && token !== '', `No sign-in link in ${link}`)
    await m.openLink({ link: `teamstation://signin/${token}` })
    await visible('Your Home', 30000)
  }
  const openTeam = async (): Promise<void> => {
    await tab('Home')
    await visible('Your Home')
    await tap('Demo Hawks')
    await visible('Team sections')
  }
  const openPlayer = async (): Promise<void> => {
    await openTeam()
    await tap('Team')
    await visible('Alex L')
    await open('Alex L', 'Player sections')
  }
  const pastHome = async (): Promise<void> => {
    // Back to a clean Home whatever the last case left.
    await tab('Home')
    await tab('Home')
    await visible('Your Home')
  }

  try {
    await note(
      `$ TS_STACK_PLATFORM=${platform} TS_STACK_CASES=${[...cases].join(',')} node -r sucrase/register src/app/navigation/stackTransitionsNative.e2e.ts`
    )
    await signIn()
    if (cases.has('N1'))
      await recorded('N1', async () => {
        await openPlayer()
        await tap('Back')
        await visible('Team sections')
        await visible('Demo Hawks')
        await pastHome()
      })
    if (cases.has('N2'))
      await recorded('N2', async () => {
        await openPlayer()
        await m.swipe({ start: '1%, 50%', end: '85%, 50%', duration: 350 })
        await visible('Team sections')
        await m.swipe({ start: '1%, 50%', end: '85%, 50%', duration: 350 })
        await visible('Your Home')
      })
    if (cases.has('N3'))
      await recorded('N3', async () => {
        await openPlayer()
        await m.swipe({ start: '1%, 50%', end: '30%, 50%', duration: 1500 })
        // Short of half way and let go: it springs back, and the history is
        // untouched.
        await visible('Player sections')
        await tap('Back')
        await visible('Team sections')
        await pastHome()
      })
    if (cases.has('N4'))
      await recorded('N4', async () => {
        await m.openLink({ link: `teamstation://games/${manifest.game}` })
        await visible('Demo Owls')
        await visible('Location not set')
        // A pushed screen still scrolls from its left edge: the edge pan
        // fails on a vertical move and leaves it to the page.
        const rowAt = async (label: string): Promise<number> => {
          const node = flatten(await m.hierarchy()).find(
            entry => entry.text === label && entry.bounds != null
          )
          assert.ok(node?.bounds != null, `No ${label}`)
          return node.bounds.y
        }
        const before = await rowAt('Location not set')
        await m.swipe({ start: '2%, 70%', end: '2%, 40%', duration: 500 })
        await new Promise(resolve => setTimeout(resolve, 800))
        const after = await rowAt('Location not set')
        await note(
          `  edge scroll: Location not set at y=${before}, then y=${after}`
        )
        assert.ok(after < before - 40, 'a scroll from the edge did not move')
        await m.swipe({ start: '50%, 40%', end: '50%, 75%', duration: 300 })
        await new Promise(resolve => setTimeout(resolve, 600))
        await tap('Score')
        await visible('Full game scoring')
        await tap('Full game scoring')
        await visible('Open scoring menu')
        await tap('Open scoring menu')
        await tap('Exit Current Game')
        await visible('Game sections')
        if (platform === 'android') {
          // System Back on the scorer: the history walk and its save.
          await tap('Score')
          await tap('Full game scoring')
          await visible('Open scoring menu')
          await m.back()
          await visible('Full game scoring')
        }
        await pastHome()
      })
    if (cases.has('N5'))
      await recorded('N5', async () => {
        await openTeam()
        for (const pill of ['Team', 'Stats', 'Videos']) await tap(pill)
        await m.openLink({ link: `teamstation://games/${manifest.game}` })
        await visible('Game sections')
        await tap('Box score')
        await tap('Info')
        const pillAt = async (label: string): Promise<number> => {
          const node = flatten(await m.hierarchy()).find(
            entry => entry.text === label && entry.bounds != null
          )
          assert.ok(node?.bounds != null, `No ${label} pill`)
          return node.bounds.y
        }
        // A player's pills pin under the header, and stay pinned across a
        // page change.
        await openPlayer()
        const resting = await pillAt('Stats')
        await m.swipe({ start: '50%, 70%', end: '50%, 30%', duration: 400 })
        await new Promise(resolve => setTimeout(resolve, 800))
        const held = await pillAt('Stats')
        await tap('Stats')
        await new Promise(resolve => setTimeout(resolve, 600))
        const kept = await pillAt('Stats')
        await note(
          `  player pills: Stats pill at y=${resting} at rest, y=${held} pinned, y=${kept} after choosing Stats`
        )
        assert.ok(held < resting, 'the player pills did not pin')
        assert.ok(Math.abs(kept - held) <= 2, 'the player pills moved')
        await pastHome()
        // R3: the schedule's pills still pin after a page change.
        await tab('Schedule')
        await visible('Upcoming')
        await m.swipe({ start: '50%, 70%', end: '50%, 30%', duration: 400 })
        await new Promise(resolve => setTimeout(resolve, 800))
        const pill = async (): Promise<number> => await pillAt('Upcoming')
        const pinned = await pill()
        await tap('Past')
        await visible('Past')
        const after = await pill()
        await note(
          `  R3: Upcoming pill at y=${pinned} before Past, y=${after} after`
        )
        assert.ok(Math.abs(after - pinned) <= 2, 'the pills moved')
        await pastHome()
      })
    if (cases.has('N6')) {
      assert.equal(platform, 'android')
      await recorded('N6', async () => {
        await openPlayer()
        await m.swipe({ start: '0%, 50%', end: '80%, 50%', duration: 600 })
        await visible('Team sections')
        await tap('Team')
        await visible('Alex L')
        await open('Alex L', 'Player sections')
        // Android commits a back gesture let go anywhere; it cancels one
        // whose finger comes back to the edge first. Out and back, by raw
        // touches, because a swipe goes one way.
        const touch = (action: string, x: number): void => {
          execFileSync('adb', [
            '-s',
            device,
            'shell',
            'input',
            'motionevent',
            action,
            String(x),
            '1200'
          ])
        }
        touch('DOWN', 2)
        for (const x of [60, 160, 260, 360, 300, 200, 100, 30, 5])
          touch('MOVE', x)
        touch('UP', 5)
        await new Promise(resolve => setTimeout(resolve, 800))
        await visible('Player sections')
        await m.back()
        await visible('Team sections')
        await m.pressKey({ key: 'Home' })
        await m.launchApp({ appId: APP_ID, stopApp: false })
        await tap('Team')
        await visible('Alex L')
        await open('Alex L', 'Player sections')
        await m.swipe({ start: '0%, 50%', end: '80%, 50%', duration: 600 })
        await visible('Team sections')
        await pastHome()
      })
    }
    if (cases.has('N7')) {
      assert.equal(platform, 'android')
      await recorded('N7', async () => {
        await openTeam()
        await tap('Stats')
        await m.swipe({ start: '0%, 50%', end: '80%, 50%', duration: 600 })
        // The history walk: the team on its Videos pill, as on master.
        await visible('Team sections')
        await m.swipe({ start: '0%, 50%', end: '80%, 50%', duration: 600 })
        await visible('Your Home')
        await openTeam()
        await tab('Schedule')
        await tab('Home')
        await m.swipe({ start: '0%, 50%', end: '80%, 50%', duration: 600 })
        await visible('Upcoming')
        // Back at the bottom of the history leaves the app.
        await m.stopApp({ appId: APP_ID })
        await m.launchApp({ appId: APP_ID, stopApp: false })
        await visible('Your Home')
        await m.back()
        await new Promise(resolve => setTimeout(resolve, 1500))
        const resumed = execFileSync(
          'adb',
          ['-s', device, 'shell', 'dumpsys', 'activity', 'activities'],
          { encoding: 'utf8' }
        )
          .split('\n')
          .filter(line => /mResumedActivity|topResumedActivity/.test(line))
          .join(' ')
        await note(`N7 after Back at Home: ${resumed.trim()}`)
        assert.ok(!resumed.includes(APP_ID), 'the app is still in front')
        await m.launchApp({ appId: APP_ID, stopApp: false })
      })
    }
  } finally {
    await m.detach().catch(() => undefined)
    await daemon.shutdown()
  }
  await writeFile(join(artifacts, 'support', `native-${platform}-done`), '')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
