// The Auto-Scheduler fixes' iOS scenarios, I1 to I3, against the app on a
// physical iPad or iPhone. Each part of a scenario starts from a fresh
// fixture seeded to its own start state, so none depends on another's
// leftovers.
//
// The app talks to TS_API_BASE_URL=http://<host>:<port>/api/v1 (see
// src/MOBILE.md): a Release build with it inlined for I1 and I3, and for I2 a
// Debug build served by Metro started with it and `--reset-cache`, since
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
// `--only` takes a scenario (I1, I2, I3) or one part of one (I3a, I3b). With no
// `--only`, every scenario runs in order. Each scenario's PASS lines go to
// support/<scenario>.log in the artifacts directory, after its `$` line.
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, request as forward, type Server } from 'node:http'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

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
import { maestro, type MaestroHandle } from '../test/refinementsMaestro.e2e'

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
        const outgoing = forward(
          new URL(req.url ?? '/', target),
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
  for (let attempt = 0; attempt < 8; attempt++) {
    const tree = (await m.hierarchy()) as Node
    const node = flatten(tree).find(n => n.text === text && n.bounds != null)
    if (node?.bounds == null || tree.bounds == null)
      throw new Error(`No ${text} to place`)
    const y = node.bounds.y / tree.bounds.height
    trace(`${text} at ${y.toFixed(2)}, wanted ${at}`)
    if (Math.abs(y - at) < 0.03) return
    const by = Math.max(-0.33, Math.min(0.33, at - y))
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
    permissions: { location: 'deny' }
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
  await tap(m, 'Sign in')
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
 * I1, search: the Field Manager lists at least ten places for "Example
 * Park", the registry's own first.
 */
async function i1Search(run: Run): Promise<void> {
  const { fx, m } = run
  await run.visit(`/groups/league/${fx.f.leagueA}/scheduler/fields`)
  await show(m, 'Field Manager')
  // The Field Manager asks where the device is, and is refused.
  await new Promise(resolve => setTimeout(resolve, 2000))
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
        [EXAMPLE_PARK.name, ...MORE_PARKS].includes(name) &&
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

const GAME_MINS = 'Demo Regular Game MINS'

/**
 * I3a: a tap on seasonA's Game MINS opens it in place with its number
 * selected and a keyboard with a return key; typing replaces the number, and
 * Return saves it.
 */
async function i3a(run: Run): Promise<void> {
  const { fx, m } = run
  await run.visit(`/groups/league/${fx.f.leagueA}/scheduler`)
  await show(m, 'SCHEDULE SETTINGS')
  await scrollTo(m, `${GAME_MINS}: 90`)
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
    { id: 'I3b', start: 'E2', run: i3b }
  ]
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
  const chosen = Object.entries(SCENARIOS)
    .map(([scenario, parts]) => ({
      scenario,
      parts: parts.filter(
        part => only == null || only === scenario || only === part.id
      )
    }))
    .filter(({ parts }) => parts.length > 0)
  if (chosen.length === 0) throw new Error(`No scenario ${only}`)
  const support = join(artifacts, 'support')
  await mkdir(support, { recursive: true })
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
      const lines = join(support, `${scenario}.log`)
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
            },
            capture: async name => {
              await session.waitForAnimationToEnd()
              const file = name.startsWith('/') ? name : join(artifacts, name)
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
