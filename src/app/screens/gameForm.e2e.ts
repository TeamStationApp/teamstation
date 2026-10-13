import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { sql } from 'kysely'
import puppeteer, {
  type Browser as CoverageBrowser,
  type Page
} from 'puppeteer'

import { makeId } from '../../common/ids'
import {
  demoLocality,
  type GroupFixture,
  groupFixture
} from '../../test/groupFixtures'

/**
 * Create Game and Game Settings, end to end: the suggestions API, then the
 * shared game scene in Chromium through maestro-d.
 *
 * `GAME_FORM_MODE`:
 * - `before`: the screenshots of the scenes this work replaces, run on the
 *   base branch;
 * - `schedule`: the team schedule with a practice, an Other event and a
 *   game, run on the base branch;
 * - `api`: the suggestions API only, with no browser;
 * - `all` (the default): the API, then every scene in Chromium.
 */
type Mode = 'before' | 'schedule' | 'api' | 'all'

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
  tapOnPoint: (body: { x: number; y: number }) => Promise<unknown>
  tapOn: (body: { id?: string; text?: string }) => Promise<unknown>
  inputText: (body: { text: string; css?: string }) => Promise<unknown>
  eraseText: () => Promise<unknown>
  assertVisible: (body: {
    text?: string
    id?: string
    css?: string
    timeout?: number
  }) => Promise<unknown>
  evalBrowserScript: (body: { script: string }) => Promise<{ data?: unknown }>
  screenshot: () => Promise<Buffer>
}

interface Daemon {
  attach: (body: {
    device: string
    platform: 'web'
    commandTimeout: number
    url: string
    extra: { browser: 'chromium'; windowSize: string; userDataDir: string }
  }) => Promise<Browser>
  detach: (device: string) => Promise<unknown>
  close: () => void
}

const run = promisify(execFile)

function required(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}

/** The calendar date this many months before `now`. */
function monthsBefore(now: Date, months: number): Date {
  const date = new Date(now)
  date.setUTCMonth(date.getUTCMonth() - months)
  return date
}

const farLocality = {
  city: 'Far City',
  region: 'Far Region',
  country: 'US',
  placeId: null,
  timezone: 'UTC'
}

interface Seeded {
  sameSeason: string
  recentOpponent: string
  staleOpponent: string
  sameRegion: string
  gameId: string
}

async function seed(f: GroupFixture): Promise<Seeded> {
  let key = 0
  const create = async (
    name: string,
    userId: number,
    locality: typeof demoLocality,
    parent?: { kind: 'season'; id: string }
  ): Promise<string> => {
    const result = await f.h.request(
      'POST',
      '/teams',
      {
        name,
        idempotencyKey: `game-form-${++key}`,
        locality,
        parent
      },
      userId
    )
    assert.equal(result.status, 201, await result.clone().text())
    return ((await result.json()) as { id: string }).id
  }
  const sameSeason = await create('Demo Owls', 101, demoLocality, {
    kind: 'season',
    id: f.seasonA
  })
  // A coach the suggestion rows name.
  await f.h.db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      scope_type: 'team',
      scope_id: sameSeason,
      user_id: 104,
      role: 'coach',
      granted_by: 101,
      granted_at: new Date()
    })
    .execute()
  const recentOpponent = await create('Demo Falcons', 103, farLocality)
  const staleOpponent = await create('Demo Ravens', 103, farLocality)
  const sameRegion = await create('Demo Herons', 106, demoLocality)
  const now = f.clock.now()
  for (const [id, opponent, months] of [
    ['gam_form_recent', recentOpponent, 5],
    ['gam_form_stale', staleOpponent, 7]
  ] as const) {
    const startAt = monthsBefore(now, months)
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: f.teamA,
        away_team_id: opponent,
        season_id: null,
        start_at: startAt,
        end_at: new Date(startAt.getTime() + 2 * 3600_000),
        venue: 'Demo Field',
        status: 'final',
        home_score: 3,
        away_score: 2
      })
      .execute()
  }
  const gameId = 'gam_form_settings'
  await f.h.db
    .insertInto('games')
    .values({
      id: gameId,
      home_team_id: f.teamA,
      away_team_id: f.teamB,
      season_id: null,
      start_at: new Date('2026-11-14T19:00:00Z'),
      end_at: new Date('2026-11-14T21:00:00Z'),
      venue: 'Riverside Park',
      exhibition: true
    })
    .execute()
  // A season's game, which can be marked exhibition; off the Hawks schedule.
  await f.h.db
    .insertInto('games')
    .values({
      id: 'gam_form_season',
      home_team_id: sameSeason,
      away_team_id: f.teamB,
      season_id: f.seasonA,
      start_at: new Date('2026-11-21T19:00:00Z'),
      end_at: new Date('2026-11-21T21:00:00Z'),
      venue: 'Riverside Park',
      exhibition: true
    })
    .execute()
  // The signed-in Hawks admin also keeps the Eagles, so a change between
  // the two needs no second approval.
  await f.h.db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      scope_type: 'team',
      scope_id: f.teamB,
      user_id: 101,
      role: 'admin',
      granted_by: 102,
      granted_at: new Date()
    })
    .execute()
  // A practice and an Other event beside the game on the Hawks schedule.
  for (const [id, type, title, startAt] of [
    ['tev_form_practice', 'practice', 'Morning drills', '2027-01-09T17:00:00Z'],
    ['tev_form_dinner', 'other', 'Team dinner', '2027-01-12T02:00:00Z']
  ] as const)
    await f.h.db
      .insertInto('team_events')
      .values({
        id,
        team_id: f.teamA,
        event_type: type,
        title,
        start_at: new Date(startAt),
        timezone: 'America/Los_Angeles'
      })
      .execute()
  return { sameSeason, recentOpponent, staleOpponent, sameRegion, gameId }
}

