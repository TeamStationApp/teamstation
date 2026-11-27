import { expect } from 'chai'

import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { pointAtStack } from '../../../rigs/app/pointAtStack'
import {
  clearSignInLimits,
  COACH_APP,
  flatten,
  type Node,
  openCoachApp,
  type Rect
} from '../../../rigs/coach/coachApp'

/**
 * Why the notice's once-per-device scenarios block: they reset only the
 * flag that says the notice was shown, keeping the walkthrough's, in the
 * app's stored data. maestro-d's clearState removes all of it (and the
 * session), and no command edits one key of an app's storage.
 */
const ONE_FLAG =
  "this scenario resets only the walk-up readiness flag promptShown in the app's stored data, keeping the walkthrough's; maestro-d clears an app's whole state or none of it"

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const labelOf = (node: Node): string =>
  node.text ?? node.accessibilityText ?? ''

interface DjPhone {
  m: any
  find: (
    label: string,
    wait?: number,
    prefix?: boolean,
    below?: number
  ) => Promise<Node>
  tap: (
    label: string,
    settle?: number,
    prefix?: boolean,
    below?: number
  ) => Promise<void>
  shows: (text: string) => Promise<boolean>
  shot: (name: string) => Promise<void>
  dragAt: (x: number, y: number, dx: number) => Promise<void>
  drag: (label: string, dx: number) => Promise<void>
  readout: (which: 'Start' | 'End') => Promise<number>
  home: () => Promise<void>
  openDj: () => Promise<void>
  leave: () => Promise<void>
  relaunch: () => Promise<void>
  onboarding: () => Promise<boolean>
  notice: () => Promise<boolean>
}

function centre(bounds: Rect): string {
  return `${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)}`
}

/**
 * The DJ Game on the iPhone app as the songkeeper walks to it: Home, the
 * Tigers, their Schedule, the game against the Cubs, Record. Every tap is at
 * the point a node's bounds give.
 */
function djPhone(ctx: HarnessContext, m: any): DjPhone {
  const appId = ctx.app(COACH_APP)
  const nodes = async (): Promise<Node[]> => flatten(await m.hierarchy())
  /** The phone's height, from the screen's own root. */
  const screenHeight = async (): Promise<number> => {
    const root = (await m.hierarchy()) as Node
    return (
      root.bounds?.height ??
      Math.max(
        ...(await nodes()).map(
          n => (n.bounds?.y ?? 0) + (n.bounds?.height ?? 0)
        )
      )
    )
  }
  const labels = async (): Promise<string[]> =>
    (await nodes()).map(labelOf).filter(label => label !== '')
  const find = async (
    label: string,
    wait = 10000,
    prefix = false,
    below?: number
  ): Promise<Node> => {
    const bottom = below ?? (await screenHeight())
    for (const until = Date.now() + wait; ;) {
      const matches = (await nodes()).filter(
        node =>
          (prefix
            ? labelOf(node).startsWith(label)
            : labelOf(node) === label) &&
          node.bounds != null &&
          node.bounds.width > 0 &&
          // On screen: a list also reports the rows scrolled out of view.
          node.bounds.y >= 0 &&
          node.bounds.y + node.bounds.height / 2 < bottom
      )
      // A row is found by how it begins; an exact label takes the smallest
      // match, as a scrim shares the label of the button on it.
      const area = (node: Node): number =>
        node.bounds!.width * node.bounds!.height
      const found = prefix
        ? matches[0]
        : matches.sort((a, b) => area(a) - area(b))[0]
      if (found != null) return found
      if (Date.now() > until) throw new Error(`Nothing labelled ${label}`)
      await sleep(500)
    }
  }
  const tap = async (
    label: string,
    settle = 1500,
    prefix = false,
    below?: number
  ): Promise<void> => {
    const node = await find(label, 10000, prefix, below)
    await m.tapOn({ point: centre(node.bounds!) })
    await sleep(settle)
  }
  const shows = async (text: string): Promise<boolean> =>
    (await labels()).some(label => label.includes(text))
  // A drag is a finger that presses, rests and moves slowly: React Native's
  // responders take a quick swipe as a flick, not a drag.
  const dragAt = async (x: number, y: number, dx: number): Promise<void> => {
    await m.dragAndDrop({
      from: { point: `${x},${y}` },
      to: { point: `${Math.round(x + dx)},${y}` },
      holdDuration: 150,
      duration: 12 * 160
    })
    await sleep(800)
  }
  const home = async (): Promise<void> => {
    const height = await screenHeight()
    for (let i = 0; i < 4 && !(await shows('Your Home')); i++) {
      // The tab bar's Home, not a team pill's "Home" above it.
      const tab = (await nodes()).find(
        node =>
          labelOf(node) === 'Home' &&
          node.bounds != null &&
          node.bounds.y > height - 152
      )
      if (tab?.bounds != null) await m.tapOn({ point: centre(tab.bounds) })
      await sleep(1500)
    }
    expect(await shows('Your Home'), 'Home is showing').equals(true)
  }
  return {
    m,
    find,
    tap,
    shows,
    shot: async name => {
      await m.takeScreenshot({ path: ctx.artifact(name) })
    },
    dragAt,
    drag: async (label, dx) => {
      const { bounds } = await find(label)
      await dragAt(
        Math.round(bounds!.x + bounds!.width / 2 - dx / 2),
        Math.round(bounds!.y + bounds!.height / 2),
        dx
      )
    },
    readout: async which => {
      const all = await nodes()
      const label = all.find(node => labelOf(node) === which)
      if (label?.bounds == null) throw new Error(`No ${which} readout`)
      const value = all.find(
        node =>
          node.bounds != null &&
          /^\d+:\d\d\.\d$/.test(labelOf(node)) &&
          Math.abs(node.bounds.y - label.bounds!.y) < 6
      )
      if (value == null) throw new Error(`No ${which} value`)
      const [minutes, rest] = labelOf(value).split(':')
      return Math.round((Number(minutes) * 60 + Number(rest)) * 1000)
    },
    home,
    openDj: async () => {
      await home()
      for (let i = 0; i < 20 && !(await shows('Tigers')); i++) {
        if (await shows('More teams')) {
          await tap('More teams', 500)
          break
        }
        await sleep(400)
      }
      await tap('Tigers', 3000, true)
      // The team's own Schedule section, not the tab bar's Schedule.
      await tap('Schedule', 2500, false, (await screenHeight()) - 120)
      // The game against the Cubs, however its row begins.
      const game = (await nodes()).find(
        node => labelOf(node).includes('Cubs') && node.bounds != null
      )
      if (game?.bounds == null) throw new Error('No game against the Cubs')
      await m.tapOn({ point: centre(game.bounds) })
      await sleep(4000)
      await tap('Record', 5000)
    },
    leave: async () => {
      await tap('Back', 1500)
    },
    relaunch: async () => {
      await m.killApp({ appId })
      await sleep(1500)
      await m.launchApp({ appId })
      await sleep(7000)
    },
    onboarding: async () => await shows('TeamStation DJ, enable the following'),
    notice: async () =>
      await shows('Some walk-up songs still need to be downloaded')
  }
}

