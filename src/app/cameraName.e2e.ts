import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { connect as connectNet } from 'node:net'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'
import puppeteer, {
  type Browser,
  type BrowserContext,
  type Page
} from 'puppeteer'

import { makeId } from '../common/ids'
import { userIdNumber } from '../common/userIdNumber'
import {
  bodyHas,
  bodyText,
  buttonEnabled,
  clickCreate,
  clickLabel,
  endOnCard,
  preparePhone
} from './cameraName.page.js'

/**
 * A camera name typed on the watch tab is the name on the stream card.
 *
 *   TS_E2E_WEB_URL=http://127.0.0.1:8080 \
 *   TS_API_TEST_URL=http://127.0.0.1:9100/api/v1 \
 *   TS_E2E_SERVER_LOG=server.log \
 *   TS_E2E_VIDEOGRAPHER=camera-name-e2e@teamstation.local \
 *     npx mocha -r sucrase/register --extension ts --timeout 180000 \
 *     src/app/cameraName.e2e.ts
 *
 * The `before` hook writes a gitignored `serverConfig.json`, migrates
 * `teamstation_cameraName` on Postgres 18, and starts the API and the web
 * app when those ports are free.
 */
const EMAIL =
  process.env.TS_E2E_VIDEOGRAPHER ?? 'camera-name-e2e@teamstation.local'
const SERVER_LOG = process.env.TS_E2E_SERVER_LOG ?? 'server.log'
const PREFERRED_API_PORT = 9100
const DATABASE_URL = 'postgres://localhost:5433/teamstation_cameraName'
const ADMIN_URL = 'postgres://localhost:5433/postgres'

const started: ChildProcess[] = []
let browser: Browser | undefined
let webOrigin = process.env.TS_E2E_WEB_URL ?? ''
let apiBase = process.env.TS_API_TEST_URL ?? ''
let desktopGame = ''
let phoneGame = ''

interface LiveList {
  mine: Array<{ label: string; closesAt: string | null; state: string }>
}

async function listening(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = connectNet({ host: '127.0.0.1', port })
    const done = (open: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => {
      done(true)
    })
    socket.once('error', () => {
      done(false)
    })
  })
}

async function freePort(candidates: number[]): Promise<number> {
  for (const port of candidates) {
    if (!(await listening(port))) return port
  }
  throw new Error(`No free port among ${candidates.join(', ')}`)
}

function spawnLogged(
  command: string,
  args: string[],
  logPath: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  const log = openSync(logPath, 'a')
  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', log, log],
    env
  })
  started.push(child)
}

async function teamStationHealth(base: string): Promise<boolean> {
  try {
    const response = await fetch(
      `${base.replace(/\/api\/v1$/, '')}/api/v1/health`,
      {
        signal: AbortSignal.timeout(2000)
      }
    )
    if (!response.ok) return false
    const body = (await response.json()) as { database?: string }
    return body.database === 'ok'
  } catch {
    return false
  }
}

