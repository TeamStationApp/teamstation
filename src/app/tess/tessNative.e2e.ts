import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { maestro, type MaestroHandle } from '../../test/refinementsMaestro.e2e'
import type { TessNativeManifest } from '../../test/tessNativeFixture.e2e'

/**
 * Tess in the phone app, driven by maestro-d against the fixture
 * `tessNativeFixture.e2e.ts` runs (its manifest is
 * `TS_TESS_NATIVE_MANIFEST`). One script, three layouts:
 *
 * - `TS_TESS_LAYOUT=iphone` (the default): N1–N9 on the iPhone 13 Pro,
 *   narrow, `TS_TESS_IOS_DEVICE`. `TS_UI_BEFORE=1` runs N1 alone against
 *   the base app, asserting the umpire and Notifications buttons only.
 * - `TS_TESS_LAYOUT=ipad`: I1–I5 on the task's iPad simulator, wide in
 *   landscape, `TS_TESS_IOS_DEVICE`.
 * - `TS_TESS_LAYOUT=android`: A1–A4 on the task's emulator,
 *   `TS_TESS_ANDROID_DEVICE`. Its build is `src/MOBILE.md`'s local release
 *   recipe, whose `localRelease` build type is added to
 *   `android/app/build.gradle` in the working tree for the build only and
 *   restored before anything is committed; this script refuses to run when
 *   the committed file has one.
 *
 * Device ids come from the environment and are never written down. The
 * sign-in code comes from the fixture's control endpoint and is never
 * printed. With `TS_TESS_WEBCAM_URL`, each phone result is confirmed by a
 * frame from the bench camera as well as the screenshot.
 */

interface Node {
  type?: string
  text?: string
  id?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}

const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

type Layout = 'iphone' | 'ipad' | 'android'

