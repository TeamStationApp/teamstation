// The Auto-Scheduler fixes' iOS scenarios, I1 to I4, against the app on a
// physical iPad or iPhone. Each part of a scenario starts from a fresh
// fixture seeded to its own start state, so none depends on another's
// leftovers.
//
// The app talks to TS_API_BASE_URL=http://<host>:<port>/api/v1 (see
// src/MOBILE.md): a Release build with it inlined for I1, I3 and I4, and for
// I2 a Debug build served by Metro started with it and `--reset-cache`, since
// only a development build logs the `[directions] <url>` line I2 reads from
// the device's log (idevicesyslog, from Homebrew's libimobiledevice). With
// TS_AUTO_SCHEDULER_IOS_RELEASE=1, I2 runs on a Release build: it takes its
// Info tab shot and opens Apple Maps on the field, without the URL check.
// This script serves every part's fresh fixture on that one LAN address,
// starting it again for each part, and signs in as 101 each time.
//
// The app is never let see the device's location: the Field Manager would
// show distances from it, and Apple Maps shows it. Apple Maps' own screen
// goes to coverage/autoSchedulerFixesIOS, outside the artifacts directory;
// directions-ios-apple-maps.png there is a copy cropped by hand.
//
//   TS_MAESTRO_D_CLIENT=$HOME/git/maestro-d/npm/maestro-d \
//   MAESTRO_D_BIN=$HOME/.maestro-d/bin/maestro-d \
//   MAESTRO_D=autoSchedulerFixesIOS \
//   MAESTRO_D_TEAM_ID=<the team that signs WebDriverAgent> \
//   TS_AUTO_SCHEDULER_IOS_DEVICE=<the device's hardware UDID> \
//   TS_AUTO_SCHEDULER_IOS_HOST=<this Mac's LAN address> \
//   TS_AUTO_SCHEDULER_IOS_PORT=<the port the app was built for> \
//   TS_AUTO_SCHEDULER_ARTIFACTS=<artifacts directory> \
//     node -r sucrase/register src/app/autoSchedulerFixesIOS.e2e.ts --only I1
//
// `--only` takes a scenario (I1 to I4) or one part of one (I3a to I3c), or
// several, comma-separated. With no `--only`, every scenario runs in order.
// Each scenario's PASS lines go to support/<scenario>.log in the artifacts
// directory, after its `$` line. TS_AUTO_SCHEDULER_IOS_OUT, when set, takes
// those logs and the screenshots named without a directory instead.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, request as forward, type Server } from 'node:http'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { maestro, type MaestroHandle } from '../../e2e/rigs/refinementsMaestro'
import type { EventLocation } from '../common/eventInfo'
import type { VenueDetail } from '../common/venues'
import { googlePlaces } from '../server/location/googlePlaces'
import {
  api,
  type AutoSchedulerFixture,
  autoSchedulerFixture,
  FIELD_ONE_PIN,
  G1,
  seedThrough
} from '../test/autoSchedulerFixture'
import {
  EXAMPLE_PARK,
  googlePlacesStub,
  MORE_PARKS
} from '../test/googlePlacesStub'

const APP_ID = 'app.teamstation.app'
const ADMIN = 101
const ADMIN_EMAIL = 'alex@example.com'

type Start = 'E2' | 'E3' | 'E5' | 'E7'

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

interface Run {
  fx: AutoSchedulerFixture
  m: MaestroHandle
  /** What the start state made: the venue, its first field. */
  state: { venueId?: string; fieldId?: string }
  artifacts: string
  support: string
  /** The device's hardware UDID, for its log. */
  device: string
  /** The command line this run was started with, for a log's first line. */
  command: string
  visit: (path: string) => Promise<void>
  /** A screenshot into the artifacts directory, or to an absolute path. */
  capture: (name: string) => Promise<void>
  pass: (description: string) => Promise<void>
}

/** One part of a scenario, on its own fresh fixture. */
interface Part {
  id: string
  start: Start
  run: (run: Run) => Promise<void>
}

/** One line per step, to find a stall. */
function trace(step: string): void {
  console.log(`  · ${new Date().toISOString().slice(11, 19)} ${step}`)
}

function required(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`Supply ${key}`)
  return value
}

/**
 * The fixture's LAN address: a server on the fixed host and port the app was
 * built for, forwarding to one part's fixture. It starts again for each part.
 */
function lanServer(
  host: string,
  port: number
): {
  start: (upstream: string) => Promise<void>
  stop: () => Promise<void>
} {
  let server: Server | undefined
  return {
    start: async upstream => {
      const target = new URL(upstream)
      const started = createServer((req, res) => {
        const url = new URL(req.url ?? '/', target)
        if (url.origin !== target.origin) {
          res.writeHead(400)
          res.end()
          return
        }
        const outgoing = forward(
          url,
          {
            method: req.method,
            headers: { ...req.headers, host: target.host }
          },
          reply => {
            res.writeHead(reply.statusCode ?? 500, reply.headers)
            reply.pipe(res)
          }
        )
        outgoing.on('error', () => {
          res.writeHead(502)
          res.end('Fixture unavailable')
        })
        req.pipe(outgoing)
      })
      await new Promise<void>((resolve, reject) => {
        started.once('error', reject)
        started.listen(port, host, resolve)
      })
      server = started
    },
    stop: async () => {
      const closing = server
      server = undefined
      if (closing == null) return
      closing.closeAllConnections()
      await new Promise<void>(resolve =>
        closing.close(() => {
          resolve()
        })
      )
    }
  }
}

async function nodes(m: MaestroHandle): Promise<Node[]> {
  return flatten((await m.hierarchy()) as Node)
}

/**
 * With Location Services off on the device, a location request brings iOS's
 * "Turn On Location Services" alert, whose automatic dismissal opens
 * Settings. Refuse it, or the app's own location prompt, by hand.
 */
async function refuseLocation(m: MaestroHandle, ms = 0): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      const answer = await (
        m as unknown as {
          dismissAlert: () => Promise<unknown>
        }
      ).dismissAlert()
      trace(`dismissAlert: ${JSON.stringify(answer).slice(0, 300)}`)
    } catch (error) {
      trace(`dismissAlert threw: ${String(error).slice(0, 200)}`)
    }
    const texts = (await nodes(m)).map(n => n.text ?? '')
    if (
      texts.some(
        t => t === 'LOCATION_SERVICES_MASTER' || t === 'Location Services'
      )
    )
      throw new Error('The location alert opened Settings')
    if (Date.now() >= deadline) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** Waits for text (a regular expression, as maestro matches it). */