async function untilOk(url: string, what: string): Promise<void> {
  const end = Date.now() + 120000
  for (;;) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The process is still binding.
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

async function prepare(): Promise<void> {
  const admin = new Pool({ connectionString: ADMIN_URL })
  const existing = await admin.query(
    'select 1 from pg_database where datname = $1',
    ['teamstation_cameraName']
  )
  if (existing.rowCount === 0) {
    await admin.query('create database "teamstation_cameraName"')
  }
  await admin.end()

  const webPort = await freePort([8080, 8090, 8092, 8093])
  let apiPort = PREFERRED_API_PORT
  if (apiBase === '') {
    const preferred = `http://127.0.0.1:${PREFERRED_API_PORT}/api/v1`
    if (
      (await listening(PREFERRED_API_PORT)) &&
      !(await teamStationHealth(preferred))
    ) {
      // 9100 is taken by something that is not this API. WebDriverAgent
      // binds it on this machine.
      apiPort = await freePort([9110, 9120, 9130, 9140])
    }
    apiBase = `http://127.0.0.1:${apiPort}/api/v1`
  }
  const origins = [8080, webPort].flatMap(port => [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`
  ])
  writeFileSync(
    'serverConfig.json',
    JSON.stringify(
      {
        listenPort: apiPort,
        clusterWorkers: 1,
        sessionSecret: 'camera-name-e2e-session-secret-value',
        databaseUrl: DATABASE_URL,
        corsOrigins: [...new Set(origins)],
        workDir: '/tmp/teamstation-cameraName/work',
        mediaDir: '/tmp/teamstation-cameraName/media',
        statsBuilder: false
      },
      null,
      2
    )
  )
  mkdirSync('/tmp/teamstation-cameraName/work', { recursive: true })
  mkdirSync('/tmp/teamstation-cameraName/media', { recursive: true })

  const migrate = spawn('npm', ['run', 'migrate'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env
  })
  const migrateCode = await new Promise<number>(resolve => {
    migrate.once('exit', code => {
      resolve(code ?? 1)
    })
  })
  if (migrateCode !== 0) throw new Error(`migrate exited ${migrateCode}`)

  const db = new Pool({ connectionString: DATABASE_URL })
  const home = 'tem_cameraHome'
  const away = 'tem_cameraAway'
  await db.query(
    `insert into teams (id, name, created_at, updated_at)
     values ($1, 'Home', now(), now()), ($2, 'Away', now(), now())
     on conflict (id) do nothing`,
    [home, away]
  )
  const found = await db.query<{ id: number }>(
    `select users.id from users
     join user_emails on user_emails.user_id = users.id
     where user_emails.email = $1`,
    [EMAIL]
  )
  let userId = found.rows[0]?.id
  if (userId == null) {
    const legacyId = makeId('user')
    userId = userIdNumber(legacyId)
    await db.query(
      `insert into users (id, "legacyId", display_name, login_enabled, created_at, updated_at)
       values ($1, $2, 'Camera Name', true, now(), now())`,
      [userId, legacyId]
    )
    await db.query(
      `insert into user_emails (id, user_id, email, is_primary)
       values ($1, $2, $3, true)`,
      [makeId('userEmail'), userId, EMAIL]
    )
  }
  await db.query(
    `insert into memberships (id, user_id, team_id)
     values ($1, $2, $3)
     on conflict (user_id, team_id) do nothing`,
    [makeId('membership'), userId, home]
  )
  await db.query(
    `insert into scope_roles (id, user_id, scope_type, scope_id, role)
     values ($1, $2, 'team', $3, 'videographer')
     on conflict (user_id, scope_type, scope_id, role) do nothing`,
    [makeId('scopeRole'), userId, home]
  )
  desktopGame = makeId('game')
  phoneGame = makeId('game')
  for (const id of [desktopGame, phoneGame]) {
    await db.query(
      `insert into games (id, home_team_id, away_team_id, start_at, created_at, updated_at)
       values ($1, $2, $3, now(), now(), now())`,
      [id, home, away]
    )
  }
  await db.end()

  if (webOrigin === '') webOrigin = `http://127.0.0.1:${webPort}`

  if (!(await listening(apiPort))) {
    spawnLogged('npm', ['start'], SERVER_LOG)
    await untilOk(`${apiBase.replace(/\/api\/v1$/, '')}/api/v1/health`, 'API')
  }
  if (!(await listening(webPort))) {
    spawnLogged('npm', ['run', 'start.web'], join(process.cwd(), 'web.log'), {
      ...process.env,
      TS_SERVE_PORT: String(webPort),
      TS_API_BASE_URL: apiBase
    })
    await untilOk(webOrigin, 'web app')
  }
}

async function signIn(): Promise<string> {
  const before = readFileSync(SERVER_LOG, 'utf8').length
  const asked = await fetch(`${apiBase}/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL })
  })
  expect(asked.status, 'email-code').equals(202)
  const pattern = new RegExp(
    `sign-in code for ${EMAIL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (\\d{6})`
  )
  const end = Date.now() + 20000
  let code = ''
  for (;;) {
    const match = pattern.exec(readFileSync(SERVER_LOG, 'utf8').slice(before))
    if (match?.[1] != null) {
      code = match[1]
      break
    }
    if (Date.now() > end)
      throw new Error('Timed out waiting for the sign-in code')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const verified = await fetch(`${apiBase}/auth/email-code/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, code })
  })
  expect(verified.status, 'verify').equals(200)
  return ((await verified.json()) as { token: string }).token
}

async function openGame(
  token: string,
  gameId: string,
  viewport: {
    width: number
    height: number
    isMobile?: boolean
    hasTouch?: boolean
    deviceScaleFactor?: number
  }
): Promise<{ context: BrowserContext; page: Page }> {
  if (browser == null) throw new Error('No browser')
  const context = await browser.createBrowserContext()
  await context.setCookie({
    name: 'ts_session',
    value: encodeURIComponent(token),
    domain: new URL(apiBase).hostname,
    path: '/'
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  await page.setViewport(viewport)
  await page.goto(`${webOrigin}/games/${gameId}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[aria-label="Camera name"]')
  return { context, page }
}

async function liveStreams(token: string, gameId: string): Promise<LiveList> {
  const response = await fetch(`${apiBase}/games/${gameId}/live-streams`, {
    headers: { authorization: `Bearer ${token}` }
  })
  expect(response.status, 'live-streams').equals(200)
  return (await response.json()) as LiveList
}

async function clickButton(page: Page, words: string): Promise<void> {
  await page.waitForFunction(buttonEnabled, {}, words)
  await page.evaluate(clickLabel, words)
}

async function endNamed(page: Page, camera: string): Promise<void> {
  const clicked = await page.evaluate(endOnCard, camera)
  expect(clicked, `End stream on ${camera}`).equals(true)
}

describe('a camera name on the watch tab', function () {
  this.timeout(300000)

  before(async function () {
    await prepare()
    browser = await puppeteer.launch({ headless: true })
  })

  after(async function () {
    if (browser != null) await browser.close()
    for (const child of started) {
      if (child.pid != null) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          child.kill('SIGTERM')
        }
      }
    }
  })

  it('names the cameras on a desktop window and on a phone', async function () {
    const token = await signIn()
    const desktop = await openGame(token, desktopGame, {
      width: 1440,
      height: 900
    })
    try {
      await desktop.page.evaluate(clickCreate)
      let list = await liveStreams(token, desktopGame)
      expect(list.mine).has.length(0)

      await desktop.page
        .locator('[aria-label="Camera name"]')
        .fill('First Base')
      await clickButton(desktop.page, 'Create a stream URL')
      await desktop.page.waitForFunction(bodyHas, {}, 'New key')
      const afterCreate = await desktop.page.evaluate(bodyText)
      expect(afterCreate).includes('••••')
      expect(afterCreate).includes('New key')
      expect(afterCreate).includes('End stream')

      await clickButton(desktop.page, 'New key')
      await desktop.page.waitForFunction(bodyHas, {}, 'First Base')

      await desktop.page
        .locator('[aria-label="Camera name"]')
        .fill('Third Base')
      await clickButton(desktop.page, 'Add a camera')
      await desktop.page.waitForFunction(bodyHas, {}, 'Third Base')

      await endNamed(desktop.page, 'First Base')
      const end = Date.now() + 15000
      let closed: LiveList['mine'][number] | undefined
      for (;;) {
        list = await liveStreams(token, desktopGame)
        closed = list.mine.find(row => row.label === 'First Base')
        if (closed?.closesAt != null) break
        if (Date.now() > end) break
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      expect(closed?.label).equals('First Base')
      expect(closed?.closesAt == null).equals(false)
    } finally {
      await desktop.context.close()
    }

    const phone = await openGame(token, phoneGame, {
      width: 393,
      height: 852,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3
    })
    try {
      await phone.page.evaluate(preparePhone)
      expect((await liveStreams(token, phoneGame)).mine).has.length(0)

      await phone.page.locator('[aria-label="Camera name"]').fill('First Base')
      await clickButton(phone.page, 'Create a stream URL')
      await phone.page.waitForFunction(bodyHas, {}, 'First Base')

      await endNamed(phone.page, 'First Base')
      const end = Date.now() + 15000
      let closed: LiveList['mine'][number] | undefined
      for (;;) {
        const list = await liveStreams(token, phoneGame)
        closed = list.mine.find(row => row.label === 'First Base')
        if (closed?.closesAt != null) break
        if (Date.now() > end) break
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      expect(closed?.label).equals('First Base')
      expect(closed?.closesAt == null).equals(false)
    } finally {
      await phone.context.close()
    }
  })
})
