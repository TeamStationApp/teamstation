import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { PARK } from '../../src/common/scoring/park'
import { signInTestAccount } from '../../src/test/passwordFixtures'
import { faultControl, requireDropletHandle } from '../core/dropletStack'
import type { FixtureManifest } from '../core/fixtures'
import { isHubDevice, type MaestroDevice } from '../core/maestro'
import { iosIsSimulator } from '../core/prepare'
import { eventually, readJson } from '../core/readback'
import type { E2eContext } from '../core/spec'
import { boxOf, flatten, type Node } from './app/keyboardDock'
import { appLink, openInApp, serverLink, setServer } from './app/setServer'
import { clearSignInLimits, labelOf } from './coach/coachApp'
import { browserAppOf, signInOnPhone } from './mobileWeb'
import { scoringFixtureLink } from './scoringFixtureLink'
import { remotePitch } from './scoringLayout'
import { freshReading, type Reading, type ViewportBox } from './scoringViewport'
import { signInViewportScorer } from './scoringViewportPhone'
import { signOutApp } from './streaming/soakSignIn'

type Orientation = 'LANDSCAPE_LEFT' | 'PORTRAIT'
type Control = ReturnType<typeof faultControl>
type Layout = { camera?: unknown } & Pick<
  Reading,
  | 'documentId'
  | 'root'
  | 'holder'
  | 'deck'
  | 'face'
  | 'strip'
  | 'side'
  | 'boxScore'
  | 'log'
  | 'logBand'
  | 'notice'
  | 'noticeText'
  | 'logText'
  | 'undo'
  | 'collapsed'
  | 'landmarks'
  | 'menu'
  | 'buttons'
>

function fromHierarchy(tree: Node): Layout {
  const nodes = flatten(tree)
  const byId = (id: string): Node | undefined =>
    nodes.find(n => n.id?.split('/').at(-1) === id)
  const rect = (node: Node | undefined): ViewportBox | undefined => {
    const b = boxOf(node)
    return b == null
      ? undefined
      : {
          left: b.x,
          top: b.y,
          width: b.width,
          height: b.height,
          right: b.x + b.width,
          bottom: b.y + b.height
        }
  }
  const named = (id: string): ViewportBox | undefined => rect(byId(id))
  const logRows = flatten(byId('remote-scoring-update-lines'))
    .map(labelOf)
    .filter(value => value !== '' && !value.includes('scroll bar,'))
  const notice = byId('scoringNotice')
  const probe = byId('scoring-projection-reader')
  const holder = named('scoring-field-holder')
  let landmarks: Reading['landmarks']
  let camera: unknown
  if (probe != null && holder != null) {
    const data = JSON.parse(labelOf(probe)) as {
      size: { width: number; height: number }
      corners: Array<[number, number]>
      board: { top: number; width: number }
    }
    const scale = holder.width / data.size.width
    if (Math.abs(holder.height - data.size.height * scale) <= 1)
      landmarks = {
        corners: data.corners.map(([x, y]) => [
          holder.left + x * scale,
          holder.top + y * scale
        ]),
        board: {
          top: holder.top + data.board.top * scale,
          width: data.board.width * scale
        }
      }
    camera = data
  }
  return {
    documentId: 'native',
    landmarks,
    camera,
    root: named('baseball-screen'),
    holder: named('scoring-field-holder'),
    face: named('scoring-catcher-face'),
    deck: named('scoring-deck'),
    strip: named('scoring-notice-strip'),
    side: named('scoring-side'),
    boxScore: named('replay-box-score'),
    log: named('remote-scoring-updates'),
    logBand: named('scoring-log-band'),
    logText: logRows.join(' '),
    notice: rect(notice),
    noticeText: flatten(notice).map(labelOf).join(' '),
    menu: rect(nodes.find(n => labelOf(n) === 'Open scoring menu')),
    undo: nodes.map(labelOf).find(s => s.startsWith('Undo ')),
    collapsed: nodes.some(n => labelOf(n) === 'Expand scoring updates')
  }
}

// The report text mounts before its 200 ms slide finishes.
function noticeHasArrived(layout: Layout): boolean {
  return (
    layout.notice != null &&
    layout.strip != null &&
    Math.abs(layout.notice.bottom - layout.strip.bottom) <= 1
  )
}

