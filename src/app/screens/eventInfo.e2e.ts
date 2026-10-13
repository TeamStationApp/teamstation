import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'

import { sql } from 'kysely'
import puppeteer, { type Browser as CoverageBrowser } from 'puppeteer'

import { makeId } from '../../common/ids'
import { SESSION_COOKIE } from '../../server/auth/tokens'
import { groupFixture } from '../../test/groupFixtures'

interface Browser {
  openBrowser: (body: { url: string }) => Promise<unknown>
  setCookies: (body: {
    cookies: Array<{
      name: string
      value: string
      domain: string
      path: string
    }>
  }) => Promise<unknown>
  tapOn: (body: {
    id?: string
    text?: string
    css?: string
    point?: string
  }) => Promise<unknown>
  tapOnPoint: (body: { x: number; y: number }) => Promise<unknown>
  inputText: (body: { text: string }) => Promise<unknown>
  eraseText: () => Promise<unknown>
  assertVisible: (body: {
    text?: string
    id?: string
    css?: string
    timeout?: number
  }) => Promise<unknown>
  evalBrowserScript: (body: { script: string }) => Promise<{ data?: unknown }>
  eval: (script: string) => Promise<unknown>
  screenshot: () => Promise<Buffer>
  dragAndDrop: (body: {
    from: { id?: string; point?: string }
    to: { id?: string; point?: string }
    holdDuration?: number
    duration: number
  }) => Promise<unknown>
  swipe: (body: {
    start: string
    end: string
    duration: number
  }) => Promise<unknown>
  waitForAnimationToEnd: () => Promise<unknown>
  back: () => Promise<unknown>
  pressKey: (body: { key: string }) => Promise<unknown>
  scrollUntilVisible: (body: {
    element: { text?: string; id?: string; css?: string }
    direction: string
    centerElement?: boolean
    maxScrolls?: number
  }) => Promise<unknown>
  longPressOn: (body: { id: string }) => Promise<unknown>
}

function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}