/** The Hawks schedule, with its practice, Other event and game. */
async function scheduleShot(
  f: GroupFixture,
  m: Browser,
  artifacts: string,
  file: string
): Promise<void> {
  await m.openBrowser({
    url: `${f.h.origin}/teams/${encodeURIComponent(f.teamA)}?tab=schedule`
  })
  await m.assertVisible({ text: 'Team dinner', timeout: 20000 })
  await m.evalBrowserScript({
    script: `const node=Array.from(document.querySelectorAll('div')).find(node=>node.childElementCount===0&&node.textContent==='Team dinner');node.scrollIntoView({block:'center'})`
  })
  await new Promise(resolve => setTimeout(resolve, 600))
  writeFileSync(join(artifacts, file), await m.screenshot())
  console.log(`Captured ${file}`)
}

/** E1: the suggestions API, each call a real `curl` with its answer. */
async function suggestionsApi(
  f: GroupFixture,
  seeded: Seeded,
  artifacts: string
): Promise<void> {
  const log = join(artifacts, 'team-suggestions-api.log')
  writeFileSync(log, '')
  // The server runs in this process, so curl must not block it.
  const curl = async (
    path: string
  ): Promise<{ status: number; body: string }> => {
    const url = `${f.h.origin}/api/v1${path}`
    const { stdout } = await run('curl', ['-s', '-w', '\\n%{http_code}', url])
    const at = stdout.lastIndexOf('\n')
    const body = stdout.slice(0, at)
    const status = Number(stdout.slice(at + 1))
    appendFileSync(
      log,
      `$ curl -s '${url}'\n${status} ${JSON.stringify(JSON.parse(body), null, 2)}\n\n`
    )
    return { status, body }
  }
  const suggested = await curl(
    `/teams?view=public&relatedTeam=${encodeURIComponent(f.teamA)}`
  )
  assert.equal(suggested.status, 200)
  const rows = JSON.parse(suggested.body) as Array<{
    id: string
    name: string
    seasonNames?: string[]
    staffNames?: string[]
  }>
  const ids = rows.map(row => row.id)
  assert(!ids.includes(f.teamA), 'The anchor team is not its own suggestion')
  assert(ids.includes(seeded.sameSeason), 'Same-season team suggested')
  assert(ids.includes(seeded.recentOpponent), 'Five-month opponent suggested')
  assert(!ids.includes(seeded.staleOpponent), 'Seven-month opponent absent')
  assert(ids.includes(seeded.sameRegion), 'Same-region team suggested')
  assert(
    ids.indexOf(seeded.sameSeason) < ids.indexOf(seeded.recentOpponent) &&
      ids.indexOf(seeded.recentOpponent) < ids.indexOf(seeded.sameRegion),
    'Tiers: season, then opponents, then region'
  )
  const owls = rows.find(row => row.id === seeded.sameSeason)!
  assert.deepEqual(owls.seasonNames, ['Demo Regular'])
  assert(owls.staffNames?.includes('Ichiro') === true, 'The coach is named')
  const searched = await curl('/teams?view=public&query=Owls')
  assert.equal(searched.status, 200)
  assert.deepEqual(
    (JSON.parse(searched.body) as Array<{ seasonNames?: string[] }>)[0]
      .seasonNames,
    ['Demo Regular']
  )
  const refused = await curl(
    `/teams?view=public&relatedTeam=${encodeURIComponent(f.teamA)}&query=ea`
  )
  assert.equal(refused.status, 400)
  console.log('E1 suggestions API PASS')
}

