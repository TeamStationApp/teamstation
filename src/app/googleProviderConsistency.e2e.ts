import assert from 'node:assert/strict'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

import { SESSION_COOKIE } from '../server/auth/tokens'
import { googlePlaces } from '../server/location/googlePlaces'
import { serverConfig } from '../server/serverConfig'
import { googlePlacesStub } from '../test/googlePlacesStub'
import { groupFixture } from '../test/groupFixtures'
import { inMapFrame, waitInMapFrame } from '../test/mapFrameProbe'
import {
  browserSession,
  fill,
  maestro,
  tap
} from '../test/refinementsMaestro.e2e'
import { recordBrowserCoverage } from './browserCoverage.e2e'

type MapMode =
  'success' | 'authentication' | 'network' | 'initialization' | 'timeout'

/** The map's longitude, from inside its frame, on Google's map or Leaflet's. */
const MAP_LONGITUDE = `(()=>{const center=window.eventMap.getCenter();return typeof center.lng==='function'?center.lng():center.lng})()`

/** Controlled external SDK, not an application response or a substitute UI path. */
function sdk(mode: MapMode): string {
  return `(()=>{
    const mode=${JSON.stringify(mode)};
    class Map {
      constructor(node,{center}){
        this.lat=center.lat;this.lng=center.lng;this.listeners={};this.node=node;
        node.dataset.googleProvider='true';node.style.background='repeating-linear-gradient(0deg,#e8eff1,#e8eff1 34px,#cbdadc 35px,#cbdadc 36px)';
        const label=document.createElement('div');label.textContent='Google (controlled test SDK)';label.style.cssText='position:absolute;bottom:4px;right:4px;background:white;font:12px sans-serif';node.appendChild(label);
        let start=null;
        node.addEventListener('pointerdown',e=>{start=e.clientX});
        node.addEventListener('pointerup',e=>{if(start==null)return;this.lng+=(start-e.clientX)/1000;start=null;this.listeners.idle?.()});
      }
      addListener(name,fn){this.listeners[name]=fn;setTimeout(()=>{if(mode!=='timeout'||name==='idle')fn()},30);if(mode==='timeout')setTimeout(fn,17000)}
      getCenter(){return {lat:()=>this.lat,lng:()=>this.lng}}
    }
    class AdvancedMarkerElement {constructor({map}){const marker=document.createElement('div');marker.style.cssText='position:absolute;left:50%;top:50%;width:18px;height:18px;background:#2376cf;border:3px solid white;border-radius:50%';map.node.appendChild(marker)}}
    window.google={maps:{importLibrary:async name=>{if(mode==='initialization')throw Error('Synthetic SDK failure');return name==='maps'?{Map}:{AdvancedMarkerElement}}}};
    setTimeout(()=>{if(mode==='authentication')window.gm_authFailure();else window.initEventMap()},0);
  })();`
}