async function main(): Promise<void> {
  const layout = (process.env.TS_TESS_LAYOUT ?? 'iphone') as Layout
  if (!['iphone', 'ipad', 'android'].includes(layout))
    throw new Error('TS_TESS_LAYOUT is iphone, ipad or android')
  const before = process.env.TS_UI_BEFORE === '1'
  const suffix = before ? 'before' : 'after'
  const out = resolve(
    process.env.TS_ARTIFACTS_DIR ?? 'artifacts/202610231030-tessAiHelper'
  )
  await mkdir(join(out, 'support'), { recursive: true })
  const manifestPath = process.env.TS_TESS_NATIVE_MANIFEST
  if (manifestPath == null) throw new Error('Supply TS_TESS_NATIVE_MANIFEST')
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8')
  ) as TessNativeManifest
  const android = layout === 'android'
  const device = android
    ? process.env.TS_TESS_ANDROID_DEVICE
    : process.env.TS_TESS_IOS_DEVICE
  if (device == null || device === '')
    throw new Error(
      android
        ? 'Supply TS_TESS_ANDROID_DEVICE'
        : 'Supply TS_TESS_IOS_DEVICE (the iPhone, or the iPad simulator)'
    )
  if (
    android &&
    execFileSync('git', ['show', 'HEAD:android/app/build.gradle'], {
      encoding: 'utf8'
    }).includes('localRelease')
  )
    throw new Error(
      'The localRelease build type is committed; it must stay in the working tree only'
    )
  const teamId = android
    ? undefined
    : (
        JSON.parse(
          await readFile('clientConfig.json', 'utf8').catch(() => '{}')
        ) as {
          appleTeamId?: string
        }
      ).appleTeamId
  const daemon = await maestro(
    process.env.MAESTRO_D ?? `tess-${layout === 'iphone' ? 'narrow' : layout}`
  )
  const m: MaestroHandle = await daemon.attach({
    device,
    platform: android ? 'android' : 'ios',
    appId: 'app.teamstation.app',
    ...(teamId == null ? {} : { teamId }),
    artifacts: 'on-failure',
    driverStartTimeout: 180
  })
  const native = m as unknown as {
    setOrientation: (args: { orientation: string }) => Promise<unknown>
    startRecording: (args: { path: string }) => Promise<unknown>
    stopRecording: (args: { path: string }) => Promise<unknown>
    back: () => Promise<unknown>
  }
  const control = async <T>(path: string): Promise<T> => {
    const answer = await fetch(manifest.control + path)
    expect(answer.status).equals(200)
    return (await answer.json()) as T
  }
  const nodes = async (): Promise<Node[]> =>
    flatten((await m.hierarchy()) as Node)
  const find = async (text: string): Promise<Node | undefined> =>
    (await nodes()).find(
      node => (node.text === text || node.id === text) && node.bounds != null
    )
  /** The window's size: the root's bounds, since content scrolls past it. */
  const screen = async (): Promise<{ width: number; height: number }> => {
    const all = await nodes()
    const root = all.find(node => node.bounds != null)?.bounds
    if (root != null && root.width > 0 && root.height > 0)
      return { width: root.x + root.width, height: root.y + root.height }
    return {
      width: Math.max(
        ...all.map(node =>
          node.bounds == null ? 0 : node.bounds.x + node.bounds.width
        )
      ),
      height: Math.max(
        ...all.map(node =>
          node.bounds == null ? 0 : node.bounds.y + node.bounds.height
        )
      )
    }
  }
  const show = async (text: string, timeout = 20000): Promise<void> => {
    await m.assertVisible({ text, timeout })
  }
  const hidden = async (text: string): Promise<void> => {
    await m.assertNotVisible({ text, timeout: 15000 })
  }
  const tap = async (text: string): Promise<void> => {
    await m.tapOn({ text, timeout: 20000 })
    await m.waitForAnimationToEnd()
  }
  const capture = async (name: string): Promise<void> => {
    await m.waitForAnimationToEnd()
    await writeFile(join(out, name), await m.screenshot())
    console.log('Saved', name)
  }
  const webcam = async (name: string): Promise<void> => {
    const url = process.env.TS_TESS_WEBCAM_URL
    if (url == null || url === '') return
    execFileSync(process.env.TS_FFMPEG ?? 'ffmpeg', [
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
      url,
      '-frames:v',
      '1',
      '-y',
      join(out, name)
    ])
    console.log('Saved', name, 'from the bench camera')
  }
  const say = async (words: string, answered: string): Promise<void> => {
    // By its test id: "Ask Tess" also begins the empty chat's hint.
    await m.tapOn({ id: 'Tess field', timeout: 20000 })
    if (android)
      // The emulator's driver types a long message slower than its own
      // request timeout; the shell's input types it at once.
      execFileSync('adb', [
        '-s',
        device,
        'shell',
        `input text '${words.replace(/ /g, '%s')}'`
      ])
    else await m.inputText({ text: words })
    // The field takes the keys a while after they are typed; Send before
    // then would send half the words.
    for (
      let waited = 0;
      waited < 30000 &&
      !((await find('Tess field'))?.text ?? '').includes(words);
      waited += 1000
    )
      await new Promise(resolve => setTimeout(resolve, 1000))
    await tap('Send')
    await show(`.*${answered}.*`, 60000)
    await m.hideKeyboard()
  }
  /** Holds a point for `ms`, as a finger does, and lets go. */
  const hold = async (text: string, ms: number): Promise<void> => {
    const node = await find(text)
    if (node?.bounds == null) throw new Error(`Nothing labelled ${text}`)
    const size = await screen()
    const x = (100 * (node.bounds.x + node.bounds.width / 2)) / size.width
    const y = (100 * (node.bounds.y + node.bounds.height / 2)) / size.height
    await m.swipe({ start: `${x}%,${y}%`, end: `${x}%,${y}%`, duration: ms })
  }
  /** The x of each named header button that is drawn, in order. */
  const headerOrder = async (): Promise<string[]> =>
    (await nodes())
      .filter(
        node =>
          node.bounds != null &&
          node.bounds.y < 200 &&
          ['Umpire schedule', 'Tess', 'Notifications'].includes(node.text ?? '')
      )
      .sort((a, b) => a.bounds!.x - b.bounds!.x)
      .map(node => node.text!)
      .filter((text, index, all) => all.indexOf(text) === index)
  const beacon = async (scenario: string): Promise<void> => {
    const { count } = await control<{ count: number }>('/beacon-count')
    expect(count, 'no remote load from rich HTML').equals(0)
    await appendFile(
      join(out, 'remote-load-blocked.log'),
      `# ${scenario} (${layout}): after the table card and its viewer rendered\n$ curl -s <origin>/__tess/beacon-count\n${JSON.stringify({ count })}\n`
    )
  }
  const signIn = async (): Promise<void> => {
    // Opening the chat turns dictation on, which starts the microphone. A
    // simulator's microphone is the Mac's, and starting it there can stall
    // and abort the app; I1–I5 do not talk, so the iPad goes without.
    await m.launchApp(
      layout === 'ipad' ? { permissions: { microphone: 'deny' } } : {}
    )
    try {
      await show('E-mail address', 30000)
    } catch {
      return
    }
    await tap('E-mail address')
    await m.inputText({ text: manifest.email })
    await m.hideKeyboard()
    await m.tapOn({ text: 'Send me a sign-in code', optional: true })
    await show('.*six-digit code.*', 30000)
    const { code } = await control<{ code: string | null }>(
      `/code?email=${encodeURIComponent(manifest.email)}`
    )
    if (code == null) throw new Error('No sign-in code was sent')
    await tap('Sign-in code')
    await m.inputText({ text: code })
    await m.hideKeyboard()
    await m.tapOn({ text: 'Sign in', optional: true })
  }
  const gamesOfTeam = async (): Promise<number> =>
    (await control<{ games: unknown[] }>(`/games/${manifest.team}`)).games
      .length

  try {
    if (layout === 'ipad')
      await native.setOrientation({ orientation: 'LANDSCAPE' })
    await signIn()
    await show('Notifications', 60000)

    if (layout === 'iphone') {
      // N1: the header.
      await show('Umpire schedule')
      if (!before) await show('Tess')
      expect(await headerOrder()).deep.equals(
        before
          ? ['Umpire schedule', 'Notifications']
          : ['Umpire schedule', 'Tess', 'Notifications']
      )
      await capture(`header-narrow-${suffix}.png`)
      console.log('N1 header order passed', suffix)
      if (before) return

      // N2: the full-screen chat. Opening it turns dictation on, which asks
      // for the microphone the first time.
      await tap('Tess')
      await m.tapOn({ text: 'Allow', optional: true, timeout: 5000 })
      for (const label of [
        'Close Tess',
        'Ask Tess',
        'Attach a file',
        'Dictation'
      ])
        await show(label)
      const size = await screen()
      const mic = (await find('Dictation'))!.bounds!
      expect(Math.abs(mic.x + mic.width / 2 - size.width / 2)).lessThan(24)
      const plus = (await find('Attach a file'))!.bounds!
      const field = (await find('Tess field'))!.bounds!
      expect(plus.x).lessThan(field.x)
      await capture('narrow-chat.png')
      await webcam('narrow-webcam-chat.jpg')
      console.log('N2 full-screen chat passed')

      // N3: the bubble closes the chat and opens team settings.
      await say('Where are my team settings?', "Your team's settings are here")
      await tap('Go to Home, Demo Hawks, Settings')
      await hidden('Close Tess')
      await show('Team Settings')
      await capture('narrow-link-closed.png')
      console.log('N3 the bubble opened team settings')

      // N4: the same conversation.
      await tap('Tess')
      await show('Where are my team settings?')
      await capture('narrow-reopened.png')
      console.log('N4 reopened on the same conversation')

      // N5: a table full screen; nothing remote loads.
      await say('Show our standings as a table', 'The standings')
      await tap('Open full screen')
      await show('Close')
      await m.swipe({ start: '80%,50%', end: '20%,50%', duration: 400 })
      await capture('narrow-table-fullscreen.png')
      await tap('Close')
      await show('Ask Tess')
      await beacon('N5')
      console.log('N5 table full screen, beacon 0')

      // N6: release early, then hold 3 s.
      const gamesBefore = await gamesOfTeam()
      await say('Add a game against Demo Eagles Saturday at 10', 'Hold Confirm')
      await show('Hold to confirm')
      const video = join(out, 'narrow-confirm-trace.mp4')
      await native.startRecording({ path: video })
      await hold('Hold to confirm', 1000)
      await show('Hold to confirm')
      expect(await gamesOfTeam()).equals(gamesBefore)
      await hold('Hold to confirm', 3500)
      await show('Done', 30000)
      await native.stopRecording({ path: video })
      expect(await gamesOfTeam()).equals(gamesBefore + 1)
      console.log('N6 early release ran nothing; 3 s ran the change')

      // N7: + offers Photo and File; the document picker cancels cleanly.
      await tap('Attach a file')
      await show('Photo')
      await show('File')
      await capture('narrow-attach-sheet.png')
      await tap('File')
      await show('Cancel', 30000)
      await tap('Cancel')
      await show('Ask Tess')
      expect(
        (await nodes()).some(node => (node.text ?? '').startsWith('Remove '))
      ).equals(false)
      console.log('N7 the sheet and the picker, cancelled with no chip')

      // N8: the microphone, twice.
      const voice = join(out, 'narrow-voice.mp4')
      const heardBefore = (await control<{ heard: string[] }>('/dictation'))
        .heard.length
      await native.startRecording({ path: voice })
      for (let time = 1; time <= 2; time++) {
        await hold('Dictation', 2500)
        await m.tapOn({ text: 'Allow', optional: true, timeout: 3000 })
        await show('Push to talk', 30000)
      }
      await native.stopRecording({ path: voice })
      const heard = (await control<{ heard: string[] }>('/dictation')).heard
      expect(
        heard.slice(heardBefore).filter(text => text !== '').length
      ).greaterThanOrEqual(2)
      console.log('N8 two holds became messages')

      // N9: sideways it is still the full-screen chat.
      await native.setOrientation({ orientation: 'LANDSCAPE' })
      await show('Close Tess')
      const sideways = await screen()
      const wideField = (await find('Tess field'))!.bounds!
      expect(wideField.x + wideField.width).greaterThan(sideways.width * 0.6)
      await native.setOrientation({ orientation: 'PORTRAIT' })
      console.log('N9 landscape stays narrow')
    }

    if (layout === 'ipad') {
      // I1: the split in landscape.
      await tap('Tess')
      await show('Ask Tess')
      const field = (await find('Tess field'))!.bounds!
      expect(field.x + field.width).lessThanOrEqual(400)
      await show('Notifications')
      await capture('ipad-split.png')
      console.log('I1 the split')

      // I2: the bubble navigates the pane; the chat stays.
      await say('Where are my team settings?', "Your team's settings are here")
      await tap('Go to Home, Demo Hawks, Settings')
      await show('Team Settings')
      await show('Close Tess')
      console.log('I2 the pane went to team settings')

      // I3: the viewer over the pane only.
      await say('Show our standings as a table', 'The standings')
      await tap('Open full screen')
      await show('Close')
      const close = (await nodes()).find(
        node => node.text === 'Close' && node.bounds != null
      )!.bounds!
      expect(close.x).greaterThan(400)
      await show('Ask Tess')
      await capture('ipad-table-overlay.png')
      await tap('Close')
      await beacon('I3')
      console.log('I3 the viewer over the pane, beacon 0')

      // I4: portrait is narrow.
      await native.setOrientation({ orientation: 'PORTRAIT' })
      await show('Close Tess')
      const narrowField = (await find('Tess field'))!.bounds!
      expect(narrowField.x + narrowField.width).greaterThan(400)
      console.log('I4 portrait shows the chat full screen')

      // I5: DJ Game hides the column and the button; leaving brings it back.
      await native.setOrientation({ orientation: 'LANDSCAPE' })
      await show('Close Tess')
      await m.waitForAnimationToEnd()
      await m.openLink({
        link: `teamstation://games/${manifest.games.scheduled}/dj`
      })
      await hidden('Close Tess')
      // The first visit opens Apple Music's setup over DJ Game.
      await m.tapOn({
        text: 'Close',
        optional: true,
        timeout: 5000
      })
      await show('DJ Game', 30000)
      await show('Notifications')
      expect(await headerOrder()).deep.equals([
        'Umpire schedule',
        'Notifications'
      ])
      await tap('Back')
      await show('Close Tess', 30000)
      console.log('I5 DJ hid Tess; leaving brought the column back')
    }

    if (layout === 'android') {
      // A1: the header.
      await show('Tess')
      const order = await headerOrder()
      expect(order.indexOf('Tess')).lessThan(order.indexOf('Notifications'))
      console.log('A1 the Tess button before Notifications')

      // A2: full screen, the bubble closes it and opens team settings.
      await tap('Tess')
      await show('Ask Tess')
      await say('Where are my team settings?', "Your team's settings are here")
      await capture('android-chat.png')
      await tap('Go to Home, Demo Hawks, Settings')
      await hidden('Close Tess')
      await show('Team Settings')
      console.log('A2 the chat, and its link')

      // A3: the hardware Back closes the chat and nothing else.
      await tap('Tess')
      await show('Close Tess')
      await native.back()
      await hidden('Close Tess')
      await show('Team Settings')
      console.log('A3 Back closed the chat; the screen behind is unchanged')

      // A4: the + sheet, with the document picker's module loaded.
      await tap('Tess')
      await tap('Attach a file')
      await show('Photo')
      await show('File')
      console.log('A4 the sheet offers Photo and File')
    }
    console.log(`Tess native scenarios passed (${layout})`)
  } finally {
    await m.detach().catch(() => undefined)
    await daemon.shutdown().catch(() => undefined)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
