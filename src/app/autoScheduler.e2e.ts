// The Season Auto-Scheduler's end-to-end scenarios, E0 to E10, against the
// web app in a maestro-d web device (headless Chromium at a phone's size).
//
//   socket npm run build.web
//   TS_MAESTRO_D_CLIENT=$HOME/git/maestro-d/npm/maestro-d \
//   MAESTRO_D_BIN=$HOME/.maestro-d/bin/maestro-d \
//   TS_AUTO_SCHEDULER_ARTIFACTS=<artifacts directory> \
//   MAESTRO_D=seasonAutoScheduler \
//     node -r sucrase/register src/app/autoScheduler.e2e.ts --only E0
//
// E0 runs on origin/master too: it opens only screens that exist there.
import { execFileSync } from 'node:child_process'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { googlePlaces } from '../server/location/googlePlaces'
import {
  api,
  type AutoSchedulerFixture,
  autoSchedulerFixture,
  bookSecondGame,
  EXHIBITION,
  FIELD_ONE_HOURS,
  G1,
  SEASON_A_WINDOWS,
  seedThrough
} from '../test/autoSchedulerFixture'
import { googlePlacesStub } from '../test/googlePlacesStub'
import {
  absent,
  type BrowserSession,
  browserSession,
  capture,
  contains,
  fill,
  log,
  maestro,
  show,
  tap
} from '../test/refinementsMaestro.e2e'
import { recordBrowserCoverage } from './browserCoverage.e2e'

const WIDTH = 402
const HEIGHT = 874

interface Run {
  fx: AutoSchedulerFixture
  artifacts: string
  support: string
  /** What the scenarios so far made: the venue and its first field. */
  state: { venueId?: string; fieldId?: string }
  session: (device: string, user: number) => Promise<BrowserSession>
  visit: (b: BrowserSession, path: string) => Promise<void>
  pass: (id: string, description: string) => Promise<void>
}

const EMAILS: Record<number, string> = {
  101: 'alex@example.com',
  102: 'casey@example.com'
}

/** Game Settings scrolled to its venue fields, once the form has loaded. */
async function venueInView(b: BrowserSession): Promise<void> {
  await b.page.waitForFunction(
    () => {
      const venue = document.querySelector<HTMLInputElement>(
        'input[aria-label="Venue name (optional)"]'
      )
      return venue !== null && venue.value !== ''
    },
    { timeout: 15000 }
  )
  await b.page.evaluate(() => {
    const venue = document.querySelector(
      'input[aria-label="Venue name (optional)"]'
    )
    if (venue !== null) venue.scrollIntoView({ block: 'center' })
  })
  await new Promise(resolve => setTimeout(resolve, 500))
}