async function show(m: MaestroHandle, text: string): Promise<void> {
  trace(`show ${text}`)
  await m.assertVisible({ text, timeout: 20000 })
}

/** Taps the element with this text or accessibility label. */
async function tap(m: MaestroHandle, text: string): Promise<void> {
  trace(`tap ${text}`)
  await m.tapOn({ text, timeout: 15000 })
  await m.waitForAnimationToEnd()
}

/** Scrolls until the text is on screen, then lets the scroll settle. */
async function scrollTo(m: MaestroHandle, text: string): Promise<void> {
  trace(`scroll to ${text}`)
  await m.scrollUntilVisible({
    element: { text },
    centerElement: true,
    timeout: 20000
  })
  await m.waitForAnimationToEnd()
}

/**
 * Scrolls until the element with exactly this text sits at `at` (a fraction
 * of the screen's height from the top), so an after shot is framed like its
 * before shot. The drags are slow, in the page's left gutter, clear of text
 * and maps, and at most a third of the screen each.
 */
async function placeAt(
  m: MaestroHandle,
  text: string,
  at: number
): Promise<void> {
  await scrollTo(m, text)
  for (let attempt = 0; attempt < 14; attempt++) {
    const tree = (await m.hierarchy()) as Node
    const node = flatten(tree).find(n => n.text === text && n.bounds != null)
    if (node?.bounds == null || tree.bounds == null)
      throw new Error(`No ${text} to place`)
    const y = node.bounds.y / tree.bounds.height
    trace(`${text} at ${y.toFixed(2)}, wanted ${at}`)
    // An iPhone flings a drag by its speed, not its
    // length, so settle for the heading within a tenth of where it was.
    if (Math.abs(y - at) < 0.1) return
    // An iPhone's scroll overshoots a drag; drag less.
    const by = Math.max(-0.2, Math.min(0.2, (at - y) * 0.6))
    const from = by < 0 ? 0.8 : 0.3
    await m.swipe({
      start: `3%,${Math.round(from * 100)}%`,
      end: `3%,${Math.round((from + by) * 100)}%`,
      duration: 2000
    })
    await m.waitForAnimationToEnd()
  }
  throw new Error(`Could not place ${text} at ${at}`)
}

