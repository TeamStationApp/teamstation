import { join } from 'node:path'

import { expect } from 'chai'

import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { pointAtStack } from '../../../rigs/app/pointAtStack'
import {
  clearSignInLimits,
  flatten,
  type Node
} from '../../../rigs/coach/coachApp'

const APP = 'teamstation-android'

/** The song the phone's music holds: `TS Walkup Fixture`, 0:30 long. */
const FIXTURE = join(
  __dirname,
  '../../../../src/test/fixtures/walkup-fixture.mp3'
)

/** Music and audio, as maestro-d names it: not granted, and never asked yet. */
const NO_MUSIC = { medialibrary: 'unset', storage: 'unset' }

/**
 * Why the preview's playback is not checked: the app reports each walk-up
 * player state to the phone's own log, and maestro-d has no command that
 * reads a device's log.
 */
const NO_DEVICE_LOG =
  "the preview's fade and its 0:05–0:20 playback are read from the app's WalkUpMusic lines in the phone's log, and maestro-d reads no device log"

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const textOf = (node: Node): string => node.text ?? ''

/** The walk-up screens on the Android app, tapped where each node is drawn. */
function walkUpPhone(m: any): {
  texts: () => Promise<string[]>
  tap: (match: (node: Node) => boolean, settle?: number) => Promise<void>
  button: (label: string) => Promise<void>
  exact: (label: string) => Promise<void>
  expectText: (text: string, timeout?: number) => Promise<void>
  readout: (id: string) => Promise<string | undefined>
  openPlayer: (name: string) => Promise<void>
} {
  const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
  const texts = async (): Promise<string[]> =>
    (await nodes()).map(textOf).filter(text => text !== '')
  const tap = async (
    match: (node: Node) => boolean,
    settle = 1200
  ): Promise<void> => {
    // The next screen can take a moment to draw: look for up to 10 s.
    let found: Node | undefined
    for (let tries = 0; tries < 20 && found == null; tries++) {
      found = (await nodes()).find(match)
      if (found == null) await sleep(500)
    }
    if (found?.bounds == null)
      throw new Error(`Nothing to tap: ${String(match)}`)
    const b = found.bounds
    await m.tapOn({
      point: `${Math.round(b.x + b.width / 2)},${Math.round(b.y + b.height / 2)}`
    })
    await sleep(settle)
  }
  const button = async (label: string): Promise<void> => {
    await tap(node => node.type === 'Button' && textOf(node) === label)
  }
  const expectText = async (text: string, timeout = 10000): Promise<void> => {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      if ((await texts()).includes(text)) return
      await sleep(500)
    }
    throw new Error(`Expected "${text}" on screen`)
  }
  const openPlayer = async (name: string): Promise<void> => {
    const until = Date.now() + 8000
    while (Date.now() < until && !(await texts()).includes('Tigers')) {
      if ((await texts()).includes('More teams')) {
        await button('More teams')
        break
      }
      await sleep(400)
    }
    await tap(node => node.type === 'Button' && textOf(node) === 'Tigers')
    await tap(node => node.type === 'View' && textOf(node) === 'Team')
    await m.scrollUntilVisible({
      element: { text: `${name}.*` },
      direction: 'DOWN'
    })
    await tap(node => node.type === 'Button' && textOf(node).startsWith(name))
    await tap(node => node.type === 'View' && textOf(node) === 'Walk-up', 2500)
  }
  return {
    texts,
    tap,
    button,
    exact: async label => {
      await tap(node => textOf(node) === label)
    },
    expectText,
    readout: async id =>
      (await nodes()).find(node => node.id === `walkup-${id}`)?.text,
    openPlayer
  }
}

/**
 * The app signed in as the Tigers' songkeeper with the fixture song in the
 * phone's music and the music permission not yet asked.
 */
async function openWithFixture(ctx: HarnessContext): Promise<any> {
  await ctx.fixture('walk-up')
  const appId = ctx.app(APP)
  const m = ctx.attached('device')
  await m.addMedia({ files: [FIXTURE] })
  await m.launchApp({ appId, clearState: true })
  // A clear forgets the server: the link points the app back at the stack.
  await pointAtStack(m, ctx.stack.origin, appId)
  await clearSignInLimits(ctx)
  await ctx.signIn('songkeeper', m)
  // maestro-d's launch grants every permission unless told otherwise.
  await m.setPermissions({ appId, permissions: NO_MUSIC })
  await m.launchApp({ appId, stopApp: true, permissions: NO_MUSIC })
  await sleep(6000)
  return m
}

/**
 * Walk-up songs from the Android phone's own music (E21, E22): Tom A, with
 * no song, asks for music access; refused, it says so and sends the
 * songkeeper to Settings, where Music and audio is allowed. The phone's
 * music is searched, the fixture is clipped to 0:05–0:20 with the one-second
 * buttons, previewed and saved, then replaced through the system file
 * picker at 0:10–0:25. Blake B's Apple Music song is not on this phone, and
 * its Preview is disabled.
 */
