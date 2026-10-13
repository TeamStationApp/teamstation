import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import puppeteer, { type Browser as CoverageBrowser } from 'puppeteer'

import { makeId } from '../../common/ids'
import { monthsBefore } from '../../server/groups/relatedTeams'
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
 * - `api`: the suggestions API only, with no browser.
 */
type Mode = 'before' | 'api'

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
  return { sameSeason, recentOpponent, staleOpponent, sameRegion, gameId }
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

async function main(): Promise<void> {
  const mode = (process.env.GAME_FORM_MODE ?? 'api') as Mode
  assert(['before', 'api'].includes(mode), `Unknown GAME_FORM_MODE ${mode}`)
  const artifacts = resolve(required('GAME_FORM_ARTIFACTS'))
  mkdirSync(artifacts, { recursive: true })
  const f = await groupFixture(resolve('dist'), '127.0.0.1')
  let coverageBrowser: CoverageBrowser | undefined
  let daemon: Daemon | undefined
  const device = process.env.GAME_FORM_BROWSER_DEVICE ?? 'game-form-chromium'
  try {
    const seeded = await seed(f)
    if (mode === 'api') {
      await suggestionsApi(f, seeded, artifacts)
      return
    }
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
    // This connection sets the time zone only; every UI action uses maestro-d.
    coverageBrowser = await puppeteer.connect({
      defaultViewport: null,
      browserWSEndpoint: `ws://127.0.0.1:${debugPort}${socketPath}`
    })
    const page = (await coverageBrowser.pages()).find(candidate =>
      candidate.url().startsWith(f.h.origin)
    )
    assert(page != null)
    await page.emulateTimezone('America/Los_Angeles')
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
    // Before: the two scenes this work replaces, as the base branch draws them.
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
  } finally {
    await coverageBrowser?.disconnect()
    await daemon?.detach(device).catch((error: unknown) => {
      console.error('Browser detach:', error)
    })
    daemon?.close()
    await f.h.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