/** The before screenshots, on the screens the feature changes. */
async function e0(run: Run): Promise<void> {
  const { fx, artifacts } = run
  const admin = await run.session('autoScheduler-e0', 101)
  await run.visit(admin, `/groups/league/${fx.f.leagueA}`)
  await contains(admin.page, 'Demo League A')
  await contains(admin.page, 'Demo Regular')
  await capture(admin.m, artifacts, 'league-page-before.png')
  await run.visit(admin, `/games/${G1}?tab=info`)
  await contains(admin.page, 'Demo Park')
  await capture(admin.m, artifacts, 'game-info-venue-before.png')
  await run.visit(admin, `/games/${G1}/settings`)
  await contains(admin.page, 'Swap home and away')
  await venueInView(admin)
  await capture(admin.m, artifacts, 'game-settings-venue-before.png')
  await run.visit(admin, `/groups/season/${fx.f.seasonA}?tab=teams`)
  await admin.m.scrollUntilVisible({
    element: { text: 'Demo Otters' },
    centerElement: true,
    timeout: 15000
  })
  await capture(admin.m, artifacts, 'season-teams-before.png')
  await run.pass(
    'E0',
    'before screenshots of the league page, G1 Info and Settings, and the season Teams tab'
  )
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const NEAR = { latitude: 40.0, longitude: -75.2 }

/** Lets the page read a position for "nearby". */
async function allowLocation(run: Run, b: BrowserSession): Promise<void> {
  await b.browser
    .defaultBrowserContext()
    .overridePermissions(run.fx.f.h.origin, ['geolocation'])
  await b.page.setGeolocation(NEAR)
}

/** Waits for the address bar to read a path. */
async function at(b: BrowserSession, path: RegExp): Promise<string> {
  await b.page.waitForFunction(
    (source: string) => new RegExp(source).test(location.pathname),
    { timeout: 15000 },
    path.source
  )
  return await b.page.evaluate(() => location.pathname)
}

/** Clicks an element by its accessible label, through maestro-d. */
async function tapLabel(b: BrowserSession, label: string): Promise<void> {
  trace(`tap label ${label}`)
  await b.m.tapOn({ css: `[aria-label="${label}"]`, timeout: 15000 })
}

/**
 * Clicks the last button with exactly this text: the one in the sheet that
 * slid up over the row or header action of the same name.
 */
async function tapLast(b: BrowserSession, text: string): Promise<void> {
  trace(`tap last ${text}`)
  await b.page.waitForFunction(
    (wanted: string) =>
      [...document.querySelectorAll('[role="button"]')].some(
        node => node.textContent === wanted
      ),
    { timeout: 15000 },
    text
  )
  await b.page.evaluate((wanted: string) => {
    const matches = [...document.querySelectorAll('[role="button"]')].filter(
      node => node.textContent === wanted
    )
    ;(matches[matches.length - 1] as HTMLElement).click()
  }, text)
}

/** Scrolls the element whose own text is this to the middle of the screen. */
async function showText(b: BrowserSession, text: string): Promise<void> {
  await b.page.evaluate((wanted: string) => {
    const found = [...document.querySelectorAll('div, span')].find(
      node => node.childElementCount === 0 && node.textContent === wanted
    )
    if (found !== undefined) found.scrollIntoView({ block: 'center' })
  }, text)
  await new Promise(resolve => setTimeout(resolve, 500))
}

/** One line per step when TS_AUTO_SCHEDULER_TRACE is set, to find a stall. */
function trace(step: string): void {
  if (process.env.TS_AUTO_SCHEDULER_TRACE === '1')
    console.log(`  · ${new Date().toISOString().slice(11, 19)} ${step}`)
}

/**
 * E1: the league admin finds Example Park at Google, claims it, and the
 * claim counts once seven days pass; League B's claimed venue is listed
 * nearby throughout.
 */
async function e1(run: Run): Promise<void> {
  const { fx, artifacts } = run
  // League B already owns Harbor Field, so the list has a claimed venue.
  const harbor = await api<{ id: string; claims: Array<{ id: string }> }>(
    fx,
    102,
    'POST',
    '/venues',
    { placeId: 'harbor-field', leagueId: fx.f.leagueB }
  )
  await api(
    fx,
    105,
    'POST',
    `/venues/${harbor.id}/claims/${harbor.claims[0].id}/decisions`,
    { decision: 'approve' }
  )
  const admin = await run.session('autoScheduler-e1', 101)
  await allowLocation(run, admin)
  await run.visit(admin, `/groups/league/${fx.f.leagueA}`)
  await contains(admin.page, 'Auto-Scheduler')
  await capture(admin.m, artifacts, 'league-page-after.png')
  await admin.m.tapOn({ text: 'Auto-Scheduler', timeout: 15000 })
  await at(admin, /\/scheduler$/)
  await admin.m.tapOn({ text: 'Field Manager', timeout: 15000 })
  await at(admin, /\/scheduler\/fields$/)
  await contains(admin.page, 'Claimed venues nearby')
  await contains(admin.page, 'Harbor Field')
  await fill(admin.m, 'Search venues', 'Example Park')
  await contains(admin.page, 'Unclaimed venues')
  await capture(admin.m, artifacts, 'field-manager-search.png')
  await tapLabel(admin, 'Open Example Park')
  await at(admin, /^\/venues\/place\/example-park$/)
  await contains(admin.page, 'Claim this venue')
  await admin.m.tapOn({ text: 'Claim', role: 'button', timeout: 15000 })
  const path = await at(admin, /^\/venues\/ven_/)
  run.state.venueId = path.split('/')[2]
  await contains(admin.page, 'Claim pending')
  await contains(admin.page, 'approved automatically on')
  await capture(admin.m, artifacts, 'venue-claim-pending.png')
  const inbox = await api<{
    hasPending: boolean
    items: Array<{ type: string; venueId?: string }>
  }>(fx, 105, 'GET', '/me/notifications')
  expect(inbox.hasPending).equals(true)
  expect(
    inbox.items.some(
      item => item.type === 'venueClaim' && item.venueId === run.state.venueId
    )
  ).equals(true)
  fx.f.advance(WEEK_MS)
  await run.visit(admin, `/venues/${run.state.venueId}`)
  await contains(admin.page, 'Demo League A')
  await absent(admin.page, 'Claim pending')
  await run.visit(admin, `/groups/league/${fx.f.leagueA}/scheduler/fields`)
  await contains(admin.page, 'Your leagues’ venues')
  await contains(admin.page, 'Claimed venues nearby')
  await capture(admin.m, artifacts, 'field-manager-list.png')
  await run.pass(
    'E1',
    'Example Park found at Google, claimed for Demo League A, site administrator told, approved after 7 days; Harbor Field listed as claimed nearby'
  )
}

/** A 16:9 photo of a green field with a white diamond, for uploads. */
async function fieldPhoto(run: Run): Promise<string> {
  const file = join(run.support, 'field-photo.png')
  execFileSync(process.env.TS_FFMPEG ?? 'ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x3f7f2f:s=1280x720',
    '-vf',
    'drawbox=x=540:y=260:w=200:h=200:color=white@0.9:t=8,drawbox=x=0:y=600:w=1280:h=120:color=0x9b6b3f:t=fill',
    '-frames:v',
    '1',
    file
  ])
  return file
}

/** Uploads a photo through the page's file picker. */
async function uploadPhoto(
  b: BrowserSession,
  label: string,
  file: string
): Promise<void> {
  const [chooser] = await Promise.all([
    b.page.waitForFileChooser({ timeout: 15000 }),
    b.m.tapOn({ text: label, role: 'button', timeout: 15000 })
  ])
  await chooser.accept([file])
}