function verify(layout: Layout, androidPixels: boolean): void {
  const {
    root,
    holder,
    face,
    deck,
    strip,
    side,
    boxScore,
    log,
    menu,
    landmarks
  } = layout
  expect(root, 'scoring root').not.equals(undefined)
  expect(deck, 'scoring controls').not.equals(undefined)
  // iOS accessibility uses points and the browser uses CSS pixels. Only
  // Android reports physical pixels; iOS rounds each accessible edge separately.
  const scale = androidPixels ? deck!.height / 120 : 1
  expect(deck!.height / scale).closeTo(120, 1)
  const close = (a: number, b: number): void => {
    expect(a).closeTo(b, scale * 1.5)
  }
  const two = root!.width / scale >= 819.9 && root!.height / scale >= 639.9
  expect(side != null).equals(two)
  expect(boxScore != null).equals(two)
  close(holder!.left, root!.left)
  close(holder!.right, strip!.right)
  close(holder!.bottom, root!.bottom)
  close(strip!.bottom, root!.bottom)
  close(deck!.top - face!.bottom, 4 * scale)
  if (two) {
    close(side!.width, 360 * scale)
    close(side!.left, holder!.right)
    close(side!.right, root!.right)
    if (log != null) {
      expect(log.left).at.least(side!.left - scale)
      expect(log.bottom).at.most(boxScore!.top + scale)
    }
  } else if (log != null) close(log.top - deck!.bottom, 8 * scale)
  if (landmarks != null) {
    close(landmarks.board.top, menu!.bottom + 8 * scale)
    if (two)
      for (const [x, y] of landmarks.corners) {
        expect(x).within(holder!.left, holder!.right)
        expect(y).within(holder!.top, holder!.bottom)
      }
  }
  if (layout.notice != null) {
    close(layout.notice.left, holder!.left)
    close(layout.notice.right, holder!.right)
    close(layout.notice.bottom, strip!.bottom)
  }
}

