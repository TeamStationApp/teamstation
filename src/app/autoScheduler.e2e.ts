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
  FIELD_ONE_HOURS,
  G1,
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

const SCENARIOS: Record<string, (run: Run) => Promise<void>> = {
  E0: e0,
  E1: e1,
  E2: e2,
  E3: e3
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