/**
 * E2: the owner sets the venue up: two fields, Field 1's pin, hours,
 * a blackout, its dates and photos; Field 2 deleted after a cancelled try.
 */
async function e2(run: Run): Promise<void> {
  const { fx, artifacts } = run
  const venueId = run.state.venueId!
  const photo = await fieldPhoto(run)
  const admin = await run.session('autoScheduler-e2', 101)
  await run.visit(admin, `/venues/${venueId}`)
  await contains(admin.page, 'No fields yet')
  for (const [name, sizes] of [
    ['Field 1', ['T-ball 46/60', '50/70']],
    ['Field 2', ['50/70', '55/80']]
  ] as const) {
    await tapLabel(admin, 'Add field')
    await fill(admin.m, 'Field name', name)
    for (const size of sizes) await tapLabel(admin, size)
    await tapLast(admin, 'Add field')
    await contains(admin.page, `${name} added.`)
  }
  await uploadPhoto(admin, 'Add photo', photo)
  await contains(admin.page, 'Photo saved.')
  await capture(admin.m, artifacts, 'venue-screen-owner.png')
  await tapLabel(admin, 'Delete Field 2')
  await admin.m.tapOn({ text: 'Cancel', timeout: 15000 })
  await contains(admin.page, 'Field 2')
  await tapLabel(admin, 'Delete Field 2')
  await tapLast(admin, 'Delete')
  await admin.page.waitForFunction(
    () => document.querySelector('[aria-label="Open Field 2"]') == null,
    { timeout: 15000 }
  )
  await tapLabel(admin, 'Open Field 1')
  const fieldPath = await at(admin, /\/fields\/fld_/)
  run.state.fieldId = fieldPath.split('/')[4]
  await uploadPhoto(admin, 'Add photo', photo)
  await contains(admin.page, 'Photo saved.')
  // Drag the pin: Leaflet's marker, moved and let go inside its frame.
  const frame = admin.page
    .frames()
    .find(candidate => candidate.url() === 'about:srcdoc')
  expect(frame, 'the pin map frame').not.equals(undefined)
  await frame!.waitForFunction(() => (window as any).pinMarker != null)
  await frame!.evaluate(() => {
    const marker = (window as any).pinMarker
    marker.setLatLng([40.0213, -75.2214])
    marker.fire('dragend')
  })
  await contains(admin.page, 'Pin saved.')
  await admin.page.evaluate(() => {
    window.scrollTo(0, 0)
  })
  await capture(admin.m, artifacts, 'field-screen-photo-pin.png')
  // Its own hours: Saturday 8:00 AM to 6:00 PM, through the pickers.
  await admin.m.tapOn({ text: 'Its own hours', timeout: 15000 })
  await contains(admin.page, 'This field now keeps its own hours.')
  await tapLabel(admin, 'Field hours: Saturday, Closed')
  await admin.m.tapOn({ text: 'Open', timeout: 15000 })
  await tapLabel(admin, 'Opens 5:00 PM')
  await tapLabel(admin, 'Hour 08')
  await tapLabel(admin, 'Period AM')
  await admin.m.tapOn({ text: 'Use time', timeout: 15000 })
  await tapLabel(admin, 'Closes 9:00 PM')
  await tapLabel(admin, 'Hour 06')
  await admin.m.tapOn({ text: 'Use time', timeout: 15000 })
  await admin.m.tapOn({ text: 'Done', timeout: 15000 })
  await contains(admin.page, '8:00 AM – 6:00 PM')
  // The weekday evenings are set the same way; the API saves the time.
  await api(fx, 101, 'PUT', `/venues/${venueId}/fields/${run.state.fieldId}`, {
    hours: FIELD_ONE_HOURS
  })
  await run.visit(admin, `/venues/${venueId}/fields/${run.state.fieldId}`)
  await contains(admin.page, '5:00 PM – 9:00 PM')
  // The year's dates, October to September.
  await tapLabel(admin, 'Dates: Open all year')
  for (let month = 0; month < 24; month++) {
    const shown = await admin.page.evaluate(
      () => document.querySelector('[aria-label="2026-10-01"]') != null
    )
    if (shown) break
    await tapLabel(admin, 'Next month')
  }
  await tapLabel(admin, '2026-10-01')
  for (let month = 0; month < 12; month++) {
    const shown = await admin.page.evaluate(
      () => document.querySelector('[aria-label="2027-09-30"]') != null
    )
    if (shown) break
    await tapLabel(admin, 'Next month')
  }
  await tapLabel(admin, '2027-09-30')
  await admin.m.tapOn({ text: 'Use this range', timeout: 15000 })
  await contains(admin.page, 'Oct 1, 2026 – Sep 30, 2027')
  await admin.m.tapOn({ text: 'Add blackout day', timeout: 15000 })
  await admin.page.type('input[aria-label="Year"]', '')
  await admin.page.evaluate(() => {
    const year = document.querySelector<HTMLInputElement>(
      'input[aria-label="Year"]'
    )
    if (year !== null) year.select()
  })
  await admin.page.keyboard.type('2027')
  await admin.m.tapOn({ css: '[aria-label^="Choose month:"]', timeout: 15000 })
  await admin.m.tapOn({ text: 'Apr', timeout: 15000 })
  await tapLabel(admin, 'Choose 2027-04-17')
  await admin.m.tapOn({ text: 'Use date', timeout: 15000 })
  await contains(admin.page, 'Saturday, April 17, 2027')
  await capture(admin.m, artifacts, 'field-screen-availability.png')
  const field = await fx.f.h.db
    .selectFrom('venue_fields')
    .selectAll()
    .where('id', '=', run.state.fieldId)
    .executeTakeFirstOrThrow()
  expect([field.pin_latitude, field.pin_longitude]).deep.equals([
    40.0213, -75.2214
  ])
  expect(field.photo_path).not.equals(null)
  // The pin is where it was dropped after a reload.
  await run.visit(admin, `/venues/${venueId}/fields/${run.state.fieldId}`)
  await contains(admin.page, 'Saturday, April 17, 2027')
  // Last on this screen: maestro-d's taps stall once the page is scrolled
  // this way, so nothing is tapped after it.
  await showText(admin, 'FIELD SIZES')
  await capture(admin.m, artifacts, 'field-screen-sizes.png')
  const deleted = await fx.f.h.db
    .selectFrom('venue_fields')
    .select('deleted_at')
    .where('name', '=', 'Field 2')
    .executeTakeFirstOrThrow()
  expect(deleted.deleted_at).not.equals(null)
  await run.pass(
    'E2',
    'two fields added; Field 1 pin dragged and kept, own hours, dates, a blackout and photos; Field 2 deleted only after confirming'
  )
}