async function main(): Promise<void> {
  const artifacts = resolve(required('EVENT_INFO_ARTIFACTS'))
  const load = createRequire(
    join(resolve(required('MAESTRO_D_CLIENT_ROOT')), 'package.json')
  )
  const { MaestroD } = load('maestro-d')
  execFileSync(required('MAESTRO_D_BIN'), ['ps'], { stdio: 'inherit' })
  let failTiles = false
  const external = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/tiles/')) {
      if (failTiles) {
        res.writeHead(503)
        res.end('Synthetic tile outage')
        return
      }
      res.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store'
      })
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=',
          'base64'
        )
      )
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        features:
          url.searchParams.get('q') === 'Unavailable address'
            ? []
            : [{ geometry: { coordinates: [12, 34] } }]
      })
    )
  })
  await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve))
  const address = external.address()
  assert(address != null && typeof address !== 'string')
  const provider = `http://127.0.0.1:${address.port}`
  const oldProvider = process.env.TS_EVENT_GEOCODER_URL
  const oldTiles = process.env.TS_EVENT_MAP_TILES
  process.env.TS_EVENT_GEOCODER_URL = provider + '/api'
  process.env.TS_EVENT_MAP_TILES = provider + '/tiles/{z}/{x}/{y}.png'
  const f = await groupFixture(resolve('dist'))
  const daemonName = process.env.MAESTRO_D ?? 'event-info-browser'
  const profile = join(artifacts, 'support', daemonName + '-chromium-profile')
  mkdirSync(profile, { recursive: true })
  let coverageBrowser: CoverageBrowser | undefined
  const daemon = await MaestroD.connect({
    name: daemonName,
    bin: required('MAESTRO_D_BIN')
  })
  try {
    const gameId = 'gam_event_info'
    await f.h.db
      .insertInto('games')
      .values({
        id: gameId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: null,
        start_at: new Date('2027-04-10T19:00:00Z'),
        end_at: new Date('2027-04-10T21:00:00Z'),
        venue: 'Demo Field',
        address: '1 Demo Way, Demo City',
        latitude: 34,
        longitude: 12
      })
      .execute()
    for (const userId of [103, 104]) {
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          team_id: f.teamA,
          user_id: userId,
          is_player: true
        })
        .execute()
      await f.h.db
        .insertInto('user_links')
        .values({
          id: makeId('userLink'),
          user_id: 101,
          related_user_id: userId,
          kind: 'guardian',
          can_manage: false
        })
        .execute()
    }
    const browserDevice =
      process.env.EVENT_INFO_BROWSER_DEVICE ?? 'event-info-chromium'
    const m: Browser = await daemon.attach({
      device: browserDevice,
      platform: 'web',
      commandTimeout: 30000,
      url: f.h.origin,
      extra: {
        browser: 'chromium',
        windowSize: process.env.EVENT_INFO_VIEWPORT ?? '1280x800',
        userDataDir: profile
      }
    })
    await m.openBrowser({ url: f.h.origin })
    const [debugPort, socketPath] = readFileSync(
      join(profile, 'DevToolsActivePort'),
      'utf8'
    )
      .trim()
      .split('\n')
    // This connection collects coverage only; every UI action uses Maestro D.
    coverageBrowser = await puppeteer.connect({
      defaultViewport: null,
      browserWSEndpoint: `ws://127.0.0.1:${debugPort}${socketPath}`
    })
    const coveragePage = (await coverageBrowser.pages()).find(page =>
      page.url().startsWith(f.h.origin)
    )!
    assert(coveragePage != null)
    const appErrors: string[] = []
    coveragePage.on('pageerror', error => {
      appErrors.push(String(error))
    })
    await coveragePage.coverage.startJSCoverage({
      resetOnNavigation: false,
      reportAnonymousScripts: false,
      includeRawScriptCoverage: true
    })
    await m.setCookies({
      cookies: [
        {
          name: SESSION_COOKIE,
          value: f.h.tokens.get(101)!,
          domain: '127.0.0.1',
          path: '/'
        }
      ]
    })
    const evaluate = async <T>(script: string): Promise<T> => {
      // Return values live in Maestro's session variable as well as the command envelope.
      const result = await m.evalBrowserScript({
        script: `return JSON.stringify(${script})`
      })
      assert(typeof result.data === 'string')
      return JSON.parse(result.data) as T
    }
    const open = async (route: string, id = 'event-info'): Promise<void> => {
      await m.openBrowser({ url: f.h.origin + route })
      await m.assertVisible({ id, timeout: 20000 })
    }
    const shot = async (file: string): Promise<void> => {
      writeFileSync(
        join(artifacts, (process.env.EVENT_INFO_PREFIX ?? '') + file),
        await m.screenshot()
      )
      console.log(`Captured ${file}`)
    }
    await open(`/games/${gameId}`)
    await m.assertVisible({ text: 'Are you going?', timeout: 10000 })
    assert.equal(
      await evaluate(
        `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent`
      ),
      'Info'
    )
    console.log('Upcoming default is Info')
    await m.assertVisible({ id: 'event-location-map', timeout: 10000 })
    await m.evalBrowserScript({
      script: `for(let i=0;i<100;i++){if(document.querySelector('iframe')?.contentWindow?.eventMap)break;await new Promise(r=>setTimeout(r,20))}`
    })
    const mapBefore = await evaluate<{ lat: number; lng: number }>(
      `document.querySelector('iframe').contentWindow.eventMap.getCenter()`
    )
    const mapRect = await evaluate<{
      x: number
      y: number
      width: number
      height: number
    }>(
      `(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`
    )
    await m.dragAndDrop({
      from: {
        point: `${Math.round(mapRect.x + mapRect.width * 0.35)},${Math.round(mapRect.y + mapRect.height / 2 + 30)}`
      },
      to: {
        point: `${Math.round(mapRect.x + mapRect.width * 0.65)},${Math.round(mapRect.y + mapRect.height / 2 + 30)}`
      },
      holdDuration: 100,
      duration: 500
    })
    const mapAfter = await evaluate<{ lat: number; lng: number }>(
      `document.querySelector('iframe').contentWindow.eventMap.getCenter()`
    )
    assert.notEqual(
      mapAfter.lng,
      mapBefore.lng,
      'The SDK map pans under a real drag'
    )
    console.log('Interactive SDK map panning passed')
    await shot('game-after.png')
    failTiles = true
    await m.dragAndDrop({
      from: {
        point: `${Math.round(mapRect.x + mapRect.width * 0.2)},${Math.round(mapRect.y + mapRect.height / 2)}`
      },
      to: {
        point: `${Math.round(mapRect.x + mapRect.width * 0.8)},${Math.round(mapRect.y + mapRect.height / 2)}`
      },
      holdDuration: 100,
      duration: 500
    })
    await m.evalBrowserScript({
      script: `for(let i=0;i<100;i++){if(document.querySelector('iframe').contentDocument.querySelector('#error').style.display==='block')break;await new Promise(r=>setTimeout(r,20))}`
    })
    assert.equal(
      await evaluate(
        `document.querySelector('iframe').contentDocument.querySelector('#error').style.display`
      ),
      'block'
    )
    await shot('map-tiles-retry.png')
    failTiles = false
    const retryPoint = await evaluate<{ x: number; y: number }>(
      `(()=>{const f=document.querySelector('iframe');const a=f.getBoundingClientRect();const b=f.contentDocument.querySelector('#retry-map-tiles').getBoundingClientRect();return{x:a.x+b.x+b.width/2,y:a.y+b.y+b.height/2}})()`
    )
    await m.tapOnPoint({
      x: Math.round(retryPoint.x),
      y: Math.round(retryPoint.y)
    })
    await m.evalBrowserScript({
      script: `for(let i=0;i<100;i++){if(document.querySelector('iframe').contentDocument.querySelector('#error').style.display==='none')break;await new Promise(r=>setTimeout(r,20))}`
    })
    assert.equal(
      await evaluate(
        `document.querySelector('iframe').contentDocument.querySelector('#error').style.display`
      ),
      'none'
    )
    console.log('Failed map tiles recover through the visible retry button')
    await m.scrollUntilVisible({
      element: { id: 'event-rsvp-101-1' },
      direction: 'DOWN',
      centerElement: true,
      maxScrolls: 8
    })
    await m.tapOn({ id: 'event-rsvp-101-1' })
    const rect = await evaluate<{
      x: number
      y: number
      width: number
      height: number
    }>(
      `(()=>{const r=document.querySelector('[data-testid="event-rsvp-101"]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`
    )
    await m.evalBrowserScript({
      script: `window.__rsvpColors=[];const stop=performance.now()+1800;function sample(){window.__rsvpColors.push(getComputedStyle(document.querySelector('[data-testid="event-rsvp-101-fill"]')).backgroundColor);if(performance.now()<stop)requestAnimationFrame(sample)}sample();`
    })
    assert(rect.width > 0)
    await m.dragAndDrop({
      from: { id: 'event-rsvp-101-1' },
      to: { id: 'event-rsvp-101-0' },
      holdDuration: 100,
      duration: 600
    })
    await m.waitForAnimationToEnd()
    const colors = await evaluate<string[]>('window.__rsvpColors')
    assert(
      new Set(colors).size > 2,
      'Dragging blends through intermediate colors'
    )
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-rsvp-101-0"]').getAttribute('aria-checked')`
      ),
      'true'
    )
    console.log('Continuous blue-to-green dragging and snapped Yes passed')
    await m.tapOn({ id: 'event-rsvp-101-1' })
    await m.assertVisible({
      css: '[data-testid="event-rsvp-101-1"]:not([aria-disabled="true"])',
      timeout: 5000
    })
    await m.pressKey({ key: 'LEFT' })
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-rsvp-101-0"]').getAttribute('aria-checked')`
      ),
      'true'
    )
    await m.assertVisible({
      css: '[data-testid="event-rsvp-101-0"]:not([aria-disabled="true"])',
      timeout: 5000
    })
    await m.pressKey({ key: 'RIGHT' })
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-rsvp-101-1"]').getAttribute('aria-checked')`
      ),
      'true'
    )
    await m.assertVisible({
      css: '[data-testid="event-rsvp-101-1"]:not([aria-disabled="true"])',
      timeout: 5000
    })
    await m.pressKey({ key: 'LEFT' })
    console.log('Real browser arrow keys select independent RSVP choices')
    assert.equal(
      await evaluate(
        `(()=>{const p=document.querySelector('[data-testid="event-rsvp-101"]');const row=p.parentElement.parentElement;return p.getBoundingClientRect().top-row.getBoundingClientRect().top<20})()`
      ),
      true,
      'The pill remains on the avatar/name row'
    )
    await m.scrollUntilVisible({
      element: { id: 'event-rsvp-101-1' },
      direction: 'DOWN',
      centerElement: true,
      maxScrolls: 8
    })
    await m.tapOn({ id: 'event-rsvp-103-2' })
    await m.tapOn({ id: 'event-rsvp-104-0' })
    for (const id of [101, 103, 104])
      await m.assertVisible({
        css: `[data-testid="event-rsvp-${id}-0"]:not([aria-disabled="true"])`,
        timeout: 10000
      })
    const saved = await (
      await f.h.request('GET', `/events/${gameId}/info`)
    ).json()
    assert.deepEqual(
      saved.attendees
        .filter((row: { userId: number }) =>
          [101, 103, 104].includes(row.userId)
        )
        .map((row: { response: string }) => row.response)
        .sort(),
      ['no', 'yes', 'yes']
    )
    await open(`/games/${gameId}`)
    await m.scrollUntilVisible({
      element: { id: 'event-rsvp-101-1' },
      direction: 'DOWN',
      centerElement: true,
      maxScrolls: 8
    })
    await m.tapOn({ id: 'event-rsvp-101-1' })
    await m.waitForAnimationToEnd()
    await m.scrollUntilVisible({
      element: { id: 'event-rsvp-101-1' },
      direction: 'DOWN',
      centerElement: true,
      maxScrolls: 8
    })
    await shot('family-rsvps.png')
    await m.scrollUntilVisible({
      element: { id: 'attendance-players-yes' },
      direction: 'DOWN',
      centerElement: true,
      maxScrolls: 8
    })
    await shot('attendance-after.png')
    // Simulate text-only enlargement, where native accessibility scales glyphs
    // without increasing the fixed capsule width. Restore the original styles.
    await m.scrollUntilVisible({
      element: { id: 'event-rsvp-101' },
      direction: 'UP',
      centerElement: true,
      maxScrolls: 8
    })
    await m.evalBrowserScript({
      script: `window.__rsvpFonts=[];for(const label of document.querySelectorAll('[role="radiogroup"] [role="radio"] > div')){window.__rsvpFonts.push([label,label.style.fontSize]);label.style.fontSize=(parseFloat(getComputedStyle(label).fontSize)*2)+'px'}`
    })
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('[role="radiogroup"] [role="radio"]')).every(choice=>{const range=document.createRange();range.selectNodeContents(choice.querySelector('div'));const text=range.getBoundingClientRect(), target=choice.getBoundingClientRect();return text.left>=target.left-1&&text.right<=target.right+1})`
      ),
      true,
      'Enlarged labels stay within their colored choices'
    )
    await shot('rsvp-large-text.png')
    await m.evalBrowserScript({
      script: `for(const [label,font] of window.__rsvpFonts)label.style.fontSize=font;delete window.__rsvpFonts`
    })
    await m.scrollUntilVisible({
      element: { id: 'event-address' },
      direction: 'UP',
      maxScrolls: 8
    })
    await m.longPressOn({ id: 'event-address' })
    await m.assertVisible({ text: 'Address copied', timeout: 10000 })
    console.log('Self/children, persistent Maybe and address copy passed')
    await m.openBrowser({
      url: f.h.origin + `/groups/team/${f.teamA}/create-game`
    })
    await m.assertVisible({ text: 'Other', timeout: 20000 })
    await m.tapOn({ text: 'Other' })
    await m.assertVisible({ text: 'Create Event' })
    await shot('creation-after.png')
    const fill = async (label: string, text: string): Promise<void> => {
      await m.tapOn({ css: `input[aria-label=${JSON.stringify(label)}]` })
      await m.eraseText()
      await m.inputText({ text })
    }
    await fill('Title', 'Team dinner')
    await fill('Venue address (optional)', '1 Demo Way, Demo City')
    await m.scrollUntilVisible({
      element: { text: 'Create event' },
      direction: 'DOWN',
      maxScrolls: 8
    })
    await m.tapOn({ text: 'Create event' })
    await m.assertVisible({ text: 'Are you going?', timeout: 20000 })
    await shot('event-title.png')
    console.log('Title-only event creation passed')
    const events = await f.h.db.selectFrom('team_events').selectAll().execute()
    assert.equal(events.length, 1)
    assert.equal(events[0].title, 'Team dinner')
    const eventId = events[0].id
    await f.h.request('PUT', `/events/${eventId}/info`, {
      address: 'Unavailable address'
    })
    await open(`/games/${eventId}`)
    await m.assertVisible({
      text: 'The address could not be located.*',
      timeout: 10000
    })
    await shot('map-retry.png')
    await f.h.db
      .insertInto('event_geocodes')
      .values({ address: 'unavailable address', latitude: 34, longitude: 12 })
      .execute()
    await m.tapOn({ text: 'Retry map' })
    await m.assertVisible({ id: 'event-location-map', timeout: 10000 })
    console.log('Address-only geocode failure and retry recovery passed')
    await open(`/games/${gameId}`)
    await sql
      .raw(
        `create function fail_event_rsvp_fixture() returns trigger language plpgsql as $$begin if new.user_id=103 then raise exception 'Synthetic RSVP write failure'; end if; return new; end$$;
      create trigger fail_event_rsvp_fixture before insert or update on game_rsvps for each row execute function fail_event_rsvp_fixture();`
      )
      .execute(f.h.db)
    await m.tapOn({ id: 'event-rsvp-103-0' })
    await m.scrollUntilVisible({
      element: { text: 'Something went wrong' },
      direction: 'DOWN',
      centerElement: true,
      maxScrolls: 5
    })
    await m.assertVisible({ text: 'Something went wrong', timeout: 10000 })
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-rsvp-103-2"]').getAttribute('aria-checked')`
      ),
      'true'
    )
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-rsvp-104-0"]').getAttribute('aria-checked')`
      ),
      'true'
    )
    await shot('rsvp-rollback.png')
    await sql
      .raw(
        'drop trigger fail_event_rsvp_fixture on game_rsvps; drop function fail_event_rsvp_fixture();'
      )
      .execute(f.h.db)
    console.log('Failed HTTP write rolled back only its own pill')
    await open(`/games/${eventId}`)
    await m.assertVisible({ text: 'Team dinner' })
    await m.openBrowser({ url: f.h.origin + `/teams/${f.teamA}?tab=schedule` })
    await m.assertVisible({ text: 'Team dinner', timeout: 20000 })
    await shot('schedule-after.png')
    if (process.env.EVENT_INFO_KEEP_SERVER === '1') {
      writeFileSync(
        join(artifacts, 'browser-environment.json'),
        JSON.stringify({ origin: f.h.origin, teamId: f.teamA, gameId, eventId })
      )
      console.log('Retained synthetic server for independent QA')
      await new Promise<void>(resolve => process.once('SIGINT', resolve))
    }
    const selectedTab = async (): Promise<string> =>
      await evaluate(
        `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent`
      )
    await open(`/games/${gameId}`)
    const scoring = await f.h.request('POST', `/games/${gameId}/events`, {
      mode: 'live',
      source: { system: 'manual' },
      plays: [
        {
          about: {
            atBatIndex: 0,
            inning: 1,
            halfInning: 'top',
            isScoringPlay: false
          },
          count: { outs: 1 },
          result: {
            eventType: 'field_out',
            awayScore: 0,
            homeScore: 0,
            description: 'Ground out'
          }
        }
      ]
    })
    assert.equal(scoring.status, 200, await scoring.text())
    await m.evalBrowserScript({
      script: `window.dispatchEvent(new Event('focus'));`
    })
    await m.assertVisible({
      css: '[role="tab"][aria-selected="true"][aria-label="Box score"]',
      timeout: 10000
    })
    assert.equal(await selectedTab(), 'Box score')
    await open(`/games/${gameId}?tab=info`)
    assert.equal(await selectedTab(), 'Info')
    await m.openBrowser({ url: f.h.origin + `/games/${gameId}?tab=watch` })
    await m.assertVisible({ text: 'No videos.', timeout: 10000 })
    await m.openBrowser({ url: f.h.origin + `/games/${gameId}?tab=boxScore` })
    await m.assertVisible({
      css: '[role="tab"][aria-selected="true"][aria-label="Box score"]',
      timeout: 10000
    })
    console.log(
      'First non-run scoring event and explicit Info/Videos/Box Score URLs passed'
    )
    await m.openBrowser({ url: f.h.origin + `/games/${gameId}` })
    await m.assertVisible({
      css: '[role="tab"][aria-selected="true"][aria-label="Box score"]',
      timeout: 10000
    })
    await m.tapOn({ css: '[role="tab"][aria-label="Videos"]' })
    await m.assertVisible({ text: 'No videos.', timeout: 10000 })
    await m.back()
    await m.assertVisible({
      css: '[role="tab"][aria-selected="true"][aria-label="Box score"]',
      timeout: 10000
    })
    console.log('Actual browser Back reapplies the automatic Box Score default')
    await f.h.db
      .updateTable('games')
      .set({ status: 'final', home_score: 0, away_score: 0 })
      .where('id', '=', gameId)
      .execute()
    await m.openBrowser({ url: f.h.origin + `/games/${gameId}` })
    await m.assertVisible({
      css: '[role="tab"][aria-selected="true"][aria-label="Box score"]',
      timeout: 10000
    })
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('[role="tab"]')).filter(n=>['Info','Box score','Videos','Score Game','DJ Game'].includes(n.textContent)).at(-1)?.textContent`
      ),
      'Info'
    )
    await shot('game-ended-after.png')
    await m.openBrowser({ url: f.h.origin + `/games/${eventId}/settings` })
    await m.assertVisible({ text: 'Save event details', timeout: 10000 })
    await fill('Title', 'Team picnic')
    // Time zones are a constrained picker now; its row selection/cancel and
    // retained-draft checks run in gameForm.e2e and EventScheduleFields tests.
    await m.scrollUntilVisible({
      element: { text: 'Cancel event' },
      direction: 'DOWN',
      maxScrolls: 8
    })
    await m.tapOn({ text: 'Cancel event' })
    await m.scrollUntilVisible({
      element: { text: 'Back' },
      direction: 'DOWN',
      maxScrolls: 8
    })
    await m.tapOn({ text: 'Save event details' })
    await m.assertVisible({ text: 'Canceled', timeout: 10000 })
    await m.scrollUntilVisible({
      element: { text: 'Canceled' },
      direction: 'UP',
      centerElement: true,
      maxScrolls: 8
    })
    await shot('event-edit-cancel.png')
    assert.equal(
      (
        await f.h.db
          .selectFrom('team_events')
          .select('title')
          .where('id', '=', eventId)
          .executeTakeFirstOrThrow()
      ).title,
      'Team picnic'
    )
    await f.h.request('PUT', `/events/${eventId}/info`, { address: null })
    await open(`/games/${eventId}`)
    assert.equal(await evaluate(`document.querySelector('iframe')==null`), true)
    assert.equal(await selectedTab(), 'Info')
    console.log(
      'Non-game edit/cancel, Info-only tabs and absent-address omission passed'
    )
    for (const [timezone, startAt, endAt, name] of [
      ['UTC', '2037-04-10T18:00:00Z', '2037-04-11T17:00:00Z', 'overnight'],
      [
        'America/Los_Angeles',
        '2037-04-11T06:00:00Z',
        '2037-04-11T08:00:00Z',
        'local-midnight'
      ],
      [
        'America/Los_Angeles',
        '2037-04-10T23:00:00Z',
        '2037-04-11T01:00:00Z',
        'same-local-day'
      ]
    ] as const) {
      const response = await f.h.request('PUT', `/events/${eventId}/info`, {
        startAt,
        endAt,
        timezone
      })
      assert.equal(response.status, 200)
      await coveragePage.emulateTimezone(timezone)
      await open(`/games/${eventId}`)
      const includesDate = name !== 'same-local-day'
      const endTime = new Intl.DateTimeFormat('en', {
        timeZone: timezone,
        hour: 'numeric',
        minute: '2-digit'
      }).format(new Date(endAt))
      const endDay = includesDate
        ? new Intl.DateTimeFormat('en', {
            timeZone: timezone,
            weekday: 'long',
            month: 'long',
            day: 'numeric'
          }).format(new Date(endAt)) + ', '
        : ''
      await m.assertVisible({ id: 'event-hero-time', timeout: 10000 })
      assert(
        (
          await evaluate<string>(
            `document.querySelector('[data-testid="event-hero-time"]').textContent`
          )
        ).includes(`– ${endDay}${endTime}`)
      )
      await shot(`event-${name}.png`)
    }
    const futureId = 'gam_event_future_end'
    await f.h.db
      .insertInto('games')
      .values({
        id: futureId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: null,
        start_at: new Date('2037-07-02T02:00:00Z'),
        timezone: 'America/Los_Angeles'
      })
      .execute()
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: 'role_future_end_editor',
        scope_type: 'team',
        scope_id: f.teamB,
        user_id: 101,
        role: 'admin'
      })
      .execute()
    await m.openBrowser({ url: f.h.origin + `/games/${futureId}/settings` })
    await m.assertVisible({ text: 'Game Settings', timeout: 10000 })
    await m.scrollUntilVisible({
      element: { text: 'Set end time' },
      direction: 'DOWN',
      maxScrolls: 8
    })
    await m.tapOn({ text: 'Set end time' })
    assert.equal(
      await evaluate(
        `document.querySelector('[data-testid="event-schedule-date"]').getAttribute('aria-label')`
      ),
      'Date: 2037-07-01'
    )
    await shot('future-game-end-date.png')
    await m.scrollUntilVisible({
      element: { text: 'Save' },
      direction: 'DOWN',
      maxScrolls: 8
    })
    await m.tapOn({ text: 'Save' })
    await coveragePage.waitForFunction(
      () => !location.pathname.endsWith('/settings')
    )
    const savedEnd = await f.h.db
      .selectFrom('games')
      .select('end_at')
      .where('id', '=', futureId)
      .executeTakeFirstOrThrow()
    assert.equal(savedEnd.end_at?.toISOString(), '2037-07-02T05:00:00.000Z')
    console.log(
      'Overnight/local-timezone Info dates and future-game end addition passed'
    )
    const endingId = 'gam_event_boundary'
    await f.h.db
      .insertInto('games')
      .values({
        id: endingId,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: null,
        start_at: new Date(Date.now() - 60000),
        end_at: new Date(Date.now() + 3500)
      })
      .execute()
    await open(`/games/${endingId}`)
    assert.equal(await selectedTab(), 'Info')
    await m.assertVisible({
      css: '[role="tab"][aria-selected="true"][aria-label="Box score"]',
      timeout: 10000
    })
    assert.equal(
      await evaluate(
        `Array.from(document.querySelectorAll('[role="tab"]')).filter(n=>['Info','Box score','Videos','Score Game','DJ Game'].includes(n.textContent)).at(-1)?.textContent`
      ),
      'Info'
    )
    console.log('Scheduled end boundary switches and reorders without reload')
    const requireCoverage = createRequire(join(process.cwd(), 'package.json'))
    const convert = requireCoverage('v8-to-istanbul')
    const map = requireCoverage('istanbul-lib-coverage').createCoverageMap({})
    for (const script of await coveragePage.coverage.stopJSCoverage()) {
      if (
        !script.url.startsWith(f.h.origin + '/app-') ||
        script.rawScriptCoverage == null
      )
        continue
      const generated = resolve('dist', basename(new URL(script.url).pathname))
      const converter = convert(generated, 0, {
        source: script.text,
        sourceMap: {
          sourcemap: JSON.parse(readFileSync(generated + '.map', 'utf8'))
        }
      })
      await converter.load()
      converter.applyCoverage(script.rawScriptCoverage.functions)
      map.merge(converter.toIstanbul())
    }
    mkdirSync('coverage/eventInfo', { recursive: true })
    writeFileSync(
      'coverage/eventInfo/browser.json',
      JSON.stringify(map.toJSON())
    )
    assert.deepEqual(appErrors, [], 'No app JavaScript errors')
    console.log(
      'Chromium Maestro D event slice passed; V8 browser coverage captured'
    )
  } finally {
    await coverageBrowser?.disconnect()
    await daemon
      .detach(process.env.EVENT_INFO_BROWSER_DEVICE ?? 'event-info-chromium')
      .catch((error: unknown) => {
        console.error('Browser detach:', error)
      })
    daemon.close()
    await f.h.close()
    await new Promise<void>(resolve =>
      external.close(() => {
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