async function openMobile(
  ctx: E2eContext,
  world: FixtureManifest,
  control: Control
): Promise<{
  m: MaestroDevice
  read: () => Promise<Layout>
  tap: (label: string) => Promise<void>
}> {
  const web = ctx.surface.startsWith('web-')
  const { platform, appId } = web
    ? browserAppOf(ctx.surface)
    : {
        platform:
          ctx.surface === 'ios-app' ? ('ios' as const) : ('android' as const),
        appId: 'app.teamstation.develop'
      }
  const udid = ctx.device('phone')
  const m = await ctx.attach('phone', { platform, appId })
  const origin = process.env.TS_SCORING_DEVICE_ORIGIN ?? ctx.stack.origin
  await m.setOrientation({ orientation: 'PORTRAIT' })
  await clearSignInLimits(ctx)
  let read: () => Promise<Layout>
  if (web) {
    await m.launchApp({ appId, stopApp: false })
    if (isHubDevice(udid)) {
      await signInViewportScorer(ctx, m, world.accounts.scorekeeper)
    } else if (platform === 'ios') {
      const link = await scoringFixtureLink(
        ctx,
        world.accounts.scorekeeper.email,
        'web'
      )
      try {
        await m.openLink({
          link: origin + '/' + link.replace('signin/', 'signin-browser/'),
          browser: true
        })
      } catch {
        throw new Error('Safari could not open the fixture sign-in link')
      }
      await m.tapOn({ text: '^Continue$', optional: true, timeout: 2500 })
      await m.tapOn({ text: 'Not Now', optional: true, timeout: 2000 })
      await m.assertVisible({
        text: 'Your Home|TeamStation menu',
        timeout: 35000
      })
      await m.openLink({ link: origin + '/api/v1/auth/me', browser: true })
      await m.assertVisible({
        text: '.*' + world.accounts.scorekeeper.userId + '.*',
        timeout: 12000
      })
    } else await signInOnPhone(m, world.accounts.scorekeeper, origin, false)
    const run = randomUUID()
    const query = new URLSearchParams({
      run,
      game: world.ids.game,
      geometry: '1',
      radius: String(PARK.outfieldRadius),
      angle: String(PARK.outfieldHalfAngle)
    })
    await m.openLink({
      link: origin + '/viewportProbe/scoring.html?' + query.toString(),
      browser: true
    })
    if (
      platform === 'ios' &&
      !isHubDevice(udid) &&
      iosIsSimulator(udid) &&
      process.env.TS_SCORING_PRIVATE_SAFARI === '1'
    ) {
      // A fresh simulator holds the two tabs opened by this fixture's sign-in.
      // Leave scoring in one tab so Safari's tab row doesn't reduce its 100svh.
      const tabs = flatten((await m.hierarchy()) as Node).filter(
        n => n.id?.startsWith('TabBarTab?isActive=') === true
      )
      const inactive = tabs.filter(
        n => n.id?.includes('isActive=false') === true
      )
      if (
        new Set(tabs.map(tab => tab.id)).size === 3 &&
        inactive.length === 2 &&
        inactive.some(n => labelOf(n) === 'TeamStation') &&
        inactive.some(n =>
          labelOf(n).includes(new URL(origin).host + '/api/v1/auth/me')
        )
      ) {
        await m.longPressOn({
          id: 'TabBarTab\\?isActive=true.*',
          duration: 900
        })
        await m.tapOn({ text: 'Close Other Tabs', timeout: 5000 })
      }
    }
    const fresh = freshReading(control, run)
    read = async () =>
      await fresh('scoring', r => r.landmarks != null && r.face != null)
  } else {
    const hub = isHubDevice(udid)
    const options = {
      platform,
      udid,
      appId,
      device: m,
      hub,
      simulator: platform === 'ios' && !hub && iosIsSimulator(udid)
    }
    if (platform === 'ios') {
      // iOS does not expose the native server-change alert to WDA.
      // A successful sign-in with this stack's fresh account verifies the switch.
      await openInApp({ ...options, link: serverLink('ios', origin) })
      await m.assertVisible({
        text: 'Sign in to TeamStation|Your Home|Account, .*',
        timeout: 30000
      })
      await m.launchApp({ appId, stopApp: true })
    } else await setServer({ ...options, origin })
    if (
      (await m.assertVisible({ text: 'Account, .*', timeout: 2000 }).then(
        () => true,
        () => false
      )) === true
    )
      await signOutApp(m)
    const signIn = await scoringFixtureLink(
      ctx,
      world.accounts.scorekeeper.email,
      platform
    )
    try {
      await openInApp({ ...options, link: appLink(signIn) })
    } catch {
      throw new Error('The scoring fixture sign-in link did not open')
    }
    await m.tapOn({ id: 'signInLinkSignIn', optional: true, timeout: 4500 })
    await m.assertVisible({ text: 'Your Home', timeout: 35000 })
    await openInApp({
      ...options,
      link: appLink('games/' + world.ids.game + '/score')
    })
    await m.assertVisible({ id: 'scoring-catcher-face', timeout: 60000 })
    read = async () => fromHierarchy((await m.hierarchy()) as Node)
  }
  async function tap(label: string): Promise<void> {
    if (
      ctx.surface === 'web-safari-ios' &&
      (label === 'Ball' || label === 'Called Strike')
    ) {
      // A side-column box score can repeat the pitch label as static text.
      // Tap its actual scoring button after the preceding remote play settles.
      let button: ReturnType<typeof boxOf>
      await eventually(async () => {
        const layout = await read()
        expect(layout.buttons?.[label], 'enabled ' + label).not.equals(
          undefined
        )
        const nodes = flatten((await m.hierarchy()) as Node)
        button = boxOf(
          nodes.find(n => /button/i.test(n.type ?? '') && labelOf(n) === label)
        )
        expect(button, 'accessible ' + label + ' button').not.equals(undefined)
      }, 15000)
      await m.tapOn({
        point:
          Math.round(button!.x + button!.width / 2) +
          ',' +
          Math.round(button!.y + button!.height / 2)
      })
      return
    }
    try {
      await m.tapOn({ text: '^' + label + '$', timeout: web ? 2500 : 10000 })
    } catch (err) {
      if (!web) throw err
      const data = await read()
      const button = data.buttons?.[label]
      const viewport = boxOf(
        flatten((await m.hierarchy()) as Node).find(
          n =>
            /WebView|webview/i.test(n.type ?? '') && (boxOf(n)?.width ?? 0) > 0
        )
      )
      if (button == null || viewport == null || data.root == null) throw err
      const scale = viewport.width / data.root.width
      await m.tapOn({
        point:
          Math.round(viewport.x + (button.left + button.width / 2) * scale) +
          ',' +
          Math.round(viewport.y + (button.top + button.height / 2) * scale)
      })
    }
  }
  return { m: m as MaestroDevice, read, tap }
}