/**
 * E3: League B asks to co-own; Demo League A declines; it asks again and the
 * site administrator approves; both leave or are removed, and the venue is
 * unclaimed with its fields until League A claims it again.
 */
async function e3(run: Run): Promise<void> {
  const { fx, artifacts } = run
  const venueId = run.state.venueId!
  const neighbour = await run.session('autoScheduler-e3b', 102)
  await run.visit(neighbour, `/venues/${venueId}`)
  await neighbour.m.tapOn({
    text: 'Request to co-own',
    role: 'button',
    timeout: 15000
  })
  await contains(neighbour.page, 'Your request to co-own this venue was sent.')
  const admin = await run.session('autoScheduler-e3', 101)
  await run.visit(admin, `/venues/${venueId}`)
  await contains(admin.page, 'Request to co-own ·')
  await capture(admin.m, artifacts, 'venue-requests.png')
  await tapLabel(admin, 'Decline Demo League B')
  await contains(admin.page, 'Demo League B: declined.')
  const declined = await api<{ items: Array<{ type: string; title: string }> }>(
    fx,
    102,
    'GET',
    '/me/notifications'
  )
  expect(declined.items.map(item => item.title)).includes(
    'Example Park: request declined'
  )
  await run.visit(neighbour, `/venues/${venueId}`)
  await neighbour.m.tapOn({
    text: 'Request to co-own',
    role: 'button',
    timeout: 15000
  })
  await contains(neighbour.page, 'Your request to co-own this venue was sent.')
  const site = await run.session('autoScheduler-e3s', 105)
  await run.visit(site, `/venues/${venueId}`)
  await tapLabel(site, 'Approve Demo League B')
  await contains(site.page, 'Demo League B: approved.')
  await run.visit(admin, `/venues/${venueId}`)
  await tapLabel(admin, 'Leave Demo League A')
  await tapLast(admin, 'Leave')
  await admin.page.waitForFunction(
    () => document.querySelector('[aria-label="Leave Demo League A"]') == null,
    { timeout: 15000 }
  )
  await run.visit(site, `/venues/${venueId}`)
  await tapLabel(site, 'Remove Demo League B')
  await tapLast(site, 'Remove')
  await contains(site.page, 'Unclaimed')
  await contains(site.page, 'Field 1')
  // League A claims it again, and owns it a week later with the same fields.
  await run.visit(admin, `/venues/${venueId}`)
  await admin.m.tapOn({ text: 'Claim', role: 'button', timeout: 15000 })
  await contains(admin.page, 'Claim pending')
  fx.f.advance(WEEK_MS)
  await run.visit(admin, `/venues/${venueId}`)
  await contains(admin.page, 'Demo League A')
  await contains(admin.page, 'Field 1')
  await absent(admin.page, 'Claim pending')
  await run.pass(
    'E3',
    'co-owner request declined, asked again and approved by the site administrator; leaving and removal leave the venue unclaimed with its fields; reclaimed'
  )
}

/**
 * E4: G1 is put on Field 1 through Game Settings; a second game right after
 * it in the other size collides with the size switch, and both games warn
 * under their address and tell both teams' staff.
 */