export default defineHarness({
  id: 'scoring/walk-up/local-song-android',
  title:
    'Android sets a walk-up song from the phone after asking for music access, and disables an Apple Music song',
  kind: 'e2e',
  covers: ['src/app/walkup/**'],
  stack: 'isolated',
  fixtures: ['walk-up'],
  exclusive: false,
  surfaces: {
    'android-app': {
      // The music permission, the phone's media store and the system file
      // picker are a real phone's; the legacy script ran on phones only.
      devices: [
        { role: 'device', needs: ['android-phone'], simulator: 'never' }
      ]
    }
  },
  services: [],
  apps: ['teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 10,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'phone-song-after-permission': async ctx => {
      const m = await openWithFixture(ctx)
      const phone = walkUpPhone(m)
      try {
        // E21: Tom A → Set, refused, then allowed from Settings.
        await phone.openPlayer('Tom A')
        if ((await phone.texts()).includes('Remove')) {
          await phone.button('Remove')
          await phone.button('Tap again to remove')
        }
        await phone.expectText('No walk-up song yet')
        await m.takeScreenshot({ path: ctx.artifact('e21-no-song.png') })
        await phone.button('Set')
        await phone.expectText(
          'Allow TeamStation to access music and audio on this device?'
        )
        await m.takeScreenshot({ path: ctx.artifact('e21-permission.png') })
        await phone.button('Don’t allow')
        await phone.expectText('TeamStation can’t see your music')
        await m.takeScreenshot({ path: ctx.artifact('e21-denied.png') })
        await phone.button('Open Settings')
        await m.tapOn({ text: 'Permissions' })
        await m.tapOn({ text: 'Music and audio' })
        await m.tapOn({ text: 'Allow' })
        await sleep(1000)
        await m.back()
        await m.back()
        await m.back()
        await phone.expectText('Music on this phone')
        await m.takeScreenshot({ path: ctx.artifact('e21-allowed.png') })

        // Search, clip 0:05–0:20, Preview, Save.
        await m.tapOn({ text: 'Music on this phone' })
        await m.inputText({ text: 'walkup fixture' })
        await m.hideKeyboard()
        await phone.expectText('On this phone')
        await m.takeScreenshot({ path: ctx.artifact('e21-results.png') })
        await phone.tap(
          node =>
            node.type === 'Button' &&
            textOf(node).startsWith('TS Walkup Fixture')
        )
        for (let i = 0; i < 5; i++) await phone.button('Start 1 s later')
        for (let i = 0; i < 5; i++) await phone.button('End 1 s later')
        expect(await phone.readout('start')).equals('0:05.0')
        expect(await phone.readout('end')).equals('0:20.0')
        await phone.button('Preview')
        await sleep(2500)
        await m.takeScreenshot({ path: ctx.artifact('e21-previewing.png') })
        await sleep(15000)
        await phone.button('Save')
        await phone.expectText('Plays 0:05–0:20')
        await m.takeScreenshot({ path: ctx.artifact('e21-saved.png') })

        // Then Choose a file…, through the system picker.
        await phone.button('Change')
        await phone.button('Pick another song')
        await phone.button('Choose a file…')
        await sleep(2500)
        // The phone's own storage, which the picker always lists, by the
        // free space it shows under its name; its Audio root comes and goes.
        const storage = async (): Promise<Node | undefined> =>
          flatten(await m.hierarchy()).find(node =>
            /\d.*\s(GB|MB|TB) free$/.test(textOf(node))
          )
        for (let i = 0; i < 3 && (await storage()) == null; i++) {
          await phone.tap(node => textOf(node) === 'Show roots')
        }
        const free = (await storage())?.bounds
        if (free == null) throw new Error("The picker lists no phone's storage")
        await m.tapOn({
          point: `${Math.round(free.x + free.width / 2)},${Math.round(free.y - free.height / 2)}`
        })
        await sleep(1200)
        await phone.exact('Music')
        await phone.tap(node => textOf(node) === 'walkup-fixture.mp3', 3000)
        await phone.expectText('TS Walkup Fixture')
        for (let i = 0; i < 10; i++) await phone.button('Start 1 s later')
        for (let i = 0; i < 10; i++) await phone.button('End 1 s later')
        await phone.button('Save')
        await phone.expectText('Plays 0:10–0:25')
        await m.takeScreenshot({ path: ctx.artifact('e21-file-saved.png') })
      } catch (error) {
        await m
          .takeScreenshot({ path: ctx.artifact('failure.png') })
          .catch(() => undefined)
        throw error
      }
      // Everything on screen passed; the preview's own playback is unread.
      throw new BlockedError(NO_DEVICE_LOG)
    },
    'apple-music-song-not-on-phone': async ctx => {
      const m = await openWithFixture(ctx)
      const phone = walkUpPhone(m)
      // E22: B's Apple Music song is not on this phone.
      await phone.openPlayer('Blake B')
      await phone.expectText('Not on this phone')
      await phone.button('Preview: Not on this phone')
      await m.takeScreenshot({ path: ctx.artifact('e22-not-here.png') })
      // That the disabled Preview played nothing is read from the phone's log.
      throw new BlockedError(NO_DEVICE_LOG)
    }
  }
})