async function opened(ctx: HarnessContext): Promise<DjPhone> {
  await ctx.fixture('walk-up')
  const app = await openCoachApp(ctx, 'songkeeper')
  return djPhone(ctx, app.m)
}

/** Runs `steps`, keeping the screen when one fails. */
async function guarded(
  phone: DjPhone,
  name: string,
  steps: () => Promise<void>
): Promise<void> {
  try {
    await steps()
  } catch (error) {
    await phone.shot(`failure-${name}.png`).catch(() => undefined)
    throw error
  }
}

/**
 * Walk-up songs offline on the iPhone, as the Tigers' songkeeper and
 * scorekeeper: the clip editor's jog wheel moves a clip a quarter as fast as
 * the timeline, the Apple Music walkthrough from Account pages through and
 * hands over to Settings, and the DJ Game's first visit opens the
 * walkthrough by itself. (No DJ Game on Android, and downloads with
 * airplane-mode playback through the Music and Settings apps, are checked
 * by hand.)
 */
export default defineHarness({
  id: 'scoring/walk-up/dj-game',
  title:
    'The iPhone DJ Game jogs a clip finely, walks through Apple Music setup, and opens the walkthrough on a first visit',
  kind: 'e2e',
  covers: ['src/app/walkup/**'],
  stack: 'isolated',
  fixtures: ['walk-up'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      // Apple Music and the Settings hand-off are a real iPhone's.
      devices: [{ role: 'device', needs: ['ios-phone'], simulator: 'never' }]
    }
  },
  services: [],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 8,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'clip-jog-wheel': async ctx => {
      const phone = await opened(ctx)
      await guarded(phone, 'E1', async () => {
        const { m } = phone
        await phone.relaunch()
        await phone.openDj()
        // The away side's pill, under its "Away" label: the Tigers' side.
        const away = await phone.find('Away')
        await m.tapOn({
          point: `${Math.round(away.bounds!.x + away.bounds!.width / 2)},${Math.round(away.bounds!.y + 31)}`
        })
        await sleep(2000)
        // The first batter with a song: its picker opens on the clip.
        await phone.tap('Set ', 4000, true)
        const jog = await phone.find(
          'Fine adjust: drag to move the clip slowly'
        )
        const startLabel = await phone.find('Start')
        expect(startLabel.bounds!.y, 'the times sit above the wheel').lessThan(
          jog.bounds!.y
        )
        await phone.shot('clip-editor-after.png')
        const before = await phone.readout('Start')
        await phone.drag('Fine adjust: drag to move the clip slowly', 160)
        const jogged = (await phone.readout('Start')) - before
        // Back to the start, then the same move on the timeline, a quarter as far.
        await phone.leave()
        await phone.tap('Set ', 4000, true)
        const again = await phone.readout('Start')
        expect(again, 'nothing was saved').equals(before)
        const wheel = await phone.find(
          'Fine adjust: drag to move the clip slowly'
        )
        const y = Math.round(wheel.bounds!.y - 16 - 24)
        const x = Math.round(wheel.bounds!.x + wheel.bounds!.width / 2 - 20)
        await phone.dragAt(x, y, 40)
        const slid = (await phone.readout('Start')) - before
        expect(jogged > 0 && slid > 0, 'both moved the clip').equals(true)
        expect(
          Math.abs(jogged - slid),
          'the wheel is a quarter as fast'
        ).at.most(400)
        await phone.leave()
      })
    },
    'apple-music-walkthrough': async ctx => {
      const phone = await opened(ctx)
      await guarded(phone, 'E4', async () => {
        const { m } = phone
        await phone.relaunch()
        await phone.home()
        await phone.tap('Account, ', 1500, true)
        await phone.tap('Account', 2500)
        await m.scrollUntilVisible({
          element: { text: 'Sign out' },
          direction: 'DOWN'
        })
        await sleep(1000)
        await phone.shot('account-walkup-after.png')
        await phone.tap('Apple Music settings')
        expect(
          await phone.shows('TeamStation DJ, enable the following'),
          'page 1'
        ).equals(true)
        await phone.shot('onboarding-1.png')
        await phone.tap('Next')
        expect(await phone.shows('Settings › Apps › Music'), 'page 2').equals(
          true
        )
        await phone.shot('onboarding-2.png')
        await phone.tap('Next')
        expect(
          await phone.shows('don’t download by themselves'),
          'page 3'
        ).equals(true)
        await phone.shot('onboarding-3.png')
        await phone.tap('Back')
        expect(
          await phone.shows('don’t download by themselves'),
          'back to 2'
        ).equals(false)
        await phone.tap('Next')
        await phone.tap('Go to Settings', 3000)
        expect(
          await phone.shows('Settings › Apps › Music'),
          'Settings opened'
        ).equals(false)
        await m.launchApp({ appId: ctx.app(COACH_APP) })
        await sleep(2500)
        await phone.tap('Done')
        expect(
          await phone.shows('Settings › Apps › Music'),
          'Done closed it'
        ).equals(false)
        await phone.tap('Apple Music settings')
        await phone.tap('Close')
        expect(
          await phone.shows('TeamStation DJ, enable the following'),
          'Close closed it'
        ).equals(false)
      })
    },
    // Every readiness flag gone: the app's state cleared, the app pointed at
    // the stack again and the songkeeper signed back in.
    'first-visit-walkthrough': async ctx => {
      const phone = await opened(ctx)
      const { m } = phone
      const appId = ctx.app(COACH_APP)
      await guarded(phone, 'E5', async () => {
        await m.launchApp({ appId, clearState: true })
        await pointAtStack(m, ctx.stack.origin, appId)
        await clearSignInLimits(ctx)
        await ctx.signIn('songkeeper', m)
        await phone.relaunch()
        await phone.openDj()
        await sleep(3000)
        expect(
          await phone.onboarding(),
          'the walkthrough opened by itself'
        ).equals(true)
        expect(await phone.notice(), 'no notice behind it').equals(false)
        await phone.shot('dj-first-visit-onboarding.png')
        await phone.tap('Close')
        expect(await phone.onboarding(), 'closed').equals(false)
      })
    },
    // The notice for songs still waiting shows once per device, and Ignore
    // closes it.
    'songs-notice-once': async () => {
      throw new BlockedError(ONE_FLAG)
    },
    // The notice's Go to Settings closes it and opens the walkthrough.
    'songs-notice-to-settings': async () => {
      throw new BlockedError(ONE_FLAG)
    }
  }
})