async function e4(run: Run): Promise<void> {
  const { fx, artifacts } = run
  const venueId = run.state.venueId!
  await api(fx, 101, 'PUT', `/venues/${venueId}`, { sizeSwitchMinutes: 30 })
  const admin = await run.session('autoScheduler-e4', 101)
  await run.visit(admin, `/games/${G1}/settings`)
  await contains(admin.page, 'Swap home and away')
  await tapLabel(admin, 'Field: none chosen')
  await contains(admin.page, 'Choose field')
  await admin.m.tapOn({ text: 'Example Park', timeout: 15000 })
  await admin.m.tapOn({ text: 'Field 1', timeout: 15000 })
  await tapLabel(admin, 'Use 50/70')
  await admin.page.waitForFunction(
    () =>
      document.querySelector(
        '[aria-label="Field: Example Park, Field 1, 50/70"]'
      ) != null,
    { timeout: 15000 }
  )
  await venueInView(admin)
  await capture(admin.m, artifacts, 'game-settings-venue-after.png')
  await tapLast(admin, 'Save')
  await admin.page.waitForFunction(
    (game: string) => location.pathname === `/games/${game}`,
    { timeout: 15000 },
    G1
  )
  const g1 = await fx.f.h.db
    .selectFrom('games')
    .select(['field_id', 'field_size', 'venue', 'address'])
    .where('id', '=', G1)
    .executeTakeFirstOrThrow()
  expect(g1).include({
    field_id: run.state.fieldId,
    field_size: '50/70',
    venue: 'Example Park',
    address: '1 Example Way, Demo City'
  })
  const second = await bookSecondGame(fx, run.state.fieldId!)
  await run.visit(admin, `/games/${G1}?tab=info`)
  await contains(admin.page, 'too close to this one to change the field’s size')
  await admin.page.evaluate(() => {
    const warning = document.querySelector(
      '[data-testid="event-field-warnings"]'
    )
    if (warning !== null) warning.scrollIntoView({ block: 'center' })
  })
  await capture(admin.m, artifacts, 'game-info-venue-after.png')
  expect(
    await admin.page.evaluate(() => {
      const row = document.querySelector('[data-testid="event-directions"]')
      return row === null ? '' : String(row.getAttribute('aria-label'))
    })
  ).equals('Open directions')
  await run.visit(admin, `/games/${second}?tab=info`)
  await contains(admin.page, 'too close to this one to change the field’s size')
  await run.visit(admin, '/notifications')
  await contains(admin.page, 'Field warning: Demo Hawks at Demo Owls')
  await showText(admin, 'Field warning: Demo Hawks at Demo Owls')
  await capture(admin.m, artifacts, 'notifications-field-warning.png')
  const owls = await api<{ items: Array<{ type: string; gameId?: string }> }>(
    fx,
    101,
    'GET',
    '/me/notifications'
  )
  expect(
    owls.items
      .filter(item => item.type === 'fieldWarning')
      .map(i => i.gameId ?? '')
      .sort((a, b) => a.localeCompare(b))
  ).deep.equals([G1, second].sort((a, b) => a.localeCompare(b)))
  await run.pass(
    'E4',
    'G1 linked to Field 1 in Game Settings, venue and address filled and locked; a second game across the 30-minute size switch warns on both games and in both teams’ staff inboxes'
  )
}

/**
 * E5: Field 1's Saturday closes at 11:00, so G1 warns that the field is not
 * open for it, while a completed game on the field warns of nothing.
 */
async function e5(run: Run): Promise<void> {
  const { fx, artifacts } = run
  const venueId = run.state.venueId!
  const fieldId = run.state.fieldId!
  await fx.f.h.db
    .insertInto('games')
    .values({
      id: 'gam_autoSchedulerDone',
      home_team_id: fx.teams.Foxes,
      away_team_id: fx.teams.Rockets,
      season_id: fx.f.seasonA,
      start_at: new Date('2026-10-10T14:00:00.000Z'),
      end_at: new Date('2026-10-10T16:00:00.000Z'),
      timezone: 'America/New_York',
      venue: 'Example Park',
      address: '1 Example Way, Demo City',
      latitude: 40.02,
      longitude: -75.22,
      field_id: fieldId,
      field_size: '50/70',
      status: 'final'
    })
    .execute()
  const admin = await run.session('autoScheduler-e5', 101)
  await run.visit(admin, `/venues/${venueId}/fields/${fieldId}`)
  await tapLabel(admin, 'Field hours: Saturday, 8:00 AM – 6:00 PM')
  await tapLabel(admin, 'Closes 6:00 PM')
  await tapLabel(admin, 'Hour 11')
  await tapLabel(admin, 'Period AM')
  await admin.m.tapOn({ text: 'Use time', timeout: 15000 })
  await admin.m.tapOn({ text: 'Done', timeout: 15000 })
  await contains(admin.page, '8:00 AM – 11:00 AM')
  await run.visit(admin, `/games/${G1}?tab=info`)
  await contains(admin.page, 'is not open for all of this game')
  await admin.page.evaluate(() => {
    const warning = document.querySelector(
      '[data-testid="event-field-warnings"]'
    )
    if (warning !== null) warning.scrollIntoView({ block: 'center' })
  })
  await capture(admin.m, artifacts, 'game-info-availability-warning.png')
  await run.visit(admin, '/games/gam_autoSchedulerDone?tab=info')
  await contains(admin.page, 'Example Park')
  await absent(admin.page, 'is not open for all of this game')
  await admin.page.evaluate(() => {
    const card = document.querySelector('[data-testid="event-location"]')
    if (card !== null) card.scrollIntoView({ block: 'center' })
  })
  await capture(admin.m, artifacts, 'game-info-completed-no-warning.png')
  // Restored, as the next scenarios expect.
  await api(fx, 101, 'PUT', `/venues/${venueId}/fields/${fieldId}`, {
    hours: FIELD_ONE_HOURS
  })
  await run.pass(
    'E5',
    'Saturday hours cut to 11:00: the upcoming G1 warns that Field 1 is not open for it; the completed game on the field warns of nothing'
  )
}