async function main(): Promise<void> {
  assert(
    process.env.TS_CREATION_ARTIFACTS != null &&
      process.env.TS_CREATION_ARTIFACTS !== '',
    'Set TS_CREATION_ARTIFACTS'
  )
  const artifacts = resolve(process.env.TS_CREATION_ARTIFACTS)
  if (
    process.argv.includes('--before') &&
    existsSync(resolve(artifacts, 'google-provider-before.png'))
  ) {
    console.log(
      'Immutable before evidence already exists; preserved without replacement'
    )
    return
  }
  mkdirSync(resolve(artifacts, 'support/google-providers'), { recursive: true })
  const stub = await googlePlacesStub()
  let photonCalls = 0
  const photon = createServer((req, res) => {
    if (req.url?.startsWith('/tiles/') === true) {
      res.setHeader('content-type', 'image/png')
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=',
          'base64'
        )
      )
      return
    }
    photonCalls++
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        features: [
          {
            properties: {
              osm_id: 1,
              osm_type: 'way',
              osm_key: 'leisure',
              name: 'Harbor Field',
              city: 'Demo City',
              state: 'Demo Region',
              country: 'US',
              street: 'Demo Way',
              housenumber: '1'
            },
            geometry: { coordinates: [13, 35] }
          }
        ]
      })
    )
  })
  await new Promise<void>(resolve => photon.listen(0, '127.0.0.1', resolve))
  const address = photon.address()
  assert(address != null && typeof address !== 'string')
  const oldProvider = process.env.TS_EVENT_GEOCODER_URL
  const oldTiles = process.env.TS_EVENT_MAP_TILES
  process.env.TS_EVENT_GEOCODER_URL = `http://127.0.0.1:${address.port}/api`
  process.env.TS_EVENT_MAP_TILES = `http://127.0.0.1:${address.port}/tiles/{z}/{x}/{y}.png`
  const daemon = await maestro(
    process.env.MAESTRO_D ?? 'settings-google-providers'
  )
  let mode: MapMode = 'success'
  const session = await browserSession(
    daemon,
    `google-providers-${process.pid}`,
    402,
    874,
    artifacts
  )
  const { m, browser, page } = session
  page.on('pageerror', error => {
    console.log('Browser script error:', String(error))
  })
  const coverageFiles: string[] = []
  await page.setViewport({
    width: 402,
    height: 874,
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true
  })
  await page.setRequestInterception(true)
  await page.setCacheEnabled(false)
  page.on('request', request => {
    if (request.url().startsWith('https://maps.googleapis.com/maps/api/js?')) {
      console.log('Controlled Maps SDK request:', mode)
      if (mode === 'network') request.abort('failed').catch(() => undefined)
      else
        request
          .respond({
            status: 200,
            contentType: 'application/javascript',
            body: sdk(mode)
          })
          .catch(() => undefined)
    } else request.continue().catch(() => undefined)
  })
  async function shot(file: string): Promise<void> {
    await m.waitForAnimationToEnd()
    writeFileSync(resolve(artifacts, file), await m.screenshot())
  }
  async function mapProvider(
    expected: 'google' | 'openstreetmap'
  ): Promise<void> {
    await waitInMapFrame(
      page,
      `document.querySelector('${
        expected === 'google' ? '[data-google-provider]' : '.leaflet-container'
      }')!=null`,
      25000
    )
  }
  async function pan(): Promise<void> {
    const before = await inMapFrame<number>(page, MAP_LONGITUDE)
    const rect = await page.$eval(
      '[data-testid="event-location-map"]',
      node => {
        const r = node.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      }
    )
    await m.command('dragAndDrop', {
      from: {
        point: `${Math.round(rect.x + rect.width * 0.35)},${Math.round(rect.y + rect.height / 2 + 30)}`
      },
      to: {
        point: `${Math.round(rect.x + rect.width * 0.65)},${Math.round(rect.y + rect.height / 2 + 30)}`
      },
      holdDuration: 100,
      duration: 500
    })
    await waitInMapFrame(page, `${MAP_LONGITUDE}!==${before}`, 5000)
  }
  async function directions(): Promise<void> {
    await page.evaluate(() => {
      ;(window as any).__directions = ''
      window.open = url => {
        ;(window as any).__directions = String(url)
        return null
      }
    })
    await m.scrollUntilVisible({
      element: { id: 'event-directions' },
      direction: 'DOWN',
      centerElement: true
    })
    await m.tapOn({ id: 'event-directions' })
    assert(
      String(
        await page.evaluate(() => (window as any).__directions)
      ).startsWith('https://www.google.com/maps/dir/')
    )
  }
  async function fixtureCase(
    name: string,
    configured: boolean,
    action: (f: Awaited<ReturnType<typeof groupFixture>>) => Promise<void>
  ): Promise<void> {
    photonCalls = 0
    stub.calls.length = 0
    stub.controls.empty = false
    stub.controls.fail = false
    stub.controls.delay = 0
    const provider = configured
      ? googlePlaces({ apiKey: 'placeholder-key', baseUrl: stub.baseUrl })
      : undefined
    const f = await groupFixture(
      resolve('dist'),
      undefined,
      undefined,
      provider,
      { googleMapsApiKey: configured ? 'placeholder-display-key' : '' }
    )
    try {
      await browser.setCookie({
        name: SESSION_COOKIE,
        value: f.h.tokens.get(101)!,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true
      })
      await f.h.resetLimits()
      await action(f)
      console.log(`${name} PASS`)
    } catch (error) {
      await shot(`support/google-providers/${name}-failure.png`)
      console.log(
        'Map diagnostic',
        await inMapFrame(
          page,
          `({google:window.google!=null,map:window.eventMap!=null,leaflet:window.L!=null,controlled:document.querySelector('[data-google-provider]')!=null})`
        ).catch(() => 'no map frame')
      )
      throw error
    } finally {
      const output = resolve(
        'coverage/creation',
        `google-provider-${name}-browser.json`
      )
      await recordBrowserCoverage([page], f.h.origin, output)
      coverageFiles.push(output)
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        includeRawScriptCoverage: true
      })
      await f.h.close()
    }
  }
  async function event(
    f: Awaited<ReturnType<typeof groupFixture>>,
    startAt = '2037-04-10T18:00:00.000Z'
  ): Promise<string> {
    const response = await f.h.request('POST', '/events', {
      teamId: f.teamA,
      eventType: 'other',
      title: 'Team dinner',
      venue: 'Harbor Field',
      address: '1 Demo Way, Demo City',
      startAt,
      timezone: 'UTC',
      idempotencyKey: 'google-provider-event'
    })
    assert.equal(response.status, 201)
    return (await response.json()).id
  }
  async function openMap(
    f: Awaited<ReturnType<typeof groupFixture>>,
    id: string
  ): Promise<void> {
    await m.openLink({ link: f.h.origin + `/games/${id}` })
    await m.assertVisible({ id: 'event-location-map', timeout: 20000 })
    await m.scrollUntilVisible({
      element: { id: 'event-location-map' },
      direction: 'DOWN',
      centerElement: true
    })
  }
  try {
    if (process.argv.includes('--before')) {
      await fixtureCase('before', false, async f => {
        await m.openLink({
          link: f.h.origin + `/groups/team/${f.teamA}/create-game`
        })
        await m.assertVisible({ text: 'Other', timeout: 20000 })
        await m.tapOn({ text: 'Other' })
        await fill(m, 'Venue name (optional)', 'Harbor')
        await m.scrollUntilVisible({
          element: { text: '© OpenStreetMap contributors' },
          direction: 'DOWN',
          centerElement: true
        })
        await shot('google-provider-before.png')
        const id = await event(f)
        await openMap(f, id)
        await mapProvider('openstreetmap')
        await shot('support/google-providers/map-before.png')
      })
      return
    }
    await fixtureCase('E28', true, async f => {
      await m.openLink({
        link: f.h.origin + `/groups/team/${f.teamA}/create-game`
      })
      await m.assertVisible({ text: 'Other', timeout: 20000 })
      await m.tapOn({ text: 'Other' })
      await fill(m, 'Title', 'Team dinner')
      await fill(m, 'Venue name (optional)', 'Harbor')
      await m.scrollUntilVisible({
        element: { text: 'Harbor Field' },
        direction: 'DOWN',
        centerElement: true
      })
      await tap(m, 'Choose Harbor Field')
      await fill(m, 'Venue name (optional)', 'Custom venue')
      await fill(m, 'Venue address (optional)', 'Demo Way')
      await m.scrollUntilVisible({
        element: { text: 'Powered by Google' },
        direction: 'DOWN',
        centerElement: true
      })
      assert(
        !(await page.evaluate(() => document.body.innerText)).includes(
          'OpenStreetMap'
        )
      )
      await shot('support/google-providers/search-primary.png')
      await tap(m, 'Choose Harbor Field')
      assert.equal(
        await page.$eval(
          'input[aria-label="Venue name (optional)"]',
          node => node.value
        ),
        'Custom venue'
      )
      await m.scrollUntilVisible({
        element: { text: 'Create event' },
        direction: 'DOWN',
        centerElement: true
      })
      await tap(m, 'Create event')
      await m.assertVisible({ id: 'event-info', timeout: 20000 })
      const id = (
        await f.h.db
          .selectFrom('team_events')
          .select('id')
          .executeTakeFirstOrThrow()
      ).id
      const info = await (await f.h.request('GET', `/events/${id}/info`)).json()
      assert.equal(info.venue, 'Custom venue')
      assert.equal(info.address, '1 Demo Way, Demo City')
      await m.scrollUntilVisible({
        element: { id: 'event-location-map' },
        direction: 'DOWN',
        centerElement: true
      })
      await mapProvider('google')
      await pan()
      await shot('support/google-providers/map-primary.png')
      await directions()
      assert.equal(photonCalls, 0)
      stub.controls.empty = true
      const empty = await (
        await f.h.request('GET', '/locations?kind=venue&query=No%20match')
      ).json()
      assert.equal(empty.provider, 'google')
      assert.deepEqual(empty.places, [])
      assert.equal(photonCalls, 0)
    })
    await fixtureCase('E29', true, async f => {
      stub.controls.fail = true
      await m.openLink({
        link: f.h.origin + `/groups/team/${f.teamA}/create-game`
      })
      await m.assertVisible({ text: 'Other', timeout: 20000 })
      await m.tapOn({ text: 'Other' })
      await fill(m, 'Venue name (optional)', 'Harbor')
      await m.scrollUntilVisible({
        element: { text: '© OpenStreetMap contributors' },
        direction: 'DOWN',
        centerElement: true
      })
      await shot('support/google-providers/search-fallback.png')
      await tap(m, 'Choose Harbor Field')
      const id = await event(f)
      await openMap(f, id)
      await mapProvider('google')
      const coords = await (
        await f.h.request('GET', `/events/${id}/location`)
      ).json()
      assert.equal(coords.latitude, 35)
      assert(photonCalls > 0)
      stub.controls.fail = false
      const google = await (
        await f.h.request('GET', `/events/${id}/location`)
      ).json()
      assert.equal(google.latitude, 34)
      const saved = await f.h.db
        .selectFrom('event_geocodes')
        .select('latitude')
        .where('address', '=', '1 demo way, demo city')
        .executeTakeFirstOrThrow()
      assert.equal(saved.latitude, 35)
      const calls = photonCalls
      stub.controls.empty = true
      const absent = await f.h.request('GET', `/events/${id}/location`)
      assert.equal(absent.status, 404)
      assert.equal(photonCalls, calls)
      await m.openLink({ link: f.h.origin + `/games/${id}` })
      await m.assertVisible({
        text: 'The address could not be located.*',
        timeout: 20000
      })
    })
    for (const failure of [
      'authentication',
      'network',
      'initialization',
      'timeout'
    ] as const) {
      mode = failure
      await fixtureCase(`E30-${failure}`, true, async f => {
        const id = await event(f)
        await openMap(f, id)
        await mapProvider('openstreetmap')
        await pan()
        await shot(`support/google-providers/map-${failure}.png`)
        await directions()
        if (failure === 'timeout') {
          await new Promise(resolve => setTimeout(resolve, 2500))
          await mapProvider('openstreetmap')
        }
        mode = 'success'
        await m.openLink({ link: f.h.origin + `/games/${id}` })
        await m.assertVisible({ id: 'event-location-map', timeout: 20000 })
        await mapProvider('google')
      })
    }
    mode = 'success'
    await fixtureCase('E30-unconfigured', false, async f => {
      const id = await event(f)
      await openMap(f, id)
      await mapProvider('openstreetmap')
      await pan()
      await directions()
      assert.equal(stub.calls.length, 0)
    })
    await fixtureCase('proving-pair', true, async f => {
      const id = await event(f, '2027-04-10T18:00:00.000Z')
      await m.openLink({ link: f.h.origin + `/games/${id}/settings` })
      await m.assertVisible({ text: 'Venue name', timeout: 20000 })
      await fill(m, 'Venue name (optional)', 'Harbor')
      await m.scrollUntilVisible({
        element: { text: 'Powered by Google' },
        direction: 'DOWN',
        centerElement: true
      })
      await shot('support/google-providers/search-primary.png')
      await openMap(f, id)
      await mapProvider('google')
      await shot('support/google-providers/map-primary.png')
    })
    if (process.argv.includes('--live')) {
      assert(
        serverConfig.googlePlaces != null,
        'Configure the server Places key in ignored local config'
      )
      const live = googlePlaces({ apiKey: serverConfig.googlePlaces.apiKey })
      const venues = await live.eventPlaces('park Austin Texas', 'venue')
      assert(venues.length > 0)
      const point = await live.coordinates('Austin, Texas, United States')
      assert(point.latitude > 29 && point.latitude < 31)
      appendFileSync(
        resolve(artifacts, 'google-provider-api.log'),
        `$ Live Google Places Text Search: public Austin parks and Austin coordinate lookup (key header redacted)\n${JSON.stringify({ venues, point })}\n`
      )
      console.log('E31 live Google search/geocoding PASS')
    }
    const { createCoverageMap } = require('istanbul-lib-coverage')
    const merged = createCoverageMap({})
    for (const file of coverageFiles)
      merged.merge(JSON.parse(readFileSync(file, 'utf8')))
    writeFileSync(
      resolve('coverage/creation/google-provider-browser.json'),
      JSON.stringify(merged.toJSON())
    )
    console.log(
      'E28–E31 stub/provider browser pass complete; native/Android adapter checks run separately'
    )
  } finally {
    await m.detach()
    await browser.disconnect()
    await daemon.shutdown()
    await stub.close()
    photon.closeAllConnections()
    await new Promise<void>(resolve =>
      photon.close(() => {
        resolve()
      })
    )
    if (oldProvider === undefined) delete process.env.TS_EVENT_GEOCODER_URL
    else process.env.TS_EVENT_GEOCODER_URL = oldProvider
    if (oldTiles === undefined) delete process.env.TS_EVENT_MAP_TILES
    else process.env.TS_EVENT_MAP_TILES = oldTiles
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
