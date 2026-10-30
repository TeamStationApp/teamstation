// The web maps in the built page, under the page's real Content-Security-Policy,
// in a maestro-d web device. A map in a `srcdoc` frame takes that policy and
// draws nothing, so these scenarios serve the build as it ships.
//
//   npm run build.web
//   TS_MAESTRO_D_CLIENT=$HOME/git/maestro-d/npm/maestro-d \
//   MAESTRO_D_BIN=$HOME/.maestro-d/bin/maestro-d \
//   TS_AUTO_SCHEDULER_ARTIFACTS=<artifacts directory> \
//   MAESTRO_D=mapFramePolicy \
//     node -r sucrase/register src/app/mapFramePolicy.e2e.ts
//
// TS_MAP_POLICY_DIST serves another build's `dist`, such as the base branch's.
// With `--before` it only captures each screen, for a build with no fix to pass.
// Set TS_AUTO_SCHEDULER_BROWSER_COVERAGE to record the app's browser coverage.
// Browser callbacks avoid `?.`: Sucrase's helper is not in the page.
import { readFileSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import type { HTTPRequest, Page } from 'puppeteer'

import { cspFor, originsFor } from '../buildCsp.mjs'
import { SESSION_COOKIE } from '../server/auth/tokens'
import { googlePlaces } from '../server/location/googlePlaces'
import {
  type AutoSchedulerFixture,
  autoSchedulerFixture,
  DEMO_LATITUDE,
  DEMO_LONGITUDE,
  G1,
  seedThrough
} from '../test/autoSchedulerFixture'
import { GOOGLE_MAPS_SCRIPT } from '../test/googleMapsIntercept'
import { googlePlacesStub } from '../test/googlePlacesStub'
import {
  inMapFrame,
  isMapFrame,
  mapFrameOf,
  waitInMapFrame
} from '../test/mapFrameProbe'
import {
  type BrowserSession,
  browserSession,
  contains,
  log,
  maestro
} from '../test/refinementsMaestro.e2e'
import { recordBrowserCoverage } from './browserCoverage.e2e'
import { MAP_FRAME_READY_MS } from './components/pinMapDocument'

const DEVICE = 'mapFramePolicy-web'
const WIDTH = 390
const HEIGHT = 844
const OWNER = 101
const DRAGGED = { latitude: 40.0213, longitude: -75.2214 }
const PAN_ELEMENT = '[data-testid="event-location-map"]'
const APP_PANEL = '[data-testid="pin-map-unavailable"]'

/** How Google and the frame's page answer, as a scenario sets it. */
interface Answers {
  google: 'draws' | 'refuses'
  frame: 'serves' | 'refusesFraming' | 'fails'
}

/** A transparent pixel for every tile, so no map's tiles leave this machine. */
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

async function tileServer(): Promise<{
  server: Server
  template: string
  failing: { now: boolean }
}> {
  const failing = { now: false }
  const server = createServer((_, res) => {
    if (failing.now) {
      res.statusCode = 503
      res.end()
      return
    }
    res.setHeader('content-type', 'image/png')
    res.end(TILE)
  })
  await new Promise<void>(_resolve => server.listen(0, '127.0.0.1', _resolve))
  const { port } = server.address() as AddressInfo
  return {
    server,
    template: `http://127.0.0.1:${port}/{z}/{x}/{y}.png`,
    failing
  }
}

/** Answers Google's script and the frame's page as `answers` says. */
async function intercept(page: Page, answers: Answers): Promise<void> {
  const stub = readFileSync(resolve('src/test/googleMapsStub.js'), 'utf8')
  await page.setRequestInterception(true)
  page.on('request', (request: HTTPRequest) => {
    const url = request.url()
    if (url.startsWith(GOOGLE_MAPS_SCRIPT)) {
      request
        .respond({
          status: 200,
          contentType: 'application/javascript',
          body:
            answers.google === 'draws'
              ? stub
              : 'window.gm_authFailure && window.gm_authFailure()'
        })
        .catch(() => undefined)
      return
    }
    if (url.endsWith('/mapFrame.html') && answers.frame === 'refusesFraming') {
      request
        .respond({
          status: 200,
          contentType: 'text/html',
          headers: { 'X-Frame-Options': 'DENY' },
          body: '<!doctype html>'
        })
        .catch(() => undefined)
      return
    }
    if (url.endsWith('/mapFrame.html') && answers.frame === 'fails') {
      request.abort().catch(() => undefined)
      return
    }
    request.continue().catch(() => undefined)
  })
}

interface Run {
  b: BrowserSession
  fx: AutoSchedulerFixture
  answers: Answers
  state: { venueId: string; fieldId: string }
  visit: (path: string) => Promise<void>
  shot: (name: string) => Promise<void>
  tiles: { now: boolean }
  pass: (description: string) => Promise<void>
}

const STUB_PIN = `document.querySelector('[data-google-maps-stub] [data-lat]')!=null`
const fieldPath = (run: Run): string =>
  `/venues/${run.state.venueId}/fields/${run.state.fieldId}`
const gamePath = `/games/${G1}?section=info`

async function pin(
  run: Run
): Promise<{ lat: number; lng: number; draggable: boolean }> {
  await waitInMapFrame(run.b.page, STUB_PIN)
  return await inMapFrame(
    run.b.page,
    `(()=>{const pin=document.querySelector('[data-google-maps-stub] [data-lat]');return{lat:Number(pin.dataset.lat),lng:Number(pin.dataset.lng),draggable:pin.dataset.draggable==='true'}})()`
  )
}

async function waitForAppPanel(page: Page): Promise<void> {
  await page.waitForSelector(APP_PANEL, { timeout: MAP_FRAME_READY_MS + 5000 })
}

async function scrollMapIntoView(page: Page, selector: string): Promise<void> {
  await page.$eval(selector, node => {
    node.scrollIntoView({ block: 'center' })
  })
}

/** E1: the field's map draws under the policy, and its pin drags and saves. */
async function fieldPin(run: Run): Promise<void> {
  const { page } = run.b
  await run.visit(fieldPath(run))
  await contains(page, 'WHERE IT IS')
  // The drawn map first: a build without the fix fails here, on the blank box.
  const drawn = await pin(run)
  expect(drawn.draggable).equals(true)
  expect(page.frames().find(isMapFrame), 'the map frame').not.equals(undefined)
  expect(await inMapFrame(page, 'self.origin')).equals('null')
  await scrollMapIntoView(page, '[data-testid="pin-map"]')
  await run.shot('field-map-after.png')
  const frame = await mapFrameOf(page)
  await frame.evaluate(
    `window.__dragPin(${DRAGGED.latitude},${DRAGGED.longitude})`
  )
  await contains(page, 'Pin saved.')
  await page.reload()
  await contains(page, 'WHERE IT IS')
  const saved = await pin(run)
  expect({ lat: saved.lat, lng: saved.lng }).deep.equals({
    lat: DRAGGED.latitude,
    lng: DRAGGED.longitude
  })
  await run.pass('E1 the field map draws, and its pin drags, saves and reloads')
}

/** E2: the venue's map draws a pin that does not drag. */
async function venueMap(run: Run): Promise<void> {
  const { page } = run.b
  await run.visit(`/venues/${run.state.venueId}`)
  const drawn = await pin(run)
  expect(drawn.draggable).equals(false)
  await scrollMapIntoView(page, '[data-testid="pin-map"]')
  await run.shot('venue-map-after.png')
  await run.pass('E2 the venue map draws a pin that does not drag')
}

/** E3, with a key: Google's map, then the Leaflet it falls back to. */
async function eventMapWithKey(run: Run): Promise<void> {
  const { page } = run.b
  await run.visit(gamePath)
  await waitInMapFrame(
    page,
    `document.querySelector('[data-google-maps-stub]')!=null`
  )
  expect(
    await inMapFrame(page, `document.querySelector('.leaflet-container')==null`)
  ).equals(true)
  await scrollMapIntoView(page, PAN_ELEMENT)
  await run.shot('event-map-after.png')
  run.answers.google = 'refuses'
  await page.reload()
  await waitInMapFrame(
    page,
    `document.querySelector('.leaflet-container')!=null`
  )
  await new Promise(_resolve => setTimeout(_resolve, MAP_FRAME_READY_MS + 1000))
  expect(await page.$(APP_PANEL), 'the panel over the fallback').equals(null)
  expect(
    await inMapFrame(page, `document.querySelector('.leaflet-container')!=null`)
  ).equals(true)
  await scrollMapIntoView(page, PAN_ELEMENT)
  await run.shot('event-fallback-after.png')
  run.answers.google = 'draws'
  await run.pass(
    'E3 the event map draws Google, and a refused key leaves Leaflet drawn past the wait'
  )
}

/** E3, with no key: Leaflet, which a drag pans. */
async function eventMapLeaflet(run: Run): Promise<void> {
  const { b } = run
  await run.visit(gamePath)
  await waitInMapFrame(b.page, 'window.eventMap!=null')
  await scrollMapIntoView(b.page, PAN_ELEMENT)
  const before = await inMapFrame<{ lng: number }>(
    b.page,
    'window.eventMap.getCenter()'
  )
  const box = await b.page.$eval(PAN_ELEMENT, node => {
    const r = node.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const { dragAndDrop } = b.m as unknown as {
    dragAndDrop: (args: Record<string, unknown>) => Promise<unknown>
  }
  await dragAndDrop.call(b.m, {
    from: {
      point: `${Math.round(box.x + box.width * 0.7)},${Math.round(box.y + box.height / 2)}`
    },
    to: {
      point: `${Math.round(box.x + box.width * 0.3)},${Math.round(box.y + box.height / 2)}`
    },
    holdDuration: 100,
    duration: 500
  })
  await waitInMapFrame(
    b.page,
    `window.eventMap.getCenter().lng!==${before.lng}`,
    5000
  )
  // An attribution link opens a tab of its own and leaves the map drawn.
  const tab = b.browser.waitForTarget(target =>
    target.url().includes('openstreetmap')
  )
  await (
    await mapFrameOf(b.page)
  ).click('.leaflet-control-attribution a[href*="openstreetmap"]')
  const page = await (await tab).page()
  await page?.close()
  expect(await inMapFrame(b.page, 'window.eventMap!=null')).equals(true)
  // Tiles that stop answering show the map's own banner, and its Retry works
  // from inside the sandbox.
  run.tiles.now = true
  await b.page.reload()
  await waitInMapFrame(
    b.page,
    `document.querySelector('#error').style.display==='block'`
  )
  run.tiles.now = false
  const frame = await mapFrameOf(b.page)
  await frame.click('#retry-map-tiles')
  await waitInMapFrame(
    b.page,
    `document.querySelector('#error').style.display==='none'`
  )
  await run.pass(
    'E3 with no key the event map draws Leaflet, a drag pans it, and failed tiles recover through its Retry'
  )
}

/** E4: a refused key shows the pin map's panel, and Retry starts it again. */
async function refusedKey(run: Run): Promise<void> {
  const { page } = run.b
  run.answers.google = 'refuses'
  await run.visit(fieldPath(run))
  await waitInMapFrame(
    page,
    `document.querySelector('#failed:not([hidden])')!=null`
  )
  const panel = await inMapFrame<string>(
    page,
    `document.querySelector('#failed').textContent`
  )
  expect(panel).includes('The map couldn’t load')
  expect(panel).includes('Retry')
  await scrollMapIntoView(page, '[data-testid="pin-map"]')
  await run.shot('map-refused-after.png')
  run.answers.google = 'draws'
  const frame = await mapFrameOf(page)
  await frame.click('#retry')
  await pin(run)
  await run.pass(
    'E4 a refused key shows the panel, and Retry draws the map in a new frame'
  )
}

/** E5: a frame that never starts shows the app's panel, however it got there. */
async function neverStarts(run: Run): Promise<void> {
  const { b } = run
  run.answers.frame = 'refusesFraming'
  await run.visit(fieldPath(run))
  await waitForAppPanel(b.page)
  await scrollMapIntoView(b.page, APP_PANEL)
  await run.shot('map-failed-after.png')
  run.answers.frame = 'serves'
  await b.page.click('[data-testid="pin-map-retry"]')
  await pin(run)
  // From the document's own panel, on a connection that has since dropped.
  run.answers.google = 'refuses'
  await b.page.reload()
  await waitInMapFrame(
    b.page,
    `document.querySelector('#failed:not([hidden])')!=null`
  )
  run.answers.frame = 'fails'
  const frame = await mapFrameOf(b.page)
  await frame.click('#retry')
  await waitForAppPanel(b.page)
  run.answers.frame = 'serves'
  run.answers.google = 'draws'
  await run.pass(
    'E5 a frame refused by the proxy, or a retry that cannot load, shows the panel'
  )
}

/** E6: the frame cannot reach the app, and the app's policy is as it was. */
async function isolation(run: Run): Promise<void> {
  const { page } = run.b
  await run.visit(fieldPath(run))
  await pin(run)
  const policy = await page.$eval(
    'meta[http-equiv="Content-Security-Policy"]',
    node => node.getAttribute('content')
  )
  expect(policy).equals(cspFor(originsFor('/api/v1', '')))
  expect(policy).includes("script-src 'self' 'wasm-unsafe-eval';")
  for (const read of ['parent.document.title', 'localStorage.length'])
    expect(
      await inMapFrame(
        page,
        `(()=>{try{${read};return 'reached'}catch(error){return error.name}})()`
      ),
      read
    ).equals('SecurityError')
  // Google's map hears of a resize through a child frame of its own: a frame
  // the sandbox refuses answers with the map frame's window.
  expect(
    await inMapFrame(
      page,
      `(()=>{const child=document.createElement('iframe');document.body.appendChild(child);const same=child.contentWindow===window;child.remove();return same})()`
    )
  ).equals(true)
  await run.visit('/mapFrame.html')
  expect(await page.evaluate(() => self.origin)).not.equals('null')
  await page.evaluate(() => {
    window.postMessage(
      { type: 'teamstation:mapDocument', html: '<p id="written"></p>' },
      '*'
    )
  })
  await new Promise(_resolve => setTimeout(_resolve, 300))
  expect(await page.$('#written')).equals(null)
  await run.pass(
    'E6 the policy is unchanged, the frame reaches nothing of the app, and the page does nothing unsandboxed'
  )
}

/** Each state as a build with no fix shows it, for the before shots. */
async function before(run: Run): Promise<void> {
  const settle = async (): Promise<void> => {
    await new Promise(_resolve => setTimeout(_resolve, 3000))
  }
  await run.visit(fieldPath(run))
  await contains(run.b.page, 'WHERE IT IS')
  await scrollMapIntoView(run.b.page, '[data-testid="pin-map"]')
  await settle()
  await run.shot('field-map-before.png')
  await run.shot('map-failed-before.png')
  await run.visit(`/venues/${run.state.venueId}`)
  await contains(run.b.page, 'MAP')
  await scrollMapIntoView(run.b.page, '[data-testid="pin-map"]')
  await settle()
  await run.shot('venue-map-before.png')
  await run.visit(gamePath)
  await run.b.page.waitForSelector(PAN_ELEMENT, { timeout: 15000 })
  await scrollMapIntoView(run.b.page, PAN_ELEMENT)
  await settle()
  await run.shot('event-map-before.png')
  run.answers.google = 'refuses'
  await run.b.page.reload()
  await run.b.page.waitForSelector(PAN_ELEMENT, { timeout: 15000 })
  await scrollMapIntoView(run.b.page, PAN_ELEMENT)
  await settle()
  await run.shot('event-fallback-before.png')
  await run.visit(fieldPath(run))
  await contains(run.b.page, 'WHERE IT IS')
  await scrollMapIntoView(run.b.page, '[data-testid="pin-map"]')
  await settle()
  await run.shot('map-refused-before.png')
  run.answers.google = 'draws'
}

async function main(): Promise<void> {
  const artifacts = process.env.TS_AUTO_SCHEDULER_ARTIFACTS
  if (artifacts == null) throw new Error('Set TS_AUTO_SCHEDULER_ARTIFACTS')
  const taking = process.argv.includes('--before')
  const work = resolve('coverage/mapFramePolicy/support')
  const web = join(work, 'web')
  await rm(web, { recursive: true, force: true })
  await mkdir(web, { recursive: true })
  await cp(resolve(process.env.TS_MAP_POLICY_DIST ?? 'dist'), web, {
    recursive: true
  })
  const lines = 'policy-e2e-run.log'
  const coverage = process.env.TS_AUTO_SCHEDULER_BROWSER_COVERAGE
  const tiles = await tileServer()
  process.env.TS_EVENT_MAP_TILES = tiles.template
  const places = await googlePlacesStub()
  const daemon = await maestro(process.env.MAESTRO_D ?? 'mapFramePolicy')
  let b: BrowserSession | undefined
  try {
    b = await browserSession(daemon, DEVICE, WIDTH, HEIGHT, work)
    const session = b
    const answers: Answers = { google: 'draws', frame: 'serves' }
    await intercept(session.page, answers)
    const cdp = await session.page.createCDPSession()
    const scenarios: Array<{
      key: string | undefined
      steps: Array<(run: Run) => Promise<void>>
    }> = taking
      ? [
          {
            key: 'test-key',
            steps: [before]
          }
        ]
      : [
          {
            key: 'test-key',
            steps: [
              fieldPin,
              venueMap,
              eventMapWithKey,
              refusedKey,
              neverStarts,
              isolation
            ]
          },
          { key: undefined, steps: [eventMapLeaflet] }
        ]
    for (const { key, steps } of scenarios) {
      const fx = await autoSchedulerFixture(web, {
        cityLookup: googlePlaces({
          apiKey: 'placeholder-key',
          baseUrl: places.baseUrl
        }),
        googleMapsApiKey: key
      })
      try {
        const state = await seedThrough(fx, 'E3')
        await fx.f.h.db
          .updateTable('games')
          .set({
            venue: 'Demo Park',
            address: '1 Demo Way',
            latitude: DEMO_LATITUDE,
            longitude: DEMO_LONGITUDE
          })
          .where('id', '=', G1)
          .execute()
        await cdp.send('Network.clearBrowserCookies')
        await session.m.openBrowser({ url: fx.f.h.origin })
        await session.page.setCookie({
          name: SESSION_COOKIE,
          value: fx.f.h.tokens.get(OWNER)!,
          domain: '127.0.0.1',
          path: '/'
        })
        const run: Run = {
          b: session,
          fx,
          answers,
          tiles: tiles.failing,
          state: { venueId: state.venueId!, fieldId: state.fieldId! },
          visit: async path => {
            await session.m.openBrowser({ url: fx.f.h.origin + path })
          },
          shot: async name => {
            await session.m.waitForAnimationToEnd()
            await writeFile(join(artifacts, name), await session.m.screenshot())
          },
          pass: async description => {
            await log(artifacts, lines, `PASS ${description}`)
          }
        }
        for (const step of steps) await step(run)
        if (coverage != null && key != null)
          await recordBrowserCoverage(
            [session.page],
            fx.f.h.origin,
            coverage,
            web
          )
      } finally {
        await session.m
          .openBrowser({ url: 'about:blank' })
          .catch(() => undefined)
        await fx.f.h.close()
      }
    }
  } finally {
    if (b != null) {
      await b.browser.disconnect()
      await b.m.detach()
    }
    await daemon.shutdown()
    await places.close()
    tiles.server.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