/** Clicks the last element of this role and exact text, once enabled. */
async function tapText(
  b: BrowserSession,
  text: string,
  roles = '[role="button"], [role="radio"], [role="tab"]'
): Promise<void> {
  trace(`tap text ${text}`)
  await b.page.waitForFunction(
    (wanted: string, selector: string) =>
      [...document.querySelectorAll(selector)].some(
        node =>
          node.textContent === wanted &&
          node.getAttribute('aria-disabled') !== 'true'
      ),
    { timeout: 15000 },
    text,
    roles
  )
  await b.page.evaluate(
    (wanted: string, selector: string) => {
      const matches = [...document.querySelectorAll(selector)].filter(
        node => node.textContent === wanted
      )
      ;(matches[matches.length - 1] as HTMLElement).click()
    },
    text,
    roles
  )
}

/** Picks a wall time, "HH:MM", in the open time picker. */
async function pickTime(b: BrowserSession, time: string): Promise<void> {
  const hour = Number(time.slice(0, 2))
  await tapLabel(
    b,
    `Hour ${String(hour % 12 === 0 ? 12 : hour % 12).padStart(2, '0')}`
  )
  await tapLabel(b, `Minute ${time.slice(3)}`)
  await tapLabel(b, `Period ${hour < 12 ? 'AM' : 'PM'}`)
  await tapText(b, 'Use time')
}

/** Opens a day of a weekly-hours list and sets it open from start to end. */
async function setDay(
  b: BrowserSession,
  list: string,
  day: string,
  start: string,
  end: string
): Promise<void> {
  trace(`${list}: ${day} ${start}–${end}`)
  await b.m.tapOn({ css: `[aria-label^="${list}: ${day}, "]`, timeout: 15000 })
  await contains(b.page, 'Done')
  const closed = await b.page.evaluate(
    () => document.querySelector('[aria-label^="Opens "]') === null
  )
  if (closed) await tapText(b, 'Open')
  await b.m.tapOn({ css: '[aria-label^="Opens "]', timeout: 15000 })
  await pickTime(b, start)
  await b.m.tapOn({ css: '[aria-label^="Closes "]', timeout: 15000 })
  await pickTime(b, end)
  await tapText(b, 'Done')
  await b.page.waitForFunction(
    (selector: string) => document.querySelector(selector) === null,
    { timeout: 15000 },
    '[aria-label^="Opens "]'
  )
}

/** Sets a number in the grid's editor for one cell. */
async function setNumber(
  b: BrowserSession,
  cell: string,
  label: string,
  value: string
): Promise<void> {
  await tapLabel(b, cell)
  await fill(b.m, label, value)
  await tapText(b, 'Save')
  await b.page.waitForFunction(
    (wanted: string) =>
      document.querySelector(`input[aria-label="${wanted}"]`) === null,
    { timeout: 15000 },
    label
  )
}

/**
 * Scrolls the element whose own text is this to the top of the screen,
 * below the app's header, and lets the scroll settle.
 */
async function scrollToText(
  b: BrowserSession,
  text: string,
  block: 'start' | 'center'
): Promise<void> {
  await b.page.evaluate(
    (wanted: string, where: 'start' | 'center') => {
      const found = [...document.querySelectorAll('div, span')].find(
        node => node.childElementCount === 0 && node.textContent === wanted
      )
      if (found === undefined) return
      found.scrollIntoView({ block: where })
      if (where === 'start') {
        let scroller = found.parentElement
        while (
          scroller !== null &&
          scroller.scrollHeight <= scroller.clientHeight
        )
          scroller = scroller.parentElement
        if (scroller !== null) scroller.scrollTop -= 72
        else window.scrollBy(0, -72)
      }
    },
    text,
    block
  )
  await new Promise(resolve => setTimeout(resolve, 500))
}

