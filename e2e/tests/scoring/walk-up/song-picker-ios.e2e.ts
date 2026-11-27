import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  COACH_APP,
  flatten,
  type Node,
  openCoachApp
} from '../../../rigs/coach/coachApp'

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A node's text, as the phone reports it. */
const textOf = (node: Node): string => node.text ?? ''

const FADE = 'Fade Apple Music using the phone’s volume'

/** The walk-up screens on the iPhone app, tapped where each node is drawn. */
function walkUpPhone(m: any): {
  texts: () => Promise<string[]>
  tap: (match: (node: Node) => boolean, settle?: number) => Promise<void>
  button: (label: string) => Promise<void>
  goHome: () => Promise<void>
  openB: () => Promise<void>
  openAccount: () => Promise<void>
} {
  const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
  const texts = async (): Promise<string[]> =>
    (await nodes()).map(textOf).filter(text => text !== '')
  const tap = async (
    match: (node: Node) => boolean,
    settle = 2000
  ): Promise<void> => {
    // The next screen can take a moment to draw: look for up to 10 s.
    let found: Node | undefined
    for (let tries = 0; tries < 20 && found == null; tries++) {
      found = (await nodes()).find(match)
      if (found == null) await sleep(500)
    }
    if (found?.bounds == null)
      throw new Error(`Nothing to tap: ${String(match)}`)
    const { x, y, width, height } = found.bounds
    await m.tapOn({
      point: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
    })
    await sleep(settle)
  }
  const button = async (label: string): Promise<void> => {
    await tap(node => node.type === 'Button' && textOf(node) === label)
  }
  /** The Home tab, pressed until Home shows: a relaunch reopens the last page. */
  const goHome = async (): Promise<void> => {
    for (let i = 0; i < 4 && !(await texts()).includes('Your Home'); i++) {
      await tap(node => node.type === 'Other' && textOf(node) === 'Home')
    }
    expect(await texts(), 'Home is showing').includes('Your Home')
  }
  const openB = async (): Promise<void> => {
    await goHome()
    const until = Date.now() + 8000
    while (Date.now() < until && !(await texts()).includes('Tigers')) {
      if ((await texts()).includes('More teams')) {
        await button('More teams')
        break
      }
      await sleep(400)
    }
    await tap(node => node.type === 'Button' && textOf(node) === 'Tigers')
    await tap(node => textOf(node) === 'Team')
    await tap(
      node => node.type === 'Button' && textOf(node).startsWith('Blake B'),
      3500
    )
  }
  const openAccount = async (): Promise<void> => {
    await goHome()
    await tap(
      node => node.type === 'Button' && textOf(node).startsWith('Account,')
    )
    await button('Account')
    await m.scrollUntilVisible({
      element: { text: 'Sign out' },
      direction: 'DOWN'
    })
  }
  return { texts, tap, button, goHome, openB, openAccount }
}

async function relaunch(ctx: HarnessContext, m: any): Promise<void> {
  await m.launchApp({ appId: ctx.app(COACH_APP), stopApp: true })
  await sleep(5000)
}

/**
 * Walk-up songs on the iPhone: the Account screen's fade switch, which only
 * an iPhone shows, keeps its setting across a relaunch; Blake B's song opens
 * for Change and Apple Music is searched, which either lists songs with the
 * Apple Music badge or, with no subscription or MusicKit service, shows
 * Apple's error with Retry rather than crashing. A plain member sees no
 * Walk-up tab on Blake B's page.
 */
export default defineHarness({
  id: 'scoring/walk-up/song-picker-ios',
  title:
    'The iPhone keeps the walk-up fade setting, searches Apple Music for a song, and hides Walk-up from a member',
  kind: 'e2e',
  covers: ['src/app/walkup/**', 'src/app/screens/AccountScreen.tsx'],
  stack: 'isolated',
  fixtures: ['walk-up'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      // Apple Music's catalogue and MusicKit answer only on a real iPhone.
      devices: [{ role: 'device', needs: ['ios-phone'], simulator: 'never' }]
    }
  },
  services: [],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 6,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'fade-switch-and-apple-music': async ctx => {
      await ctx.fixture('walk-up')
      const { m } = await openCoachApp(ctx, 'songkeeper')
      const phone = walkUpPhone(m)
      const fadeSwitch = async (): Promise<Node | undefined> =>
        flatten(await m.hierarchy()).find(
          node => node.type === 'Switch' && textOf(node) === FADE
        )
      try {
        // The fade setting: iPhone only, on by default, kept across a launch.
        await phone.openAccount()
        expect(
          await fadeSwitch(),
          'The Walk-up songs switch is on the iPhone'
        ).not.equals(undefined)
        await m.takeScreenshot({
          path: ctx.artifact('account-fade-switch.png')
        })
        await phone.tap(node => node.type === 'Switch' && textOf(node) === FADE)
        await m.takeScreenshot({
          path: ctx.artifact('account-fade-flipped.png')
        })
        await relaunch(ctx, m)
        await phone.openAccount()
        await m.takeScreenshot({
          path: ctx.artifact('account-fade-after-relaunch.png')
        })
        await phone.tap(node => node.type === 'Switch' && textOf(node) === FADE)
        await m.takeScreenshot({ path: ctx.artifact('account-fade-back.png') })

        // The picker, on Apple Music.
        await relaunch(ctx, m)
        await phone.openB()
        await phone.tap(node => textOf(node) === 'Walk-up', 4000)
        await m.takeScreenshot({ path: ctx.artifact('b-walkup.png') })
        const change = (await phone.texts()).includes('Change')
          ? 'Change'
          : 'Set'
        await phone.button(change)
        if (change === 'Change') await phone.button('Pick another song')
        const shown = await phone.texts()
        if (!shown.includes('SEARCH')) {
          await m.takeScreenshot({ path: ctx.artifact('access.png') })
          throw new Error(`Music access is not granted: ${shown.join(' / ')}`)
        }
        await phone.tap(
          node => node.type === 'TextField' && textOf(node) === 'Search',
          800
        )
        await m.inputText({ text: 'centerfield' })
        await sleep(6000)
        await m.takeScreenshot({ path: ctx.artifact('search-centerfield.png') })
        const after = await phone.texts()
        if (!after.includes('Apple Music')) {
          expect(after, 'A failed search offers Retry').includes('Retry')
          const said = flatten(await m.hierarchy()).find(
            node =>
              node.type === 'StaticText' &&
              textOf(node) !== 'SEARCH' &&
              !textOf(node).startsWith('Playing music') &&
              !textOf(node).startsWith('Walk-up song for')
          )
          ctx.degrade(
            `Apple Music answered with an error, not songs: "${textOf(said ?? {})}"`
          )
        }
      } catch (error) {
        await m
          .takeScreenshot({ path: ctx.artifact('failure.png') })
          .catch(() => undefined)
        throw error
      }
    },
    'member-has-no-walk-up': async ctx => {
      await ctx.fixture('walk-up')
      const { m } = await openCoachApp(ctx, 'member')
      const phone = walkUpPhone(m)
      await phone.openB()
      const shown = await phone.texts()
      expect(shown, 'B’s page is open').includes('Stats')
      expect(shown, 'M has no Walk-up tab').not.includes('Walk-up')
      await m.takeScreenshot({ path: ctx.artifact('e23-no-walkup-tab.png') })
    }
  }
})