async function exercise(
  ctx: E2eContext,
  orientations: Orientation[],
  ipad: boolean
): Promise<void> {
  const world = await ctx.fixture('coach-game')
  const attached = ctx.stack.attached
  if (attached == null)
    throw new Error('Scoring network verification needs an isolated droplet')
  const control = faultControl(requireDropletHandle(attached).faults!)
  const network = 'network-gate/' + world.ids.game
  const eventGate = 'event-gate/' + world.ids.game
  const token = await signInTestAccount(
    ctx.stack.origin + '/api/v1',
    world.accounts.coach
  )
  const counts = async (): Promise<string[]> => {
    const events = await readJson(
      ctx.stack.origin,
      '/api/v1/games/' + world.ids.game + '/events',
      { headers: { authorization: 'Bearer ' + token } }
    )
    return Array.from(
      JSON.stringify(events).matchAll(/"call":\{"code":"([^"]+)"/g),
      m => m[1]
    )
  }
  const { m, read, tap } = await openMobile(ctx, world, control)
  const first = await read()
  if (process.env.TS_SCORING_PROJECTION === '1')
    await eventually(async () => {
      expect((await read()).landmarks).not.equals(undefined)
    }, 30000)
  const peer = await remotePitch(ctx, world)
  const wait = async (test: (l: Layout) => boolean): Promise<Layout> => {
    let found: Layout
    await eventually(
      async () => {
        found = await read()
        expect(
          test(found),
          JSON.stringify({
            side: found.side != null,
            rows: found.logText,
            band: found.logBand?.height,
            notice: found.noticeText,
            undo: found.undo,
            root: found.root
          })
        ).equals(true)
      },
      60000,
      350
    )
    return found!
  }
  const rotate = async (o: Orientation): Promise<Layout> => {
    await m.setOrientation({ orientation: o })
    return await wait(
      l =>
        l.root != null &&
        l.root.width > l.root.height === (o !== 'PORTRAIT') &&
        l.documentId === first.documentId &&
        l.face != null &&
        (process.env.TS_SCORING_PROJECTION !== '1' || l.landmarks != null)
    )
  }
  const stem = (o: Orientation): string =>
    (ipad ? 'side-' : 'matrix-') +
    ctx.device('phone').replace(/[^\w-]/g, '_') +
    '-' +
    ctx.surface +
    '-' +
    o.toLowerCase()
  const capture = async (name: string): Promise<void> => {
    writeFileSync(ctx.artifact(name + '.png'), await m.screenshot())
  }
  try {
    const ownPitch = async (): Promise<void> => {
      await control.call('PUT', network, { mode: 'watch' })
      const before = await counts()
      await tap('Ball')
      await wait(l => l.undo === 'Undo Ball' && l.notice == null)
      await eventually(async () => {
        expect(await counts()).deep.equals([...before, 'B'])
      })
    }
    if (!ipad) await ownPitch()
    for (const [index, o] of orientations.entries()) {
      await rotate(o)
      const beforePeer = await counts()
      await peer.pitch()
      await eventually(async () => {
        expect(await counts()).deep.equals([...beforePeer, 'B'])
      })
      const withPeer = await wait(
        l =>
          (l.logText ?? '').includes('Score P') ||
          (l.log == null &&
            l.side == null &&
            l.logBand != null &&
            l.deck != null &&
            l.logBand.height / (l.deck.height / 120) < 64)
      )
      verify(withPeer, ctx.surface === 'android-app')
      await capture(stem(o))
      if (ipad && index === 0) {
        // The confirmed remote row existed before this client posts its own
        // pitch. Rotations also let its on-field play animation finish.
        await ownPitch()
        const other = o === 'PORTRAIT' ? 'LANDSCAPE_LEFT' : 'PORTRAIT'
        await rotate(other)
        const saved = await wait(l => (l.logText ?? '').includes('Score P'))
        if (withPeer.log != null) expect(saved.logText).equals(withPeer.logText)
        // Landscape always has room for the control. A web portrait may
        // temporarily fit zero rows, but must preserve the collapsed state.
        await tap('Collapse scoring updates')
        await rotate(o)
        if (withPeer.log != null) await wait(l => l.collapsed === true)
        await rotate(other)
        await wait(l => l.collapsed === true)
        await tap('Expand scoring updates')
        await wait(l => l.logText === saved.logText)
        await tap('Dismiss scoring updates')
        await rotate(o)
        await rotate(other)
        await wait(l => l.log == null)
        await rotate(o)
      } else if (!ipad && withPeer.log == null && o === 'LANDSCAPE_LEFT') {
        await rotate('PORTRAIT')
        await wait(l => (l.logText ?? '').includes('Score P'))
        await rotate(o)
      }
      const stable = await read()
      const before = await counts()
      // Open the menu before cutting the network. WDA can resolve a control
      // while UIKit is still rotating the scene, so verify the menu opened.
      await tap('Open scoring menu')
      try {
        await m.assertVisible({ text: 'Set Team Rosters', timeout: 4500 })
      } catch {
        if (stable.menu == null) throw new Error('Scoring menu is missing')
        if (ctx.surface === 'ios-app')
          await m.tapOn({
            point:
              Math.round(stable.menu.left + stable.menu.width / 2) +
              ',' +
              Math.round(stable.menu.bottom - 9)
          })
        else await tap('Open scoring menu')
        await m.assertVisible({ text: 'Set Team Rosters', timeout: 12000 })
      }
      await control.call('PUT', network, { mode: 'offline' })
      // Opening the roster reads the current setup from this scoring client's API.
      await tap('Set Team Rosters')
      await eventually(async () => {
        expect(
          ((await control.call('GET', network)) as { failedReads: number })
            .failedReads
        ).greaterThan(0)
      }, 30000)
      await tap('Cancel')
      const disconnected = await wait(
        l => /Offline/i.test(l.noticeText ?? '') && noticeHasArrived(l)
      )
      verify(disconnected, ctx.surface === 'android-app')
      await tap('Called Strike')
      const offline = await wait(
        l =>
          l.undo === 'Undo Called Strike' && /Offline/i.test(l.noticeText ?? '')
      )
      verify(offline, ctx.surface === 'android-app')
      for (const key of [
        'root',
        'holder',
        'deck',
        'face',
        'strip',
        'side',
        'boxScore',
        'logBand'
      ] as const)
        expect(offline[key], key).deep.equals(stable[key])
      expect(await counts()).deep.equals(before)
      await eventually(async () => {
        expect(
          ((await control.call('GET', network)) as { failedWrites: number })
            .failedWrites
        ).greaterThan(0)
      }, 30000)
      const evidence = (await control.call('GET', network)) as {
        failedWrites: number
        failedReads: number
        closedSockets: number
      }
      expect(evidence.failedWrites).greaterThan(0)
      expect(evidence.closedSockets).greaterThan(0)
      await capture(stem(o) + '-offline')
      await control.call('PUT', eventGate, { mode: 'hold' })
      try {
        await control.call('PUT', network, { mode: 'online' })
        await eventually(async () => {
          expect(
            ((await control.call('GET', eventGate)) as { arrivals: number })
              .arrivals
          ).greaterThan(0)
        }, 60000)
        const saving = await wait(
          l => (l.noticeText ?? '').includes('Saving…') && noticeHasArrived(l)
        )
        verify(saving, ctx.surface === 'android-app')
        expect(await counts()).deep.equals(before)
        await capture(stem(o) + '-saving')
      } finally {
        await control.call('DELETE', eventGate)
      }
      await eventually(async () => {
        expect(await counts()).deep.equals([...before, 'C'])
      }, 45000)
      await wait(l => l.notice == null)
      writeFileSync(
        ctx.artifact(stem(o) + '-measurements.json'),
        JSON.stringify({ layout: withPeer, offline, evidence }, null, 2)
      )
    }
  } finally {
    try {
      await control.call('DELETE', network)
    } finally {
      try {
        await m.setOrientation({ orientation: 'PORTRAIT' })
      } finally {
        await peer.close()
      }
    }
  }
}

/** Each matrix device is supplied by a live mesh lease or the named simulator exception. */
export async function mobileScoring(
  ctx: E2eContext,
  ipad: boolean
): Promise<void> {
  const orientations: Orientation[] =
    ipad || process.env.TS_SCORING_ROTATE === '1'
      ? ['PORTRAIT', 'LANDSCAPE_LEFT']
      : ['PORTRAIT']
  if (ipad) await exercise(ctx, orientations, true)
  else for (const o of orientations) await exercise(ctx, [o], false)
}