/** Waits for text to leave the page, as a save lands. */
async function gone(b: BrowserSession, text: string): Promise<void> {
  await b.page.waitForFunction(
    (wanted: string) => !String(document.body.textContent).includes(wanted),
    { timeout: 15000 },
    text
  )
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

/** Whether the Build schedule button can be pressed. */
async function buildEnabled(b: BrowserSession): Promise<boolean> {
  return await b.page.evaluate(() => {
    const button = [...document.querySelectorAll('[role="button"]')].find(
      node => node.textContent === 'Build schedule'
    )
    return (
      button !== undefined && button.getAttribute('aria-disabled') !== 'true'
    )
  })
}

/**
 * E6: the league admin chooses seasonA and seasonC, sets their numbers in
 * the grid, flags seasonA's two exhibition teams, gives it windows with a
 * June 1 period, chooses Field 1, and reads the early warnings change.
 */
async function e6(run: Run): Promise<void> {
  const { fx, artifacts } = run
  const scheduler = `/groups/league/${fx.f.leagueA}/scheduler`
  const admin = await run.session('autoScheduler-e6', 101)
  await run.visit(admin, scheduler)
  await contains(admin.page, 'FIELDS FOR THIS RUN')
  await tapLabel(admin, 'Demo Regular')
  await contains(admin.page, 'SCHEDULE SETTINGS')
  await tapLabel(admin, 'Demo Playoffs')
  await tapLabel(admin, 'Demo Playoffs Size: 60/90')
  await tapLabel(admin, '55/80')
  await tapLabel(admin, 'Demo Playoffs Size: 55/80')
  await tapText(admin, 'Cancel')
  await tapLabel(admin, 'Field 1, Example Park')
  await tapLabel(admin, 'Demo Regular Size: 60/90')
  await tapLabel(admin, '50/70')
  await setNumber(
    admin,
    'Demo Regular Game: 120 min',
    'Game length, in minutes',
    '90'
  )
  await setNumber(
    admin,
    'Demo Regular Between: 15 min',
    'Time between games, in minutes',
    '10'
  )
  await setNumber(
    admin,
    'Demo Regular Regular: 0',
    'Regular-season games per team',
    '3'
  )
  await setNumber(
    admin,
    'Demo Regular Exhibition: 0',
    'Exhibition games per team',
    '1'
  )
  await tapLabel(admin, 'Demo Regular Doubleheaders: Only if necessary')
  await tapLabel(admin, 'Only if necessary')
  // The season's detail: exhibition teams and windows.
  await tapLabel(admin, 'Open Demo Regular')
  await at(admin, /\/scheduler\/seasons\//)
  await contains(admin.page, 'Check the teams that play only exhibition games')
  for (const name of EXHIBITION) {
    await tapLabel(admin, `Demo ${name}`)
    await contains(admin.page, `Demo ${name} saved.`)
  }
  await tapText(admin, 'Add game windows')
  const march = 'Windows from Monday, March 1, 2027'
  await contains(admin.page, 'From Monday, March 1, 2027')
  for (const day of WEEKDAY_NAMES)
    await setDay(admin, march, day, '17:30', '21:00')
  await setDay(admin, march, 'Saturday', '08:00', '18:00')
  await tapText(admin, 'Add a period from a date')
  await chooseDate(admin, '2027-06-01')
  const june = 'Windows from Tuesday, June 1, 2027'
  await contains(admin.page, 'From Tuesday, June 1, 2027')
  for (const day of WEEKDAY_NAMES)
    await setDay(admin, june, day, '18:00', '21:00')
  // The last day's save may still be on its way.
  const read = async (): Promise<Record<string, unknown>> =>
    await fx.f.h.db
      .selectFrom('season_schedule_settings')
      .selectAll()
      .where('season_id', '=', fx.f.seasonA)
      .executeTakeFirstOrThrow()
  let saved = await read()
  for (
    let tries = 0;
    tries < 50 &&
    JSON.stringify(saved.windows) !== JSON.stringify(SEASON_A_WINDOWS);
    tries++
  ) {
    await new Promise(resolve => setTimeout(resolve, 200))
    saved = await read()
  }
  expect(saved).include({
    field_size: '50/70',
    game_minutes: 90,
    buffer_minutes: 10,
    regular_games: 3,
    exhibition_games: 1,
    doubleheaders: 'ifNecessary'
  })
  expect(saved.windows).deep.equals(SEASON_A_WINDOWS)
  // Back to the grid: the warnings, live.
  await run.visit(admin, scheduler)
  await contains(admin.page, 'EARLY WARNINGS')
  await contains(
    admin.page,
    '7 teams × 3 games is 21 team games, an odd number'
  )
  await contains(admin.page, '4 for one, 3 for the other')
  await contains(
    admin.page,
    'Must fix: Demo Playoffs has no chosen field that sets up as 55/80.'
  )
  expect(await buildEnabled(admin)).equals(false)
  await setNumber(
    admin,
    'Demo Regular Regular: 3',
    'Regular-season games per team',
    '4'
  )
  await gone(admin, 'an odd number')
  await contains(admin.page, '4 for one, 3 for the other')
  expect(await buildEnabled(admin)).equals(false)
  // Back to the grid's first columns, which the cell taps scrolled past.
  await admin.page.evaluate(() => {
    const grid = document.querySelector('[data-testid="season-schedule-grid"]')
    if (grid !== null)
      for (const node of [grid, ...grid.querySelectorAll('div')])
        node.scrollLeft = 0
  })
  await scrollToText(admin, 'SCHEDULE SETTINGS', 'start')
  await capture(admin.m, artifacts, 'scheduler-grid.png')
  await tapLabel(admin, 'Demo Playoffs')
  await gone(admin, 'Demo Playoffs has no chosen field')
  await admin.page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Demo Regular Total games: 21"]') !==
      null,
    { timeout: 15000 }
  )
  expect(await buildEnabled(admin)).equals(true)
  const setup = await fx.f.h.db
    .selectFrom('league_schedule_setups')
    .select(['season_ids', 'field_ids'])
    .where('league_id', '=', fx.f.leagueA)
    .executeTakeFirstOrThrow()
  expect(setup).deep.equals({
    season_ids: [fx.f.seasonA],
    field_ids: [run.state.fieldId]
  })
  // seasonA's Teams tab lists the flagged teams as exhibition teams.
  await run.visit(admin, `/groups/season/${fx.f.seasonA}?tab=teams`)
  await contains(admin.page, 'EXHIBITION TEAMS')
  const exhibitionHeading = await admin.page.evaluate(() => {
    const text = String(document.body.textContent)
    return text.slice(text.indexOf('EXHIBITION TEAMS'))
  })
  for (const name of EXHIBITION)
    expect(exhibitionHeading).includes(`Demo ${name}`)
  await scrollToText(admin, 'EXHIBITION TEAMS', 'start')
  await capture(admin.m, artifacts, 'season-teams-after.png')
  await run.pass(
    'E6',
    'seasonA and seasonC chosen; seasonA set to 50/70, 90 minutes, 10 between, 3 then 4 regular and 1 exhibition, with two window periods and two exhibition teams; the odd-total warning clears at 4, the 4/3 exhibition split stays, Build schedule is disabled until seasonC is removed; the flagged teams list under Exhibition Teams'
  )
}

/** Chooses a date in the open calendar picker. */
async function chooseDate(b: BrowserSession, date: string): Promise<void> {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ]
  await b.m.tapOn({ css: '[aria-label^="Choose month:"]', timeout: 15000 })
  await tapLabel(b, months[Number(date.slice(5, 7)) - 1])
  await tapLabel(b, `Choose ${date}`)
  await tapText(b, 'Use date')
}