/** A stand-in for the venue geocoder, so no test leaves this machine. */
async function fakeGeocoder(): Promise<{ url: string; close: () => void }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ features: [] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address != null && typeof address !== 'string')
  return {
    url: `http://127.0.0.1:${address.port}/api`,
    close: () => server.close()
  }
}

interface Scene {
  f: GroupFixture
  seeded: Seeded
  m: Browser
  page: Page
  artifacts: string
}

/** E2–E14: the shared game scene, its team selector and its placeholders. */
async function scenes({ f, seeded, m, page, artifacts }: Scene): Promise<void> {
  const savedLog = join(artifacts, 'placeholder-save.log')
  writeFileSync(savedLog, '')
  const evaluate = async <T>(script: string): Promise<T> => {
    const result = await m.evalBrowserScript({
      script: `return JSON.stringify(${script})`
    })
    assert(typeof result.data === 'string')
    return JSON.parse(result.data) as T
  }
  const wait = async (expression: string): Promise<void> => {
    await m.evalBrowserScript({
      script: `for(let i=0;i<250;i++){if(${expression})return true;await new Promise(r=>setTimeout(r,20))}throw new Error(${JSON.stringify('UI condition did not settle: ' + expression)})`
    })
  }
  const shot = async (file: string): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 500))
    writeFileSync(join(artifacts, file), await m.screenshot())
    console.log(`Captured ${file}`)
  }
  /** The button whose label is this, or this title and then its subtitle. */
  const button = (label: string): string =>
    `Array.from(document.querySelectorAll('[role="button"],[role="radio"]')).find(node=>{const name=node.getAttribute('aria-label')??node.textContent;return name===${JSON.stringify(label)}||name.startsWith(${JSON.stringify(label + ', ')})})`
  const exists = async (label: string): Promise<boolean> =>
    await evaluate<boolean>(`${button(label)}!=null`)
  const tap = async (label: string): Promise<void> => {
    await wait(
      `(()=>{const node=${button(label)};return node!=null&&node.getAttribute('aria-disabled')!=='true'})()`
    )
    // A sheet sliding in or out moves its rows: tap only once the target is
    // uncovered and has stopped moving.
    let point = { x: 0, y: 0, clear: false }
    let settled = false
    for (
      let attempt = 0;
      attempt < 40 && !(point.clear && settled);
      attempt++
    ) {
      const at = await evaluate<{ x: number; y: number; clear: boolean }>(
        `(()=>{const node=${button(label)};node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);return{x,y,clear:hit===node||node.contains(hit)}})()`
      )
      settled = at.x === point.x && at.y === point.y
      point = at
      await new Promise(resolve => setTimeout(resolve, 120))
    }
    assert(point.clear, `${label} must be unobstructed`)
    await m.tapOnPoint({ x: point.x, y: point.y })
  }
  const fill = async (label: string, text: string): Promise<void> => {
    const css = `[aria-label=${JSON.stringify(label)}]`
    await wait(`document.querySelector(${JSON.stringify(css)})!=null`)
    await m.evalBrowserScript({
      script: `const input=document.querySelector(${JSON.stringify(css)});input.scrollIntoView({block:'center'});input.focus();input.select()`
    })
    await m.eraseText()
    await m.inputText({ text, css })
    await wait(
      `document.querySelector(${JSON.stringify(css)}).value===${JSON.stringify(text)}`
    )
  }
  /** The scene's own scroller to its top, not only the window. */
  const toTop = async (): Promise<void> => {
    await m.evalBrowserScript({
      script: `window.scrollTo(0,0);for(const node of document.querySelectorAll('div'))if(node.scrollTop>0)node.scrollTop=0`
    })
    await wait(
      `Array.from(document.querySelectorAll('div')).every(node=>node.scrollTop===0)`
    )
  }
  const see = async (text: string): Promise<void> => {
    await wait(`document.body.textContent.includes(${JSON.stringify(text)})`)
  }
  const open = async (route: string, title: string): Promise<void> => {
    await m.openBrowser({ url: f.h.origin + route })
    await wait(
      `Array.from(document.querySelectorAll('[role="heading"],[aria-level]')).some(node=>node.textContent===${JSON.stringify(title)})`
    )
  }
  const chooseDate = async (value: string): Promise<void> => {
    await m.tapOn({ id: 'event-schedule-date' })
    await fill('Year', value.slice(0, 4))
    await tap(`Choose month: ${monthName(value)}`).catch(async () => {
      await m.evalBrowserScript({
        script: `document.querySelector('[aria-label^="Choose month:"]').click()`
      })
    })
    await tap(monthName(value))
    await tap(`Choose ${value}`)
    await tap('Use date')
  }
  const chooseTime = async (hour: number, minute: number): Promise<void> => {
    await m.tapOn({ id: 'event-schedule-time' })
    for (const [column, option] of [
      ['hour', hour % 12 === 0 ? 12 : hour % 12],
      ['minute', minute],
      ['period', hour < 12 ? 0 : 1]
    ] as const) {
      const index =
        column === 'hour'
          ? option - 1
          : column === 'minute'
            ? option / 5
            : option
      await m.evalBrowserScript({
        script: `document.querySelector('[data-testid="event-time-${column}-wheel"]').scrollTo({top:${index * 44},behavior:'instant'})`
      })
      await m.assertVisible({
        id: `event-time-${column}-${option}`,
        timeout: 5000
      })
      await m.tapOn({ id: `event-time-${column}-${option}` })
    }
    await tap('Use time')
  }
  const placeholders = async (): Promise<
    Array<{ id: string; locality: unknown; custodian_id: string | null }>
  > => {
    const query = `select id, locality, custodian_id from teams where name = 'Riverside Owls' and kind = 'external'`
    const rows = (
      await sql<{
        id: string
        locality: unknown
        custodian_id: string | null
      }>`select id, locality, custodian_id from teams where name = 'Riverside Owls' and kind = 'external'`.execute(
        f.h.db
      )
    ).rows
    appendFileSync(
      savedLog,
      `$ psql "$TS_TEST_DATABASE" -c "${query}"\n${JSON.stringify(rows, null, 2)}\n\n`
    )
    return rows
  }
  page.on('response', response => {
    if (!response.url().includes('/api/v1/game-requests')) return
    const request = response.request()
    if (request.method() !== 'POST') return
    ;(async () => {
      const body = await response.text().catch(() => '<unavailable>')
      const posted = await request.fetchPostData().catch(() => undefined)
      appendFileSync(
        savedLog,
        `$ browser POST ${new URL(response.url()).pathname}\n${posted ?? ''}\n${response.status()} ${body}\n\n`
      )
    })().catch(() => undefined)
  })
  const team = encodeURIComponent(f.teamA)
  const createRoute = `/groups/team/${team}/create-game`

  // E15, first half: the seeded schedule, before any scene changes it, so
  // it matches the base branch's capture.
  await scheduleShot(f, m, artifacts, 'schedule-events-after.png')

  // E2: the shared scene, created from a team.
  await open(createRoute, 'Create Game')
  assert.equal(
    await exists('Demo Hawks, Home'),
    false,
    'Hawks is not choosable'
  )
  await see('Demo Hawks')
  assert(await exists('Choose Away Team'), 'The opponent is to choose')
  // A team page's game is a scrimmage or exhibition: a note, no switch.
  assert.equal(
    await evaluate<boolean>(
      `document.querySelector('input[aria-label="Exhibition"]')==null`
    ),
    true
  )
  await see('always creates a scrimmage/exhibition game')
  assert.equal(
    await evaluate<string>(`${button('Save')}.getAttribute('aria-disabled')`),
    'true'
  )
  // The note sits just above Save.
  await m.evalBrowserScript({
    script: `${button('Save')}.scrollIntoView({block:'center'})`
  })
  await shot('team-game-note.png')
  await toTop()
  await shot('create-game-after.png')
  const now = new Date()
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 14)
  )
  const day = next.toISOString().slice(0, 10)
  await chooseDate(day)
  await fill('Venue name (optional)', 'North Field')
  console.log('E2 PASS')

  // E3: the title moves into the header as the scene scrolls.
  await m.evalBrowserScript({
    script: `window.scrollTo(0,600);for(const node of document.querySelectorAll('div'))if(node.scrollHeight>node.clientHeight+20&&['auto','scroll'].includes(getComputedStyle(node).overflowY))node.scrollTop=600`
  })
  await wait(
    `Array.from(document.querySelectorAll('div')).some(node=>{if(node.textContent!=='Create Game'||node.getAttribute('aria-level')!=null)return false;const r=node.getBoundingClientRect();if(r.top>70||r.bottom<0)return false;let opacity=1;for(let n=node;n;n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);return opacity>0.9})`
  )
  await shot('create-game-scrolled.png')
  console.log('E3 PASS')

  // E4: the selector slides up with suggestions.
  await tap('Choose Away Team')
  await wait(`document.querySelector('[data-testid="team-selector"]')!=null`)
  await see('Suggested')
  await wait(
    `document.querySelector('[data-testid="team-result-${seeded.sameSeason}"]')!=null`
  )
  const order = await evaluate<string[]>(
    `Array.from(document.querySelectorAll('[data-testid^="team-result-"]')).map(node=>node.getAttribute('data-testid').slice(12))`
  )
  assert.equal(order[0], seeded.sameSeason, 'Same-season team first')
  assert(!order.includes(f.teamA), 'Hawks is not offered against itself')
  assert(
    (
      await evaluate<string>(
        `document.querySelector('[data-testid="team-staff-${seeded.sameSeason}"]').textContent`
      )
    ).includes('Ichiro')
  )
  const labels = await evaluate<string[]>(
    `Array.from(document.querySelectorAll('[data-testid="team-selector"] [role="button"]')).map(node=>node.getAttribute('aria-label')??node.textContent)`
  )
  assert(labels.at(-1)?.startsWith('Create Placeholder Team') === true)
  await shot('team-picker-after.png')
  console.log('E4 PASS')

  // E5: closing keeps the draft.
  await tap('Cancel team selector')
  await wait(`document.querySelector('[data-testid="team-selector"]')==null`)
  assert(await exists('Choose Away Team'))
  assert.equal(
    await evaluate<string>(
      `document.querySelector('[aria-label="Venue name (optional)"]').value`
    ),
    'North Field'
  )
  assert(
    (
      await evaluate<string>(
        `document.querySelector('[data-testid="event-schedule-date"]').textContent`
      )
    ).includes(day)
  )
  console.log('E5 PASS')

  // E6: search every team.
  await tap('Choose Away Team')
  await fill('Search all teams', 'Eagles')
  await tap('Choose Demo Eagles')
  await wait(`document.querySelector('[data-testid="team-selector"]')==null`)
  assert(await exists('Demo Eagles, Away'))
  console.log('E6 PASS')

  // E7: a swap moves the source team; it is never replaceable.
  await tap('Swap home and away')
  assert(await exists('Demo Eagles, Home'))
  assert.equal(await exists('Demo Hawks, Away'), false)
  await toTop()
  await shot('source-team-swapped.png')
  await tap('Demo Eagles, Home')
  await see('Suggested')
  assert.equal(await exists('Choose Demo Hawks'), false)
  console.log('E7 PASS')

  // E8: a placeholder is staged, not created.
  await tap('Create Placeholder Team')
  await see('Kept by Demo Hawks')
  await fill('Team name', 'Riverside Owls')
  await tap('Continue')
  await fill('Search city and state', 'Spring')
  await wait(
    `Array.from(document.querySelectorAll('[role="button"]')).some(node=>(node.getAttribute('aria-label')??'').startsWith('Choose Spring'))`
  )
  await shot('placeholder-form.png')
  const city = await evaluate<string>(
    `Array.from(document.querySelectorAll('[role="button"]')).map(node=>node.getAttribute('aria-label')??'').find(name=>name.startsWith('Choose Spring'))`
  )
  await tap(city)
  await tap('Continue')
  await tap('Skip')
  await wait(`document.querySelector('[data-testid="team-selector"]')==null`)
  assert(await exists('Riverside Owls, Home · Placeholder'))
  assert.equal((await placeholders()).length, 0)
  await toTop()
  await shot('placeholder-staged.png')
  console.log('E8 PASS')

  // E9: Cancel creates nothing.
  await tap('Cancel')
  await wait(`!location.pathname.endsWith('/create-game')`)
  assert.equal((await placeholders()).length, 0)
  console.log('E9 PASS')

  // E10: Save creates one placeholder, with no location, then the game.
  await open(createRoute, 'Create Game')
  await tap('Choose Away Team')
  await tap('Create Placeholder Team')
  await fill('Team name', 'Riverside Owls')
  await tap('Continue')
  await tap('Skip')
  await tap('Skip')
  await wait(`document.querySelector('[data-testid="team-selector"]')==null`)
  await tap('Save')
  await wait(`location.pathname.startsWith('/notifications/')`)
  const requestId = await evaluate<string>(
    `location.pathname.split('/').at(-1)`
  )
  const made = await placeholders()
  assert.equal(made.length, 1)
  assert.equal(made[0].locality, null)
  assert.equal(made[0].custodian_id, f.teamA)
  const request = await f.h.db
    .selectFrom('group_requests')
    .select(['initiating_team_id', 'status'])
    .where('id', '=', requestId)
    .executeTakeFirstOrThrow()
  appendFileSync(
    savedLog,
    `$ psql "$TS_TEST_DATABASE" -c "select initiating_team_id, status from group_requests where id = '${requestId}'"\n${JSON.stringify(request)}\n\n`
  )
  assert.equal(request.initiating_team_id, f.teamA)
  await see(
    request.status === 'accepted' ? 'Game scheduled' : 'Game proposal sent'
  )
  console.log(`E10 PASS (${request.status})`)

  // E11: a season's game, either side choosable and swappable.
  await open(
    `/groups/season/${encodeURIComponent(f.seasonA)}/create-game`,
    'Create Game'
  )
  assert(await exists('Choose Home Team'))
  assert(await exists('Choose Away Team'))
  // A season's game counts for its standings unless marked exhibition.
  assert.equal(
    await evaluate<boolean>(
      `document.querySelector('input[aria-label="Exhibition"]').checked`
    ),
    false
  )
  assert.equal(
    await evaluate<boolean>(
      `document.body.textContent.includes('always creates a scrimmage/exhibition game')`
    ),
    false
  )
  await tap('Choose Home Team')
  await see('Suggested')
  await tap('Choose Demo Hawks')
  await tap('Choose Away Team')
  await tap('Choose Demo Owls')
  await tap('Swap home and away')
  await tap('Demo Hawks, Away')
  await fill('Search all teams', 'Eagles')
  await tap('Choose Demo Eagles')
  await wait(`document.querySelector('[data-testid="team-selector"]')==null`)
  await wait(`${button('Demo Eagles, Away')}!=null`)
  assert(await exists('Demo Owls, Home'))
  await toTop()
  await shot('season-create-game.png')
  console.log('E11 PASS')

  // E12: Game Settings with the saved values; a change saves. A game in no
  // season has no Exhibition switch and no note; a season's game keeps its
  // switch, set as saved.
  await open('/games/gam_form_season/settings', 'Game Settings')
  assert.equal(
    await evaluate<boolean>(
      `document.querySelector('input[aria-label="Exhibition"]').checked`
    ),
    true
  )
  await m.evalBrowserScript({
    script: `document.querySelector('input[aria-label="Exhibition"]').scrollIntoView({block:'center'})`
  })
  await shot('game-settings-season.png')
  const settings = `/games/${encodeURIComponent(seeded.gameId)}/settings`
  await open(settings, 'Game Settings')
  assert.equal(
    await evaluate<boolean>(
      `document.querySelector('input[aria-label="Exhibition"]')==null&&!document.body.textContent.includes('always creates a scrimmage/exhibition game')`
    ),
    true
  )
  assert.equal(
    await evaluate<string>(
      `document.querySelector('[aria-label="Venue name (optional)"]').value`
    ),
    'Riverside Park'
  )
  assert(await exists('Demo Hawks, Home'))
  assert(await exists('Demo Eagles, Away'))
  await toTop()
  await shot('game-settings-after.png')
  // From 11 AM to noon; the saved 1 PM end stays after it.
  await chooseTime(12, 0)
  await tap('Save')
  await see('Game changes saved')
  const changed = await f.h.db
    .selectFrom('games')
    .select('start_at')
    .where('id', '=', seeded.gameId)
    .executeTakeFirstOrThrow()
  assert.equal(
    new Date(changed.start_at).toISOString(),
    '2026-11-14T20:00:00.000Z'
  )
  console.log('E12 PASS')

  // E13: withdrawal labels fit a narrow phone, at full height.
  await page.setViewport({ width: 320, height: 874 })
  await open(settings, 'Game Settings')
  for (const name of ['Demo Hawks', 'Demo Eagles']) {
    const fit = await evaluate<{
      height: number
      lines: number
      clipped: boolean
    }>(
      `(()=>{const node=${button(`Withdraw ${name}`)};const label=Array.from(node.querySelectorAll('div')).find(n=>n.textContent===${JSON.stringify(`Withdraw ${name}`)});const style=getComputedStyle(label);return{height:node.getBoundingClientRect().height,lines:Math.round(label.getBoundingClientRect().height/parseFloat(style.lineHeight||style.fontSize)),clipped:label.scrollWidth>label.clientWidth+1}})()`
    )
    assert(fit.height >= 48, `Withdraw ${name} is at least 48 high`)
    assert(!fit.clipped && fit.lines <= 1, `Withdraw ${name} fits one line`)
  }
  await tap('Withdraw Demo Hawks')
  await m.evalBrowserScript({
    script: `${button('Keep game')}.scrollIntoView({block:'center'})`
  })
  await shot('withdraw-narrow.png')
  await tap('Keep game')
  assert.equal(
    (
      await f.h.db
        .selectFrom('games')
        .select('status')
        .where('id', '=', seeded.gameId)
        .executeTakeFirstOrThrow()
    ).status,
    'scheduled'
  )
  await tap('Withdraw Demo Hawks')
  await tap('Confirm withdrawal')
  await wait(`!location.pathname.endsWith('/settings')`)
  const withdrawn = await f.h.db
    .selectFrom('games')
    .select(['status', 'cancellation_reason'])
    .where('id', '=', seeded.gameId)
    .executeTakeFirstOrThrow()
  assert.deepEqual(withdrawn, {
    status: 'cancelled',
    cancellation_reason: 'withdrawal'
  })
  await page.setViewport({ width: 402, height: 874 })
  console.log('E13 PASS')

  // E14: Practice keeps the event branch's form, under the scene's title,
  // and needs no title of its own.
  await open(createRoute, 'Create Game')
  await tap('Practice')
  await wait(
    `Array.from(document.querySelectorAll('[role="heading"],[aria-level]')).some(node=>node.textContent==='Create Practice')`
  )
  assert.equal(
    await evaluate<boolean>(
      `document.body.textContent.includes('Create Event')`
    ),
    false
  )
  assert.equal(
    await evaluate<boolean>(
      `document.querySelector('[aria-label="Title"]')==null`
    ),
    true
  )
  await tap('Create event')
  await wait(`location.pathname.startsWith('/games/')`)
  const practices = await f.h.db
    .selectFrom('team_events')
    .select(['event_type', 'title'])
    .where('event_type', '=', 'practice')
    .where('title', '=', 'Practice')
    .execute()
  assert.equal(practices.length, 1)
  console.log('E14 PASS')

  // E15: Other needs a title; the schedule names each event by its type.
  await open(createRoute, 'Create Game')
  await tap('Other')
  await wait(`document.querySelector('[aria-label="Title"]')!=null`)
  assert.equal(
    await evaluate<string>(
      `${button('Create event')}.getAttribute('aria-disabled')`
    ),
    'true'
  )
  await fill('Title', 'Season party')
  await tap('Create event')
  await wait(`location.pathname.startsWith('/games/')`)
  await m.openBrowser({
    url: `${f.h.origin}/teams/${encodeURIComponent(f.teamA)}?tab=schedule`
  })
  await see('Season party')
  const firstLines = await evaluate<string[]>(
    `Array.from(document.querySelectorAll('[data-testid="scheduleGame"]')).map(row=>Array.from(row.querySelectorAll('div')).filter(node=>node.childElementCount===0).map(node=>node.textContent).find(line=>line!=='' && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\\d+)$/.test(line)))`
  )
  assert.equal(
    firstLines.filter(line => line === 'Practice').length,
    2,
    `Two practices read Practice: ${JSON.stringify(firstLines)}`
  )
  assert(firstLines.includes('Team dinner'))
  assert(firstLines.includes('Season party'))
  assert(!firstLines.includes('Morning drills'))
  assert(firstLines.some(line => line.includes('Demo Eagles')))
  console.log('E15 PASS')
}

