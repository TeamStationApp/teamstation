import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
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
 * `TS_TESS_APP_ID` names the app when the build has its own bundle id, so
 * it installs beside the TeamStation app already on the phone. maestro-d
 * records the screen of a simulator or an emulator only; for the phone,
 * `TS_TESS_RECORD_MJPEG` names WebDriverAgent's MJPEG stream forwarded to
 * this Mac, and ffmpeg records that instead.
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
    appId: process.env.TS_TESS_APP_ID ?? 'app.teamstation.app',
    ...(teamId == null ? {} : { teamId }),
    artifacts: 'on-failure',
    driverStartTimeout: 180
  })
  const native = m as unknown as {
    setOrientation: (args: { orientation: string }) => Promise<unknown>
    startRecording: (args: { path: string }) => Promise<unknown>
    stopRecording: (args: { path: string }) => Promise<unknown>
    back: () => Promise<unknown>
    hierarchyRaw: () => Promise<Uint8Array>
  }
  let recorder: ChildProcess | undefined
  const startRecording = async (path: string): Promise<void> => {
    const mjpeg = process.env.TS_TESS_RECORD_MJPEG
    if (mjpeg == null || mjpeg === '') {
      await native.startRecording({ path })
      return
    }
    recorder = spawn(
      process.env.TS_FFMPEG ?? 'ffmpeg',
      [
        '-loglevel',
        'error',
        '-use_wallclock_as_timestamps',
        '1',
        '-f',
        'mpjpeg',
        '-i',
        mjpeg,
        '-an',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-vf',
        'scale=-2:1280',
        '-fps_mode',
        'cfr',
        '-r',
        '30',
        '-y',
        path
      ],
      { stdio: ['pipe', 'ignore', 'inherit'] }
    )
    // The stream takes a moment to open and send its first frames.
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  const stopRecording = async (path: string): Promise<void> => {
    const running = recorder
    if (running == null) {
      await native.stopRecording({ path })
      return
    }
    recorder = undefined
    const exited = new Promise(resolve => running.once('exit', resolve))
    running.stdin?.end('q')
    await exited
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
  /**
   * The driver matches text by "contains", so `Close` also finds Tess's
   * `Close Tess` and `Team Settings` the chat's "Where are my team
   * settings?". These wait for a node whose text is exactly that. A tap
   * after one has been found goes through the driver, which tries an exact
   * button first: a tap by a point is scaled to the portrait screen while
   * the iPad lies in landscape.
   */
  const exactly = async (
    text: string,
    timeout = 20000
  ): Promise<Node | undefined> => {
    for (let waited = 0; ; waited += 500) {
      const node = await find(text)
      if (node != null || waited >= timeout) return node
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  const showExactly = async (text: string, timeout = 20000): Promise<void> => {
    if ((await exactly(text, timeout)) == null)
      throw new Error(`Nothing reads exactly ${text}`)
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
  /**
   * Whether Tess's field holds `words`. On iOS a node's text is its label,
   * "Ask Tess", and never what is typed, so there the driver's own tree is
   * read for the field's value.
   */
  const fieldHolds = async (words: string): Promise<boolean> => {
    if (android) return ((await find('Tess field'))?.text ?? '').includes(words)
    const raw = Buffer.from(await native.hierarchyRaw()).toString('utf8')
    let value = ''
    if (raw.trimStart().startsWith('{')) {
      const flat = JSON.parse(raw) as {
        nodes?: Array<{ identifier?: string; value?: string }>
      }
      value =
        flat.nodes?.find(node => node.identifier === 'Tess field')?.value ?? ''
    } else {
      const element = /<[^>]*\bname="Tess field"[^>]*>/.exec(raw)?.[0] ?? ''
      value = (/\bvalue="([^"]*)"/.exec(element)?.[1] ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
    }
    return value.includes(words)
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
      waited < 30000 && !(await fieldHolds(words));
      waited += 1000
    )
      await new Promise(resolve => setTimeout(resolve, 1000))
    await tap('Send')
    await show(`.*${answered}.*`, 60000)
    // On iOS the driver hides a keyboard by typing a return, which in Tess's
    // multiline field is a new line: the field grows, and on the phone that
    // pushes the end of the conversation out of sight, so there the keyboard
    // stays up.
    if (layout !== 'iphone') await m.hideKeyboard()
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
    // and abort the app; I1–I5 do not talk, so the iPad goes without. The
    // media library is allowed for DJ Game. Mixed answers leave system
    // alerts to the script: all-deny would have the driver dismiss every
    // alert, and it dismisses iOS's "Open in TeamStation?" with Cancel,
    // which throws I5's link away.
    await m.launchApp(
      layout === 'ipad'
        ? { permissions: { microphone: 'deny', medialibrary: 'allow' } }
        : {}
    )
    try {
      await show('E-mail address', 30000)
    } catch {
      return
    }
    // A phone's keyboard sometimes drops or swaps a key under the driver.
    // The form then waits for a code sent to another address; switching to
    // a password and back offers to send one again.
    let code: string | null = null
    for (let attempt = 1; code == null; attempt++) {
      if (attempt > 3) throw new Error('No sign-in code was sent')
      if (attempt > 1) {
        await tap('Use a password instead')
        await tap('Use a sign-in code')
      }
      await tap('E-mail address')
      await m.eraseText({ characters: 60 })
      await m.inputText({ text: manifest.email })
      await m.hideKeyboard()
      await m.tapOn({ text: 'Send me a sign-in code', optional: true })
      await show('.*six-digit code.*', 30000)
      for (let waited = 0; code == null && waited < 5000; waited += 1000) {
        code = (
          await control<{ code: string | null }>(
            `/code?email=${encodeURIComponent(manifest.email)}`
          )
        ).code
        if (code == null)
          await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
    for (let attempt = 1; ; attempt++) {
      await tap('Sign-in code')
      await m.eraseText({ characters: 12 })
      await m.inputText({ text: code })
      await m.hideKeyboard()
      await m.tapOn({ text: 'Sign in', optional: true })
      try {
        await show('Notifications', 30000)
        return
      } catch (error) {
        if (attempt === 3) throw error
      }
    }
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
      // The title bar reads exactly "Ask Tess" at the top left, after her
      // icon; the empty chat's hint only begins with those words.
      const title = (await exactly('Ask Tess'))?.bounds
      if (title == null) throw new Error('No title reads exactly Ask Tess')
      const close = (await find('Close Tess'))!.bounds!
      expect(title.x, 'the title after the icon').greaterThan(16)
      expect(title.x).lessThan(size.width / 3)
      expect(
        Math.abs(title.y + title.height / 2 - (close.y + close.height / 2))
      ).lessThan(12)
      // The small +: 32 points square.
      expect(plus.width).within(28, 36)
      expect(plus.height).within(28, 36)
      // One line until it grows: no taller than the send button beside it.
      const send = (await find('Send'))!.bounds!
      expect(field.height).lessThanOrEqual(send.height + 8)
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
      // The list ends at the card, whose body pushes the reply above it off
      // a phone's screen, so the card's button is what shows the answer.
      await say(
        'Add a game against Demo Eagles Saturday at 10',
        'Hold to confirm'
      )
      const video = join(out, 'narrow-confirm-trace.mp4')
      await startRecording(video)
      await hold('Hold to confirm', 1000)
      await show('Hold to confirm')
      expect(await gamesOfTeam()).equals(gamesBefore)
      await hold('Hold to confirm', 3500)
      await show('Done', 30000)
      await stopRecording(video)
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
      await startRecording(voice)
      for (let time = 1; time <= 2; time++) {
        await hold('Dictation', 2500)
        await m.tapOn({ text: 'Allow', optional: true, timeout: 3000 })
        // The words under the mic are labelled "Dictation status" for
        // assistive technology, so they are not in the phone's hierarchy;
        // what the fixture heard says the hold was transcribed, and Tess has
        // answered once she stops thinking.
        for (
          let waited = 0;
          (await control<{ heard: string[] }>('/dictation')).heard.length <
          heardBefore + time;
          waited += 1000
        ) {
          if (waited >= 30000) throw new Error(`Hold ${time} was not heard`)
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        await m.assertNotVisible({ id: 'Tess thinking', timeout: 60000 })
      }
      await stopRecording(voice)
      const heard = (await control<{ heard: string[] }>('/dictation')).heard
      expect(
        heard.slice(heardBefore).filter(text => text !== '').length
      ).greaterThanOrEqual(2)
      console.log('N8 two holds became messages')

      // N9: sideways it is still the full-screen chat. An iPhone keeps the
      // app's own screens upright (`PortraitRootViewController`; only the
      // multi-camera view turns), so the driver's rotation is refused and
      // the chat stays as it was, full screen.
      const upright = await screen()
      let turned = true
      try {
        await native.setOrientation({ orientation: 'LANDSCAPE' })
      } catch (error) {
        if (!String(error).includes('Unable To Rotate')) throw error
        turned = false
      }
      await show('Close Tess')
      const sideways = await screen()
      const wideField = (await find('Tess field'))!.bounds!
      expect(wideField.x + wideField.width).greaterThan(sideways.width * 0.6)
      if (!turned) expect(sideways).deep.equals(upright)
      await native
        .setOrientation({ orientation: 'PORTRAIT' })
        .catch((error: unknown) => {
          if (turned) throw error
        })
      console.log(
        turned
          ? 'N9 landscape stays narrow'
          : 'N9 the iPhone keeps the app upright; the chat stays full screen'
      )
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
      await showExactly('Team Settings')
      await show('Close Tess')
      console.log('I2 the pane went to team settings')

      // I3: the viewer over the pane only.
      await say('Show our standings as a table', 'The standings')
      await tap('Open full screen')
      const viewerClose = (await exactly('Close'))!
      expect(viewerClose.bounds!.x).greaterThan(400)
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
      // A simulator asks "Open in TeamStation?" until it has been answered
      // Open once. The link is through once DJ Game shows, or the Apple
      // Music setup that the device's first visit opens over it.
      for (let waited = 0; ; waited += 500) {
        if (waited >= 30000) throw new Error('The DJ link never arrived')
        if (
          (await find('DJ Game')) != null ||
          (await find('apple-music-setup')) != null
        )
          break
        // The alert's own buttons, found exactly; its bounds are the
        // portrait screen's, so the driver taps the button itself.
        if ((await find('Open')) != null && (await find('Cancel')) != null)
          await tap('Open')
        else await new Promise(resolve => setTimeout(resolve, 500))
      }
      // That setup comes a moment after DJ Game; its X reads exactly Close.
      if ((await exactly('Close', 8000)) != null) await tap('Close')
      await hidden('Close Tess')
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
    recorder?.kill()
    await m.detach().catch(() => undefined)
    await daemon.shutdown().catch(() => undefined)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