const SCENARIOS: Record<string, (run: Run) => Promise<void>> = {
  E0: e0,
  E1: e1,
  E2: e2,
  E3: e3,
  E4: e4,
  E5: e5,
  E6: e6
}

async function main(): Promise<void> {
  const artifacts = process.env.TS_AUTO_SCHEDULER_ARTIFACTS
  if (artifacts == null) throw new Error('Supply TS_AUTO_SCHEDULER_ARTIFACTS')
  const only = process.argv.includes('--only')
    ? process.argv[process.argv.indexOf('--only') + 1]
    : undefined
  if (only != null && SCENARIOS[only] == null)
    throw new Error(`No scenario ${only}`)
  // Browser profiles and the served copy of the app are working files, kept
  // out of the artifacts directory.
  const support = resolve('coverage/autoScheduler/support')
  const web = join(support, 'web')
  await mkdir(artifacts, { recursive: true })
  await mkdir(web, { recursive: true })
  await cp(resolve('dist'), web, { recursive: true })
  const places = await googlePlacesStub()
  const fx = await autoSchedulerFixture(web, {
    cityLookup: googlePlaces({
      apiKey: 'placeholder-key',
      baseUrl: places.baseUrl
    })
  })
  const daemon = await maestro(process.env.MAESTRO_D ?? 'seasonAutoScheduler')
  const sessions: BrowserSession[] = []
  const lines = 'scenarios.log'
  await writeFile(
    join(artifacts, lines),
    `$ node -r sucrase/register src/app/autoScheduler.e2e.ts${only == null ? '' : ` --only ${only}`}\n`
  )
  const visit = async (b: BrowserSession, path: string): Promise<void> => {
    await b.m.openBrowser({ url: fx.f.h.origin + path })
  }
  const run: Run = {
    fx,
    artifacts,
    support,
    state: only == null ? {} : await seedThrough(fx, only),
    visit,
    pass: async (id, description) => {
      await log(artifacts, lines, `${id} PASS: ${description}`)
    },
    session: async (device, user) => {
      const b = await browserSession(daemon, device, WIDTH, HEIGHT, support)
      sessions.push(b)
      const email = EMAILS[user] ?? `fixture${user}@example.com`
      await visit(b, '/sign-in')
      await fill(b.m, 'E-mail address', email)
      await tap(b.m, 'Send me a sign-in code')
      await show(b.m, '.*six-digit code is on its way.*')
      await fill(b.m, 'Sign-in code', fx.f.h.mail.get(email)!)
      await tap(b.m, 'Sign in')
      // The bottom bar's Search shows before the sign-in answer lands; wait
      // for Home, which needs the session cookie the answer sets.
      await b.page.waitForFunction(() => location.pathname !== '/sign-in', {
        timeout: 15000
      })
      await contains(b.page, 'Your Home')
      return b
    }
  }
  try {
    for (const [id, scenario] of Object.entries(SCENARIOS))
      if (only == null || only === id) await scenario(run)
    const coverage = process.env.TS_AUTO_SCHEDULER_BROWSER_COVERAGE
    if (coverage != null)
      await recordBrowserCoverage(
        sessions.map(session => session.page),
        fx.f.h.origin,
        resolve(coverage),
        web
      )
  } finally {
    for (const s of sessions) {
      await s.browser.disconnect()
      await s.m.detach()
    }
    await daemon.shutdown()
    await fx.f.h.close()
    await places.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