function monthName(date: string): string {
  return [
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
  ][Number(date.slice(5, 7)) - 1]
}

async function main(): Promise<void> {
  const mode = (process.env.GAME_FORM_MODE ?? 'all') as Mode
  assert(
    ['before', 'schedule', 'api', 'all'].includes(mode),
    `Unknown GAME_FORM_MODE ${mode}`
  )
  const artifacts = resolve(required('GAME_FORM_ARTIFACTS'))
  mkdirSync(artifacts, { recursive: true })
  const geocoder = await fakeGeocoder()
  const oldGeocoder = process.env.TS_EVENT_GEOCODER_URL
  process.env.TS_EVENT_GEOCODER_URL = geocoder.url
  const f = await groupFixture(resolve('dist'), '127.0.0.1')
  let coverageBrowser: CoverageBrowser | undefined
  let daemon: Daemon | undefined
  const device = process.env.GAME_FORM_BROWSER_DEVICE ?? 'game-form-chromium'
  try {
    const seeded = await seed(f)
    if (mode === 'api' || mode === 'all')
      await suggestionsApi(f, seeded, artifacts)
    if (mode === 'api') return
    const load = createRequire(
      join(resolve(required('MAESTRO_D_CLIENT_ROOT')), 'package.json')
    )
    const { MaestroD } = load('maestro-d') as {
      MaestroD: {
        connect: (body: { name: string; bin: string }) => Promise<Daemon>
      }
    }
    execFileSync(required('MAESTRO_D_BIN'), ['ps'], { stdio: 'inherit' })
    const daemonName = process.env.MAESTRO_D ?? 'game-form-browser'
    const profile = resolve(
      'coverage/gameForm',
      daemonName + '-chromium-profile'
    )
    mkdirSync(profile, { recursive: true })
    daemon = await MaestroD.connect({
      name: daemonName,
      bin: required('MAESTRO_D_BIN')
    })
    const m = await daemon.attach({
      device,
      platform: 'web',
      commandTimeout: 30000,
      url: f.h.origin,
      extra: {
        browser: 'chromium',
        windowSize: process.env.GAME_FORM_VIEWPORT ?? '402x874',
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
    // This connection sets the time zone and the narrow width, and collects
    // coverage; every UI action uses maestro-d.
    coverageBrowser = await puppeteer.connect({
      defaultViewport: null,
      browserWSEndpoint: `ws://127.0.0.1:${debugPort}${socketPath}`
    })
    const page = (await coverageBrowser.pages()).find(candidate =>
      candidate.url().startsWith(f.h.origin)
    )
    assert(page != null)
    await page.emulateTimezone('America/Los_Angeles')
    const appErrors: string[] = []
    page.on('pageerror', error => {
      appErrors.push(String(error))
    })
    await page.coverage.startJSCoverage({
      resetOnNavigation: false,
      reportAnonymousScripts: false,
      includeRawScriptCoverage: true
    })
    const { SESSION_COOKIE } = await import('../../server/auth/tokens')
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
    if (mode === 'before') {
      await before({ f, seeded, m, page, artifacts })
      return
    }
    if (mode === 'schedule') {
      await scheduleShot(f, m, artifacts, 'schedule-events-before.png')
      return
    }
    await scenes({ f, seeded, m, page, artifacts }).catch(
      async (error: unknown) => {
        // What the browser showed when a scene failed, kept out of the proof.
        const failure = resolve('coverage/gameForm/failure.png')
        writeFileSync(failure, await m.screenshot())
        console.error(`Failure screen: ${failure}`)
        throw error
      }
    )
    const requireCoverage = createRequire(join(process.cwd(), 'package.json'))
    const convert = requireCoverage('v8-to-istanbul')
    const map = requireCoverage('istanbul-lib-coverage').createCoverageMap({})
    for (const script of await page.coverage.stopJSCoverage()) {
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
    const output = resolve(
      process.env.GAME_FORM_BROWSER_COVERAGE ?? 'coverage/gameForm/browser.json'
    )
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify(map.toJSON()))
    assert.deepEqual(appErrors, [], 'No app JavaScript errors')
    console.log(
      'Game form scenes passed in Chromium; browser coverage captured'
    )
  } finally {
    await coverageBrowser?.disconnect()
    await daemon?.detach(device).catch((error: unknown) => {
      console.error('Browser detach:', error)
    })
    daemon?.close()
    await f.h.close()
    geocoder.close()
    if (oldGeocoder === undefined) delete process.env.TS_EVENT_GEOCODER_URL
    else process.env.TS_EVENT_GEOCODER_URL = oldGeocoder
  }
}

/** The scenes this work replaces, as the base branch draws them. */
async function before({ f, seeded, m, artifacts }: Scene): Promise<void> {
  const shot = async (file: string): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 400))
    writeFileSync(join(artifacts, file), await m.screenshot())
    console.log(`Captured ${file}`)
  }
  const tapText = async (text: string): Promise<void> => {
    await m.assertVisible({ text, timeout: 20000 })
    const result = await m.evalBrowserScript({
      script: `const node=Array.from(document.querySelectorAll('[role="button"]')).find(node=>node.getAttribute('aria-label')===${JSON.stringify(text)}||node.textContent===${JSON.stringify(text)});node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2})`
    })
    const point = JSON.parse(String(result.data)) as { x: number; y: number }
    await m.tapOnPoint(point)
  }
  await m.openBrowser({
    url: `${f.h.origin}/groups/team/${encodeURIComponent(f.teamA)}/create-game`
  })
  await m.assertVisible({ text: 'Create Game', timeout: 20000 })
  await shot('create-game-before.png')
  await tapText('Away: Choose team')
  await m.evalBrowserScript({
    script: `document.querySelector('[aria-label="Find a team"],input')?.scrollIntoView({block:'start'})`
  })
  await shot('team-picker-before.png')
  await m.openBrowser({
    url: `${f.h.origin}/games/${encodeURIComponent(seeded.gameId)}/settings`
  })
  await m.assertVisible({ text: 'Game Settings', timeout: 20000 })
  await shot('game-settings-before.png')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
