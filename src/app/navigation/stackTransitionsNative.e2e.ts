import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { log, maestro } from '../../test/refinementsMaestro.e2e'

/**
 * Pushed screens, the scoring cover, drags back and pill pages on a real phone,
 * through maestro-d's JavaScript library, against
 * `stackTransitionsFixture.e2e.ts`.
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
  const tap = async (text: string): Promise<void> => {
    await m.tapOn({ text, timeout: 15000 })
  }
  /** The navbar by its glyph's position: a text tap can hit a card first. */
  const tab = async (label: string): Promise<void> => {
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
    await m.startRecording({
      path: join(artifacts, 'support', `${platform}-${name}.mp4`)
    })
    try {
      await run()
      await note(`${name}: passed`)
    } finally {
      await m.stopRecording().catch(() => undefined)
    }
  }
  const signIn = async (): Promise<void> => {
    await m.launchApp({ appId: APP_ID, stopApp: true })
    if (!(await shown('Sign in to TeamStation', 15000))) return
    await tap('parent@example.com')
    await m.inputText({ text: manifest.email })
    await tap('Send me a sign-in code')
    let code: string | undefined
    for (let tries = 0; tries < 20 && code == null; tries++) {
      const answer = await fetch(
        `${manifest.origin}/__stack/code?email=${encodeURIComponent(manifest.email)}`
      )
      if (answer.ok) code = ((await answer.json()) as { code: string }).code
      else await new Promise(resolve => setTimeout(resolve, 500))
    }
    assert.ok(code != null, 'No sign-in code mailed')
    await tap('123456')
    await m.inputText({ text: code })
    await tap('Sign in')
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
    await tap('Alex L')
    await visible('Player sections')
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
        await visible('Player sections')
        await tap('Back')
        await visible('Team sections')
        await pastHome()
      })
    if (cases.has('N4'))
      await recorded('N4', async () => {
        await m.openLink({ link: `teamstation://games/${manifest.game}` })
        await visible('Demo Owls')
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
        // R3: the schedule's pills still pin after a page change.
        await tab('Schedule')
        await visible('Upcoming')
        await m.swipe({ start: '50%, 70%', end: '50%, 30%', duration: 400 })
        await tap('Past')
        await visible('Past')
        await pastHome()
      })
    if (cases.has('N6')) {
      assert.equal(platform, 'android')
      await recorded('N6', async () => {
        await openPlayer()
        await m.swipe({ start: '0%, 50%', end: '80%, 50%', duration: 600 })
        await visible('Team sections')
        await tap('Team')
        await tap('Alex L')
        await visible('Player sections')
        await m.swipe({ start: '0%, 50%', end: '15%, 50%', duration: 1500 })
        await visible('Player sections')
        await m.back()
        await visible('Team sections')
        await m.pressKey({ key: 'Home' })
        await m.launchApp({ appId: APP_ID, stopApp: false })
        await tap('Team')
        await tap('Alex L')
        await visible('Player sections')
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