/** Waits until a node with this accessibility identifier is on screen. */
async function byId(m: MaestroHandle, id: string): Promise<Node> {
  const deadline = Date.now() + 20000
  for (;;) {
    const found = (await nodes(m)).find(
      n => n.id === id && n.bounds != null && n.bounds.width > 0
    )
    if (found != null) return found
    if (Date.now() > deadline) throw new Error(`No element ${id}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** iOS asks once whether the app may reach the local network. */
async function allowLocalNetwork(m: MaestroHandle): Promise<void> {
  const all = await nodes(m)
  if (
    all.some(n => /local network/i.test(n.text ?? '')) &&
    all.some(n => n.text === 'Allow')
  )
    await tap(m, 'Allow')
}

/** Launches the app afresh and signs in as 101 on this part's fixture. */
async function signIn(
  m: MaestroHandle,
  fx: AutoSchedulerFixture
): Promise<void> {
  // Location refused: with no permissions named, WebDriverAgent accepts
  // every alert, the location one too, and the Field Manager would show
  // distances from where the device really is. On a physical device this
  // sets only WebDriverAgent's alert handling, to dismiss every system
  // alert, so the app must already be allowed on the local network (answer
  // that once by hand after installing it).
  await m.launchApp({
    appId: APP_ID,
    stopApp: true,
    clearState: false,
    permissions: { all: 'unset' }
  })
  const deadline = Date.now() + 60000
  for (;;) {
    await allowLocalNetwork(m)
    if ((await nodes(m)).some(n => n.text === 'E-mail address')) break
    if (Date.now() > deadline) throw new Error('No sign-in screen')
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  trace('sign in')
  await tap(m, 'E-mail address')
  await m.inputText({ text: ADMIN_EMAIL })
  await tap(m, 'Send me a sign-in code')
  await show(m, '.*six-digit code.*')
  await tap(m, 'Sign-in code')
  await m.inputText({ text: fx.f.h.mail.get(ADMIN_EMAIL)! })
  // An iPhone's header reads "Sign in" too, and a tap by that text lands on
  // the header: Return in the code field signs in, as its Go key does.
  trace('press Return in the code field')
  await m.pressKey({ key: 'Enter' })
  await m.waitForAnimationToEnd()
  await show(m, 'Your Home')
}

/** Field 1's point: its own pin, or the venue's when it has none. */
async function fieldPoint(
  run: Run
): Promise<{ latitude: number; longitude: number }> {
  const venue = await api<VenueDetail>(
    run.fx,
    ADMIN,
    'GET',
    `/venues/${run.state.venueId!}`
  )
  const field = venue.fields.find(item => item.id === run.state.fieldId)!
  return (
    field.pin ?? {
      latitude: venue.map.latitude,
      longitude: venue.map.longitude
    }
  )
}

/**
 * The map's pin. MapKit names an annotation by its title, so on iOS the
 * Marker is "Field location" in the accessibility tree; its testID and
 * accessibilityLabel stay on react-native-maps' own view and never reach
 * MapKit's annotation view.
 */
async function mapPin(m: MaestroHandle, map: Node): Promise<Node> {
  const deadline = Date.now() + 20000
  for (;;) {
    const inside = (await nodes(m)).filter(
      n =>
        n.text === 'Field location' &&
        n.bounds != null &&
        n.bounds.width > 0 &&
        n.bounds.x >= map.bounds!.x &&
        n.bounds.y >= map.bounds!.y &&
        n.bounds.x + n.bounds.width <= map.bounds!.x + map.bounds!.width &&
        n.bounds.y + n.bounds.height <= map.bounds!.y + map.bounds!.height
    )
    if (inside.length > 0) return inside[0]
    if (Date.now() > deadline) throw new Error('No pin on the map')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/**
 * Field 1's map is Apple Maps: a MapKit map with its pin, and nothing of
 * OpenStreetMap's or Leaflet's on screen. Field sizes, the heading under
 * the map, scrolled into view brings the whole map on screen, as in the
 * before shot.
 */
async function appleMap(m: MaestroHandle): Promise<{ map: Node; pin: Node }> {
  await show(m, 'Field 1')
  await scrollTo(m, 'FIELD SIZES')
  await show(m, 'WHERE IT IS')
  const map = await byId(m, 'pin-map')
  const pin = await mapPin(m, map)
  // Give MapKit's satellite tiles time to arrive.
  await new Promise(resolve => setTimeout(resolve, 5000))
  const all = await nodes(m)
  const texts = all.map(n => n.text ?? '')
  expect(
    texts.filter(text => /openstreetmap|leaflet/i.test(text)),
    'OpenStreetMap or Leaflet on screen'
  ).deep.equals([])
  // MapKit draws its own Legal link in the map's corner; the old map was a
  // WebView, with Leaflet's attribution inside it.
  expect(
    all.some(n => n.type === 'Link' && n.text === 'Legal'),
    'MapKit’s Legal link'
  ).equals(true)
  expect(all.some(n => n.type === 'WebView')).equals(false)
  return { map, pin }
}

/**
 * The app's header, as a fraction of the iPad's screen height, and where a
 * Field Manager row's name and address sit below the row's top, in points.
 */
const HEADER = 0.095
const ROW_NAME = 16
const ROW_ADDRESS = 58

/**
 * The Field Manager rows whose name and address are on screen, below the
 * header, in order.
 */
async function named(m: MaestroHandle): Promise<string[]> {
  const tree = (await m.hierarchy()) as Node
  const { height } = tree.bounds!
  return flatten(tree)
    .filter(
      n =>
        n.bounds != null &&
        n.bounds.height > 0 &&
        n.bounds.y + ROW_NAME >= HEADER * height - 1 &&
        n.bounds.y + ROW_ADDRESS <= height
    )
    .map(n => /^Open (.+)$/.exec(n.text ?? '')?.[1])
    .filter((name): name is string => name != null)
}

/**
 * I1, search: the Field Manager lists at least ten places for "Example
 * Park", the registry's own first.
 */
async function i1Search(run: Run): Promise<void> {
  const { fx, m } = run
  await run.visit(`/groups/league/${fx.f.leagueA}/scheduler/fields`)
  await show(m, 'Field Manager')
  // The Field Manager asks where the device is, and is refused.
  await new Promise(resolve => setTimeout(resolve, 2000))
  await refuseLocation(m, 12000)
  await tap(m, 'Search venues')
  await m.inputText({ text: 'Example Park' })
  await show(m, `Open ${EXAMPLE_PARK.name}`)
  await show(m, `Open ${MORE_PARKS[0]}`)
  await m.hideKeyboard()
  await new Promise(resolve => setTimeout(resolve, 1000))
  // With location refused, no row shows a distance from the device.
  expect(
    (await nodes(m))
      .map(n => n.text ?? '')
      .filter(text => /\d km\b/.test(text)),
    'a distance from the device'
  ).deep.equals([])
  const all = [EXAMPLE_PARK.name, ...MORE_PARKS]
  const first = await named(m)
  await run.capture('field-search-ios-after.png')
  // The list may run past the screen: gather every row while scrolling.
  const rows: string[] = []
  const gather = async (): Promise<void> => {
    for (const n of await nodes(m)) {
      const name = /^Open (.+)$/.exec(n.text ?? '')?.[1]
      if (
        name != null &&
        n.bounds != null &&
        n.bounds.height > 0 &&
        all.includes(name) &&
        !rows.includes(name)
      )
        rows.push(name)
    }
  }
  await gather()
  const last = MORE_PARKS[MORE_PARKS.length - 1]
  if (!rows.includes(last)) {
    await scrollTo(m, `Open ${last}`)
    await gather()
  }
  expect(rows).deep.equals([EXAMPLE_PARK.name, ...MORE_PARKS])
  expect(rows.length).greaterThanOrEqual(10)
  // The rest of the list, as support: the first row the after shot leaves
  // out sits just under the header, and every row from it to the last shows
  // its name and address. The screen holds about six and a half rows, so the
  // shot ends on the last row's address rather than below it. The drags are
  // slow, in the page's left gutter, so they scroll by as much as they move.
  // (The hierarchy holds every row, those off screen too.)
  const next = all.find(name => !first.includes(name))!
  /** The row's top and the screen, once the scroll has stopped. */
  const settled = async (): Promise<{
    y: number | undefined
    width: number
    height: number
  }> => {
    let before: number | undefined = Number.NaN
    for (let read = 0; ; read++) {
      const tree = (await m.hierarchy()) as Node
      const y = flatten(tree).find(
        n => n.text === `Open ${next}` && n.bounds != null
      )?.bounds?.y
      const { width, height } = tree.bounds!
      if (y === before || read === 6) return { y, width, height }
      before = y
      await new Promise(resolve => setTimeout(resolve, 700))
    }
  }
  for (let attempt = 0; ; attempt++) {
    const { y, width, height } = await settled()
    const want = HEADER * height - ROW_NAME + 6
    const off = y == null ? height / 4 : want - y
    trace(`${next} at ${String(y)}, wanted ${want.toFixed(0)}`)
    if (Math.abs(off) <= 5) break
    if (attempt === 14) throw new Error(`Could not place ${next}`)
    // Only a drag up scrolls by what it moves: 10 points less, once it is
    // 130 points or longer. A drag down, or a shorter one, scrolls on by
    // 150 points or more. So the row goes down past its place first, and a
    // drag up, at most a third of the screen, brings it back.
    const move =
      off <= -130
        ? Math.max(-height / 3, off - 10)
        : Math.min(height / 3, Math.max(100, off))
    trace(`drag ${Math.round(move)}`)
    const x = Math.round(width * 0.03)
    const from = move > 0 ? height * 0.3 : height * 0.8
    await m.command('dragAndDrop', {
      from: { point: `${x},${Math.round(from)}` },
      to: { point: `${x},${Math.round(from + move)}` },
      holdDuration: 300,
      duration: 1500
    })
  }
  const rest = await named(m)
  expect(
    all.filter(name => !first.includes(name) && !rest.includes(name)),
    'a row in neither shot'
  ).deep.equals([])
  expect(rest).includes(last)
  expect(
    (await nodes(m))
      .map(n => n.text ?? '')
      .filter(text => /\d km\b/.test(text)),
    'a distance from the device at the end of the list'
  ).deep.equals([])
  await run.capture(join(run.support, 'I1-field-search-end.png'))
  await run.pass(
    `searching "Example Park" in the Field Manager lists ${rows.length} venues on iOS: ${EXAMPLE_PARK.name} first, then ${MORE_PARKS.length} places from Google, ${MORE_PARKS[0]} to ${last}`
  )
}

/**
 * I1, map: Field 1's map is Apple Maps, hybrid, with no OpenStreetMap; its
 * pin drags, saves, and is where Field 1 reopens.
 */
async function i1Map(run: Run): Promise<void> {
  const { m } = run
  const path = `/venues/${run.state.venueId!}/fields/${run.state.fieldId!}`
  const start = await fieldPoint(run)
  await run.visit(path)
  const { map } = await appleMap(m)
  await run.capture('field-map-ios-after.png')
  // Drag the pin up and to the right, as a finger does: tap it so MapKit
  // selects it, then press and hold it until MapKit lifts it, move it and
  // let go. (WebDriverAgent's press-and-drag moves it too fast for MapKit to
  // lift a pin that is not yet selected; a plain swipe pans nothing.)
  const center = (node: Node): { x: number; y: number } => ({
    x: Math.round(node.bounds!.x + node.bounds!.width / 2),
    y: Math.round(node.bounds!.y + node.bounds!.height / 2)
  })
  const first = center(await mapPin(m, map))
  await m.tapOn({ point: `${first.x},${first.y}` })
  await new Promise(resolve => setTimeout(resolve, 1500))
  const from = center(await mapPin(m, map))
  const to = {
    x: Math.round(from.x + map.bounds!.width / 6),
    y: Math.round(from.y - map.bounds!.height / 6)
  }
  trace(`drag pin ${from.x},${from.y} → ${to.x},${to.y}`)
  await m.command('dragAndDrop', {
    from: { point: `${from.x},${from.y}` },
    to: { point: `${to.x},${to.y}` },
    holdDuration: 1500
  })
  await show(m, 'Pin saved.')
  const dragged = await fieldPoint(run)
  trace(`pin ${JSON.stringify(start)} → ${JSON.stringify(dragged)}`)
  // Up and to the right on the map is north and east.
  expect(dragged.latitude).greaterThan(start.latitude)
  expect(dragged.longitude).greaterThan(start.longitude)
  // Leave Field 1 for its venue, then come back: the pin is the saved one.
  await run.visit(`/venues/${run.state.venueId!}`)
  await show(m, 'Example Park')
  await run.visit(path)
  await appleMap(m)
  expect(await fieldPoint(run)).deep.equals(dragged)
  await run.capture(join(run.support, 'I1-field-map-reopened.png'))
  await run.pass(
    `Field 1's map is Apple Maps (MapKit with its Legal link and its "Field location" pin, hybrid, no WebView and nothing of OpenStreetMap or Leaflet); dragging the pin north-east from ${start.latitude.toFixed(5)}, ${start.longitude.toFixed(5)} showed "Pin saved." and stored ${dragged.latitude.toFixed(5)}, ${dragged.longitude.toFixed(5)}; leaving Field 1 and reopening it keeps that point, and its map opens centred on the pin there`
  )
}

const GAME_MINS = 'Demo Regular Game length in minutes'

/**
 * I3a: a tap on seasonA's Game MINS opens it in place with its number
 * selected and a keyboard with a return key; typing replaces the number, and
 * Return saves it.
 */
async function i3a(run: Run): Promise<void> {
  const { fx, m } = run
  await run.visit(`/groups/league/${fx.f.leagueA}/scheduler`)
  await show(m, 'SCHEDULE SETTINGS')
  await revealCell(m, `grid-cell-${fx.f.seasonA}-gameMinutes`)
  // A tap as the scroll settles can be lost: tap until the cell opens.
  const editor = `grid-cell-input-${fx.f.seasonA}-gameMinutes`
  for (let attempt = 0; ; attempt++) {
    await tap(m, `${GAME_MINS}: 90`)
    try {
      await m.assertVisible({ id: editor, timeout: 5000 })
      break
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
  const keyboard = (await nodes(m)).find(n => n.type === 'Keyboard')
  expect(keyboard, 'the keyboard').not.equals(undefined)
  // returnKeyType "done": the keyboard's return key reads Done.
  const keys = flatten(keyboard!).map(n => n.text ?? '')
  const returnKey = keys.find(text => /^(done|return)$/i.test(text))
  expect(returnKey, `a return key among ${keys.join(', ')}`).not.equals(
    undefined
  )
  await run.capture('season-grid-ios-after.png')
  // The whole number is selected, so typing replaces it rather than adding
  // to it: 90 becomes 100, not 90100.
  await m.inputText({ text: '100' })
  await show(m, '100')
  await m.pressKey({ key: 'Enter' })
  await show(m, `${GAME_MINS}: 100`)
  const saved = await api<{ settings: { gameMinutes: number } }>(
    fx,
    ADMIN,
    'GET',
    `/seasons/${fx.f.seasonA}/schedule-settings`
  )
  expect(saved.settings.gameMinutes).equals(100)
  expect(
    (await nodes(m)).some(n => n.text === 'Game length, in minutes')
  ).equals(false)
  await run.pass(
    `tapping seasonA's Game MINS (90) opened it in place with its number selected and a keyboard whose return key reads "${returnKey}"; typing 100 replaced the number, Return saved it, and the cell reads 100 (stored gameMinutes 100), with no dialog`
  )
}

/** Whether a node lies wholly inside another's bounds, give or take a point. */
function inside(node: Node | undefined, frame: Node | undefined): boolean {
  const a = node?.bounds
  const b = frame?.bounds
  if (a == null || b == null || a.width <= 0) return false
  return (
    a.x >= b.x - 1 &&
    a.y >= b.y - 1 &&
    a.x + a.width <= b.x + b.width + 1 &&
    a.y + a.height <= b.y + b.height + 1
  )
}

/**
 * Drags along one axis, at `line` (a fraction across the other axis), until
 * `error` reads 0. A positive error is how far, as a fraction of the screen,
 * the content must move toward the axis's start: left or up. WebDriverAgent
 * on the iPhone turns a slow drag into a press and a quick drag into a
 * fling, so each drag is quick, and halves whenever it overshoots.
 */
async function steer(
  m: MaestroHandle,
  axis: 'x' | 'y',
  line: number,
  error: () => Promise<number>,
  attempts = 10
): Promise<boolean> {
  let step = 0.3
  let last = 0
  for (let attempt = 0; attempt < attempts; attempt++) {
    const e = await error()
    if (e === 0) return true
    const sign = Math.sign(e)
    if (last !== 0 && sign !== last) step = Math.max(0.04, step / 2)
    last = sign
    const size = Math.min(step, Math.max(0.04, Math.abs(e)))
    const along = (at: number): string =>
      axis === 'x'
        ? `${Math.round(at * 100)}%,${Math.round(line * 100)}%`
        : `${Math.round(line * 100)}%,${Math.round(at * 100)}%`
    await m.swipe({
      start: along(0.5 + (sign * size) / 2),
      end: along(0.5 - (sign * size) / 2),
      duration: 1000
    })
    await m.waitForAnimationToEnd()
  }
  return (await error()) === 0
}

/**
 * How far, as a fraction of the screen's width, the grid must slide left
 * (positive) or right (negative) to show `from` to `to` wholly; 0 when it
 * does. Also where to drag: the grid's header row, clear of the cells.
 */
function gridError(
  all: Node[],
  from: Node | undefined,
  to: Node | undefined
): { error: number; line: number } {
  const grid = all.find(n => n.id === 'season-schedule-grid')?.bounds
  const width = all[0].bounds!.width
  const line = grid == null ? 0.5 : (grid.y + 18) / all[0].bounds!.height
  if (grid == null || from?.bounds == null || to?.bounds == null)
    return { error: 0.3, line }
  const right = to.bounds.x + to.bounds.width - (grid.x + grid.width)
  const left = from.bounds.x - grid.x
  if (right > 1) return { error: (right + 12) / width, line }
  if (left < -1) return { error: (left - 12) / width, line }
  return { error: 0, line }
}

/**
 * Scrolls the page to the season grid, then the grid sideways until the cell
 * with this id is wholly inside it: on an iPhone, Game MINS starts at the
 * grid's right edge, cut off by the card.
 */
async function revealCell(m: MaestroHandle, id: string): Promise<void> {
  trace(`reveal ${id}`)
  await m.scrollUntilVisible({
    element: { id: 'season-schedule-grid' },
    centerElement: true,
    timeout: 20000
  })
  await m.waitForAnimationToEnd()
  const start = gridError(await nodes(m), undefined, undefined)
  const shown = await steer(m, 'x', start.line, async () => {
    const all = await nodes(m)
    const cell = all.find(n => n.id === id)
    const { error } = gridError(all, cell, cell)
    trace(`${id} at x ${cell?.bounds?.x}: slide ${error.toFixed(2)}`)
    return error
  })
  if (!shown) throw new Error(`Could not bring ${id} into the grid`)
}

/**
 * I3c: an open cell low on the screen rises above the keyboard, and opening
 * a cell keeps the grid where it was sideways.
 */
async function i3c(run: Run): Promise<void> {
  const { fx, m } = run
  const season = fx.f.seasonA
  const cellId = (column: string): string => `grid-cell-${season}-${column}`
  const inputId = (column: string): string =>
    `grid-cell-input-${season}-${column}`
  await run.visit(`/groups/league/${fx.f.leagueA}/scheduler`)
  await show(m, 'SCHEDULE SETTINGS')
  await revealCell(m, cellId('gameMinutes'))
  /** Drags the page until Game MINS sits within `slack` of `at` down it. */
  const placeRow = async (
    at: number,
    slack: number,
    attempts?: number
  ): Promise<boolean> =>
    await steer(
      m,
      'y',
      0.03,
      async () => {
        const all = await nodes(m)
        const cell = all.find(n => n.id === cellId('gameMinutes'))
        const y = cell!.bounds!.y / all[0].bounds!.height
        trace(`Game MINS at ${y.toFixed(2)}, wanted ${at}`)
        return Math.abs(y - at) < slack ? 0 : y - at
      },
      attempts
    )
  // The row low on the screen, where the keyboard will come up over it, as
  // low as the page lets it go.
  await placeRow(0.8, 0.06, 4)
  const low = await byId(m, cellId('gameMinutes'))
  await m.tapOn({ id: cellId('gameMinutes'), retryTapIfNoChange: false })
  await new Promise(resolve => setTimeout(resolve, 2500))
  let all = await nodes(m)
  const keyboard = all.find(n => n.type === 'Keyboard')
  const open = all.find(n => n.id === inputId('gameMinutes'))
  expect(keyboard, 'the keyboard').not.equals(undefined)
  expect(open?.bounds, 'the open Game MINS cell').not.equals(undefined)
  trace(
    `cell was at y ${low.bounds!.y}; open at ${JSON.stringify(open!.bounds)}, keyboard at ${JSON.stringify(keyboard!.bounds)}`
  )
  expect(
    low.bounds!.y + low.bounds!.height,
    'the closed cell’s bottom, under where the keyboard comes up'
  ).greaterThan(keyboard!.bounds!.y)
  expect(
    open!.bounds!.y + open!.bounds!.height,
    'the open cell’s bottom, above the keyboard’s top'
  ).lessThanOrEqual(keyboard!.bounds!.y + 1)
  await run.capture('i3c-cell-above-keyboard.png')
  const lifted = `Game MINS at y ${low.bounds!.y}–${low.bounds!.y + low.bounds!.height} of ${all[0].bounds!.height}, under where the keyboard comes up, opened at y ${open!.bounds!.y}–${open!.bounds!.y + open!.bounds!.height}, wholly above the keyboard's top at ${keyboard!.bounds!.y} (i3c-cell-above-keyboard.png)`
  // Return closes it unchanged.
  await m.pressKey({ key: 'Enter' })
  await show(m, `${GAME_MINS}: 90`)
  // Bring the row up clear of the keyboard, then slide the grid left until
  // # Regular is wholly in view beside Game MINS.
  // Anywhere in the screen's upper half will do: each drag flings the page
  // about a third of the screen.
  if (!(await placeRow(0.35, 0.15)))
    throw new Error('Could not place Game MINS clear of the keyboard')
  const grid = (): Node | undefined =>
    all.find(
      n =>
        n.type === 'ScrollView' &&
        inside(
          n,
          all.find(g => g.id === 'season-schedule-grid')
        )
    )
  const pair = async (): Promise<{ error: number; line: number }> => {
    all = await nodes(m)
    return gridError(
      all,
      all.find(n => n.id === cellId('gameMinutes')),
      all.find(n => n.id === cellId('regularGames'))
    )
  }
  const both = await steer(m, 'x', (await pair()).line, async () => {
    const { error } = await pair()
    trace(`Game MINS to # Regular: slide ${error.toFixed(2)}`)
    return error
  })
  if (!both) throw new Error('Could not show Game MINS and # Regular')
  const before = all.find(n => n.id === cellId('gameMinutes'))!.bounds!
  await run.capture('i3c-grid-scrolled.png')
  await m.tapOn({ id: cellId('gameMinutes'), retryTapIfNoChange: false })
  await byId(m, inputId('gameMinutes'))
  await new Promise(resolve => setTimeout(resolve, 1500))
  all = await nodes(m)
  const gameOpen = all.find(n => n.id === inputId('gameMinutes'))
  trace(
    `Game MINS was at x ${before.x}; open at ${JSON.stringify(gameOpen?.bounds)}`
  )
  expect(
    Math.abs(gameOpen!.bounds!.x - before.x),
    'Game MINS’s sideways move as it opens'
  ).lessThan(12)
  expect(
    inside(
      all.find(n => n.id === cellId('regularGames')),
      grid()
    ),
    '# Regular still wholly in view'
  ).equals(true)
  await run.capture('i3c-game-mins-open.png')
  // One tap on # Regular saves Game MINS, unchanged, and opens # Regular.
  await m.tapOn({ id: cellId('regularGames'), retryTapIfNoChange: false })
  await byId(m, inputId('regularGames'))
  await new Promise(resolve => setTimeout(resolve, 1500))
  all = await nodes(m)
  const regularOpen = all.find(n => n.id === inputId('regularGames'))
  trace(
    `# Regular open at ${JSON.stringify(regularOpen?.bounds)} in ${JSON.stringify(grid()?.bounds)}`
  )
  expect(inside(regularOpen, grid()), '# Regular wholly in view, open').equals(
    true
  )
  await run.capture('i3c-regular-open.png')
  await m.pressKey({ key: 'Enter' })
  await show(m, 'Demo Regular Regular-season games: 4')
  await run.pass(
    `${lifted}; with the grid slid so Game MINS (x ${before.x}) and # Regular both showed (i3c-grid-scrolled.png), opening Game MINS left it at x ${gameOpen!.bounds!.x} with # Regular still wholly in view (i3c-game-mins-open.png), and one tap on # Regular opened it at x ${regularOpen!.bounds!.x}–${regularOpen!.bounds!.x + regularOpen!.bounds!.width}, inside the grid's ${grid()!.bounds!.x}–${grid()!.bounds!.x + grid()!.bounds!.width} (i3c-regular-open.png)`
  )
}

/**
 * I3b: the empty venue's "Add field" row, whose plus glyph comes from the
 * regenerated icon font.
 */
async function i3b(run: Run): Promise<void> {
  const { m } = run
  await run.visit(`/venues/${run.state.venueId!}`)
  // Framed as venue-empty-ios-before.png: FIELDS 30% down the screen.
  await placeAt(m, 'FIELDS', 0.3)
  await show(m, 'Add field')
  const all = await nodes(m)
  expect(
    all.some(n => (n.text ?? '').includes('No fields yet')),
    'the old "No fields yet" sentence'
  ).equals(false)
  const row = all.find(n => n.text === 'Add field' && n.bounds != null)
  expect(row, 'the Add field row').not.equals(undefined)
  await run.capture('venue-empty-ios-after.png')
  await run.pass(
    'Example Park with no fields shows the full-width "Add field" row in place of "No fields yet…", its icon tile drawing the plus from the regenerated font (venue-empty-ios-after.png)'
  )
}

/**
 * I4: the playoffs copy seasonA's game windows, and a second copy, over the
 * windows they now have, asks first and replaces them once confirmed. iOS
 * presents one modal at a time, so the question must come up in the sheet
 * the source was picked in rather than in a second one.
 */
async function i4(run: Run): Promise<void> {
  const { fx, m } = run
  const stored = async (): Promise<Array<{ from: string; until?: string }>> =>
    (
      await api<{
        settings: { windows: Array<{ from: string; until?: string }> }
      }>(fx, ADMIN, 'GET', `/seasons/${fx.f.playoffs}/schedule-settings`)
    ).settings.windows.map(({ from, until }) => ({ from, until }))
  expect(await stored()).deep.equals([])
  await run.visit(
    `/groups/league/${fx.f.leagueA}/scheduler/seasons/${fx.f.playoffs}`
  )
  await show(m, 'No game windows yet.')
  await scrollTo(m, 'Copy from another season')
  await tap(m, 'Copy from another season')
  await show(m, 'Copy game windows from')
  await tap(m, 'Demo Regular')
  await show(m, 'Game windows copied from Demo Regular.')
  // The seasons start together, and seasonA's June period starts after the
  // playoffs end, so only its first, open-ended period comes across.
  const copied = [{ from: '2027-03-01', until: undefined }]
  expect(await stored()).deep.equals(copied)
  await run.capture('copy-windows-first-ios.png')
  // Again, over the period the playoffs now have.
  await scrollTo(m, 'Copy from another season')
  await tap(m, 'Copy from another season')
  await show(m, 'Copy game windows from')
  await tap(m, 'Demo Regular')
  await show(m, 'Replace this season’s game windows\\?')
  // The row reads as one element by its label: its detail, "…’s windows
  // take the place of this season’s 1 period.", is in the shot.
  await show(m, 'Replace game windows')
  const asking = (await nodes(m)).map(n => n.text ?? '')
  expect(asking, 'the source list beside the question').not.includes(
    'Copy game windows from'
  )
  await run.capture('copy-windows-replace-ios.png')
  await tap(m, 'Replace game windows')
  const deadline = Date.now() + 15000
  while (
    (await nodes(m)).some(n => n.text === 'Replace this season’s game windows?')
  ) {
    if (Date.now() > deadline) throw new Error('The question stayed up')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  // The notice is under the title, above where the second copy scrolled to.
  trace('scroll up to the notice')
  await m.scrollUntilVisible({
    element: { text: 'Game windows copied from Demo Regular.' },
    direction: 'UP',
    maxScrolls: 10,
    timeout: 20000
  })
  await m.waitForAnimationToEnd()
  expect(await stored()).deep.equals(copied)
  await run.capture('copy-windows-replaced-ios.png')
  await run.pass(
    'the playoffs, with no windows, copied Demo Regular\'s as one period from Mar 1 (copy-windows-first-ios.png); a second copy from Demo Regular asked "Replace this season’s game windows?" in the same sheet, the source list gone (copy-windows-replace-ios.png), and Replace game windows closed it and saved them, the stored windows still one period from Mar 1 (copy-windows-replaced-ios.png)'
  )
}

/**
 * The device's log from now on, as idevicesyslog relays it: the React
 * Native JavaScript lines a Debug build writes to the unified log, teed to
 * support/ios-js.log. `next` waits for a line holding the text.
 */
function deviceLog(
  device: string,
  file: string
): {
  seen: (text: string) => boolean
  next: (text: string, timeout: number) => Promise<string>
  stop: () => Promise<void>
} {
  const child = spawn('idevicesyslog', ['-u', device, '--no-colors'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const lines: string[] = []
  let partial = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    const parts = (partial + chunk).split('\n')
    partial = parts.pop() ?? ''
    lines.push(...parts)
  })
  // The app's JavaScript console lines, which React Native logs under its
  // React category; the rest of the device log is other processes' and the
  // app's native noise.
  const kept = (): string[] =>
    lines.filter(line => line.includes('TeamStation(React)'))
  return {
    seen: text => lines.some(line => line.includes(text)),
    next: async (text, timeout) => {
      const deadline = Date.now() + timeout
      for (;;) {
        const found = lines.find(line => line.includes(text))
        if (found != null) return found
        if (Date.now() > deadline)
          throw new Error(`No device log line with ${text}`)
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    },
    stop: async () => {
      child.kill()
      await writeFile(file, kept().join('\n') + '\n')
    }
  }
}

/**
 * The directions log: each run's `$` line and the URL it opened. A run
 * replaces its own platform's lines and keeps the other's.
 */
async function logDirections(
  artifacts: string,
  command: string,
  url: string
): Promise<void> {
  const file = join(artifacts, 'directions.log')
  const kept = (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter(
      line =>
        line !== '' &&
        !line.startsWith('ios: ') &&
        !line.startsWith(
          '$ node -r sucrase/register src/app/autoSchedulerFixesIOS.e2e.ts'
        )
    )
  await writeFile(file, [...kept, command, `ios: ${url}`].join('\n') + '\n')
}

/**
 * I2: a field-linked game's Info tab names the field after its venue, its
 * map is centred on the field's own point, and the address routes Apple Maps
 * to that point, with the URL a development build logs.
 */
async function i2(run: Run): Promise<void> {
  const { fx, m } = run
  const title = 'Example Park · Field 1'
  // The map shows the point the event location answer gives: Field 1's own
  // pin, never the venue's or a geocoded address.
  const location = await api<EventLocation>(
    fx,
    ADMIN,
    'GET',
    `/events/${G1}/location`
  )
  expect({
    latitude: location.latitude,
    longitude: location.longitude
  }).deep.equals(FIELD_ONE_PIN)
  // A launch with no permissions has WebDriverAgent accept every alert,
  // which takes the directions sheet's first choice before the test can.
  // Bring the app back with no alert handling, so the sheet waits.
  await m.launchApp({
    appId: APP_ID,
    stopApp: false,
    clearState: false,
    permissions: { all: 'unset' }
  })
  await run.visit(`/games/${G1}?tab=info`)
  await show(m, `.*${title}.*`)
  // On an iPhone the title sits under the floating tab
  // bar at the top of the tab; bring it up to the middle of the screen,
  // under the map, so the shot shows both.
  {
    const card = (await nodes(m)).find(
      n => (n.text ?? '').includes(title) && n.bounds != null
    )
    const screen = ((await m.hierarchy()) as Node).bounds
    if (card?.bounds != null && screen != null) {
      const y = card.bounds.y / screen.height
      trace(`${title} at ${y.toFixed(2)}`)
      if (y > 0.75) {
        await m.swipe({ start: '3%,70%', end: '3%,50%', duration: 2000 })
        await m.waitForAnimationToEnd()
        const after = (await nodes(m)).find(
          n => (n.text ?? '').includes(title) && n.bounds != null
        )
        trace(
          `${title} now at ${((after?.bounds?.y ?? 0) / screen.height).toFixed(2)}`
        )
      }
    }
  }
  // Framed as game-info-field-ios-before.png: the top of the Info tab, the
  // map's tiles loaded.
  await new Promise(resolve => setTimeout(resolve, 6000))
  await run.capture('game-info-field-ios-after.png')
  const url = `https://maps.apple.com/?daddr=${FIELD_ONE_PIN.latitude},${FIELD_ONE_PIN.longitude}&q=${encodeURIComponent(title)}`
  // A Release build logs nothing; its directions are what Apple Maps shows.
  const release = process.env.TS_AUTO_SCHEDULER_IOS_RELEASE === '1'
  const log = release
    ? undefined
    : deviceLog(run.device, join(run.support, 'ios-js.log'))
  let line: string | undefined
  let maps: string[]
  try {
    // Let the relay connect before the tap.
    await new Promise(resolve => setTimeout(resolve, 2000))
    trace('tap Open directions')
    await m.tapOn({
      text: 'Open directions',
      retryTapIfNoChange: false,
      timeout: 15000
    })
    await new Promise(resolve => setTimeout(resolve, 1500))
    await run.capture(join(run.support, 'I2-directions-sheet.png'))
    expect(
      log?.seen('[directions]') ?? false,
      'a URL opened before Apple Maps was chosen'
    ).equals(false)
    // The sheet's choice, not Apple Maps' own search field once it opens.
    const choice = (await nodes(m)).find(
      n => n.text === 'Apple Maps' && n.type === 'Button' && n.bounds != null
    )
    expect(choice, 'the sheet’s Apple Maps choice').not.equals(undefined)
    trace('tap the sheet’s Apple Maps')
    await m.tapOn({
      point: `${Math.round(choice!.bounds!.x + choice!.bounds!.width / 2)},${Math.round(choice!.bounds!.y + choice!.bounds!.height / 2)}`,
      retryTapIfNoChange: false
    })
    if (log != null) {
      line = await log.next(`[directions] ${url}`, 20000)
      trace(`device log: ${line.trim()}`)
    }
    // Give Apple Maps time to open and route. On its first launch Maps
    // shows a one-time notice about its ads over the route: let it go.
    await new Promise(resolve => setTimeout(resolve, 6000))
    const notice = await nodes(m)
    if (
      notice.some(
        n => n.text === 'Ads' || (n.text ?? '').includes('local ads')
      ) &&
      notice.some(n => n.text === 'Continue')
    ) {
      await tap(m, 'Continue')
      await new Promise(resolve => setTimeout(resolve, 4000))
    }
    // Apple Maps shows where the device is: keep its screen out of the
    // artifacts directory.
    const own = resolve('coverage/autoSchedulerFixesIOS')
    await mkdir(own, { recursive: true })
    await run.capture(join(own, 'I2-apple-maps.png'))
    const texts = (await nodes(m)).map(n => n.text ?? '')
    maps = texts.filter(text => /Field 1|Example Park|40\.0212/.test(text))
    // Apple Maps names the destination by its own lookup of the point: the
    // route's last stop, the row above Add Stop. The start, the device's
    // own location, is never reported.
    const stop = texts.indexOf('Add Stop')
    const destination = texts
      .slice(0, Math.max(stop, 0))
      .filter(text => text !== '')
      .pop()
    if (
      texts.includes('Directions') &&
      destination != null &&
      destination !== 'My Location'
    )
      maps.push(`Directions to ${destination}`)
  } finally {
    await log?.stop()
  }
  trace(`Apple Maps shows: ${maps.join(' | ')}`)
  if (line == null) expect(maps, 'Apple Maps on the field').not.deep.equals([])
  else await logDirections(run.artifacts, run.command, url)
  // Back to the app, as a person returning from Maps.
  await m.launchApp({ appId: APP_ID, stopApp: false, clearState: false })
  const logged =
    line == null
      ? 'a Release build, which logs no URL'
      : `logged "[directions] ${url}" (support/ios-js.log)`
  await run.pass(
    `G1's Info tab reads "${title}" above the address, its map centred on Field 1's own pin ${FIELD_ONE_PIN.latitude}, ${FIELD_ONE_PIN.longitude} (the event location answer); tapping the address offered Apple Maps, and choosing it (${logged}) opened Apple Maps on that destination${maps.length > 0 ? ` (on screen: ${maps.slice(0, 3).join(' | ')})` : ''}`
  )
}

/** The scenarios, each a list of parts. */
const SCENARIOS: Record<string, Part[]> = {
  I1: [
    { id: 'I1', start: 'E2', run: i1Search },
    { id: 'I1', start: 'E3', run: i1Map }
  ],
  I2: [{ id: 'I2', start: 'E5', run: i2 }],
  I3: [
    { id: 'I3a', start: 'E7', run: i3a },
    { id: 'I3b', start: 'E2', run: i3b },
    { id: 'I3c', start: 'E7', run: i3c }
  ],
  I4: [{ id: 'I4', start: 'E7', run: i4 }]
}

async function main(): Promise<void> {
  const artifacts = required('TS_AUTO_SCHEDULER_ARTIFACTS')
  const device = required('TS_AUTO_SCHEDULER_IOS_DEVICE')
  const host = required('TS_AUTO_SCHEDULER_IOS_HOST')
  const port = Number(required('TS_AUTO_SCHEDULER_IOS_PORT'))
  const teamId = process.env.MAESTRO_D_TEAM_ID
  const only = process.argv.includes('--only')
    ? process.argv[process.argv.indexOf('--only') + 1]
    : undefined
  const picked = only?.split(',')
  const chosen = Object.entries(SCENARIOS)
    .map(([scenario, parts]) => ({
      scenario,
      parts: parts.filter(
        part =>
          picked == null ||
          picked.includes(scenario) ||
          picked.includes(part.id)
      )
    }))
    .filter(({ parts }) => parts.length > 0)
  if (chosen.length === 0) throw new Error(`No scenario ${only}`)
  const support = join(artifacts, 'support')
  await mkdir(support, { recursive: true })
  // A rerun's own directory, for its logs and its screenshots by name.
  const out = process.env.TS_AUTO_SCHEDULER_IOS_OUT
  if (out != null) await mkdir(out, { recursive: true })
  const command = `$ node -r sucrase/register src/app/autoSchedulerFixesIOS.e2e.ts${only == null ? '' : ` --only ${only}`}`
  const places = await googlePlacesStub()
  const lan = lanServer(host, port)
  const daemon = await maestro(process.env.MAESTRO_D ?? 'autoSchedulerFixesIOS')
  let m: MaestroHandle | undefined
  try {
    m = await daemon.attach({
      device,
      platform: 'ios',
      appId: APP_ID,
      ...(teamId == null || teamId === '' ? {} : { teamId }),
      artifacts: 'on-failure',
      driverStartTimeout: 300
    })
    const session = m
    for (const { scenario, parts } of chosen) {
      const lines = join(out ?? support, `${scenario}.log`)
      await writeFile(lines, `${command}\n`)
      for (const part of parts) {
        console.log(`${part.id} (start ${part.start})`)
        const fx = await autoSchedulerFixture(undefined, {
          cityLookup: googlePlaces({
            apiKey: 'placeholder-key',
            baseUrl: places.baseUrl
          })
        })
        try {
          const state = await seedThrough(fx, part.start)
          await lan.start(fx.f.h.origin)
          await signIn(session, fx)
          await part.run({
            fx,
            m: session,
            state,
            artifacts,
            support,
            device,
            command,
            visit: async path => {
              trace(`visit ${path}`)
              await session.openLink({
                link: 'teamstation://' + path.replace(/^\//, '')
              })
              await session.waitForAnimationToEnd()
              await refuseLocation(session, 4000)
            },
            capture: async name => {
              await session.waitForAnimationToEnd()
              const file = name.startsWith('/')
                ? name
                : join(out ?? artifacts, name)
              await writeFile(file, await session.screenshot())
              trace(`captured ${file}`)
            },
            pass: async description => {
              const line = `${part.id} PASS: ${description}`
              await writeFile(lines, line + '\n', { flag: 'a' })
              console.log(line)
            }
          })
        } catch (error) {
          // A failure can be anywhere, Apple Maps or a system alert's map
          // of the device's location among them: outside the artifacts.
          const own = resolve('coverage/autoSchedulerFixesIOS')
          await mkdir(own, { recursive: true })
          await writeFile(
            join(own, `${part.id}-failure.png`),
            await session.screenshot()
          )
          await writeFile(
            join(own, `${part.id}-failure-hierarchy.json`),
            JSON.stringify(await session.hierarchy(), null, 2)
          )
          throw error
        } finally {
          await lan.stop()
          await fx.f.h.close()
        }
      }
    }
  } finally {
    await m?.detach()
    await daemon.shutdown()
    await places.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
