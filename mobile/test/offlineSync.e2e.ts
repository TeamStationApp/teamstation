import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { Client } from 'pg'

import { attach, type AttachedDevice } from './maestroD'
import { signInTestAccount } from '../../src/test/passwordFixtures'

/**
 * The phone keeps what it synced and queues what it scores, on a real phone
 * against this checkout's server (plan scenarios S5, S6 and S7, and the
 * online screens before and after).
 *
 * Install a Release build of this checkout whose TS_API_BASE_URL is this
 * Mac's LAN address and serverConfig.json's port (src/MOBILE.md, "Installing
 * on a real iPhone"). serverConfig.json's database holds `lineup-fixture`'s
 * game; the script starts and stops the server itself, because a stopped
 * server is how the phone goes offline.
 *
 *   MAESTRO_D=offlineSync \
 *   MAESTRO_D_TEAM_ID=<the team that signs WebDriverAgent> \
 *   TS_E2E_DEVICE=<the phone's hardware UDID> \
 *   TS_OFFLINE_API=http://<lan-ip>:<port>/api/v1 \
 *   TS_OFFLINE_PASSWORD=<the fixture's password> \
 *   TS_OFFLINE_FIXTURE=<lineup-fixture's JSON> \
 *   E2E_ARTIFACT_DIR=<where the screenshots and logs go> \
 *     node -r sucrase/register mobile/test/offlineSync.e2e.ts [--only online,s5,s6,s7]
 *
 * `online` signs in and takes Home, Schedule, an event's videos and scoring
 * while the server answers, as `<screen>-<label>.png` (`--label before` on
 * the base build, `after` on this one). `s5` stops the server and relaunches
 * the app onto what it synced, `s6` scores offline, and `s7` starts the
 * server and reads back what the phone sent.
 */

const APP_ID = 'app.teamstation.app'
const ROOT = resolve(__dirname, '..', '..')
/** A player to add offline: the first of these the game does not have yet. */
const PLAYERS = [
  { first: 'Jackie', last: 'Robinson' },
  { first: 'Roberto', last: 'Clemente' },
  { first: 'Hank', last: 'Aaron' },
  { first: 'Willie', last: 'Mays' },
  { first: 'Lou', last: 'Gehrig' }
]
let PLAYER = PLAYERS[0]

function required(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`${key} is required`)
  return value
}

interface Fixture {
  gameId: string
  teams: { home: string; away: string }
  users: { scorekeeper: { email: string } }
}

const API = required('TS_OFFLINE_API')
const PASSWORD = required('TS_OFFLINE_PASSWORD')
const FIXTURE = JSON.parse(
  readFileSync(required('TS_OFFLINE_FIXTURE'), 'utf8')
) as Fixture
const OUT = required('E2E_ARTIFACT_DIR')
const args = process.argv.slice(2)
const option = (name: string, fallback: string): string => {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] != null ? args[at + 1] : fallback
}
const PHASES = option('--only', 'online,s5,s6,s7').split(',')
const LABEL = option('--label', 'after')
const COMMAND =
  `$ node -r sucrase/register mobile/test/offlineSync.e2e.ts ${args.join(' ')}`.trim()

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
const log = (line: string): void => {
  console.log(`${new Date().toISOString()} ${line}`)
}

// The local server, which the script owns so it can take it away.

let server: ChildProcess | undefined

async function answers(): Promise<boolean> {
  try {
    const response = await fetch(`${API}/health`, {
      signal: AbortSignal.timeout(2000)
    })
    return response.ok
  } catch {
    return false
  }
}

async function startServer(): Promise<void> {
  if (await answers()) throw new Error(`${API} already answers: stop it first`)
  server = spawn('node', ['-r', 'sucrase/register', 'src/server/index.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true
  })
  for (let tries = 0; tries < 60; tries++) {
    if (await answers()) {
      log('server answers')
      return
    }
    await sleep(500)
  }
  throw new Error('the server did not start')
}

async function stopServer(): Promise<void> {
  if (server?.pid != null) process.kill(-server.pid, 'SIGTERM')
  server = undefined
  for (let tries = 0; tries < 40; tries++) {
    if (!(await answers())) {
      log('server stopped')
      return
    }
    await sleep(500)
  }
  throw new Error('the server is still answering')
}

/**
 * The fixture's game is upcoming: an hour ahead, unscored, scheduled. With
 * `clearPlays`, before the phone has seen this run's game, it also has no
 * plays, so every run scores from the first pitch and four balls never close
 * an at-bat between the counts S7 compares.
 */
async function makeUpcoming(clearPlays = false): Promise<void> {
  const config = JSON.parse(
    readFileSync(join(ROOT, 'serverConfig.json'), 'utf8')
  ) as { databaseUrl: string }
  const db = new Client({ connectionString: config.databaseUrl })
  await db.connect()
  try {
    await db.query('begin')
    if (clearPlays) {
      await db.query('delete from events where "gameId" = $1', [FIXTURE.gameId])
      await db.query('update games set "currentPlay" = null where id = $1', [
        FIXTURE.gameId
      ])
    }
    await db.query(
      `update games set start_at = now() + interval '1 hour', away_score = null,
         home_score = null, status = 'scheduled' where id = $1`,
      [FIXTURE.gameId]
    )
    await db.query('commit')
  } finally {
    await db.end()
  }
}

// What the server holds, read the way any client reads it.

interface ServerView {
  named: number
  pitches: number
  inLineups: number
}

async function serverView(token: string): Promise<ServerView> {
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}` }
    })
    if (!response.ok) throw new Error(`GET ${path}: ${response.status}`)
    return await response.json()
  }
  const rosters = await Promise.all(
    [FIXTURE.teams.away, FIXTURE.teams.home].map(
      async team => await get(`/teams/${team}/roster?includeFullNames=true`)
    )
  )
  const named = rosters
    .flat()
    .filter(entry => JSON.stringify(entry).includes(PLAYER.last))
  const events = (await get(`/games/${FIXTURE.gameId}/events`)) as {
    plays?: Array<{ playEvents?: unknown[] }>
    currentPlay?: { playEvents?: unknown[] } | null
  }
  const lineups = JSON.stringify(await get(`/games/${FIXTURE.gameId}/lineups`))
  const ids = named.map(entry =>
    String((entry as { gumboId?: number }).gumboId)
  )
  return {
    named: named.length,
    // A pitch that ends no at-bat is in the current play.
    pitches: [...(events.plays ?? []), events.currentPlay ?? {}].reduce(
      (sum, play) => sum + (play.playEvents?.length ?? 0),
      0
    ),
    inLineups: ids.filter(id => lineups.includes(id)).length
  }
}

// The phone.

async function visible(
  m: AttachedDevice,
  selector: Record<string, unknown>,
  timeout = 5000
): Promise<boolean> {
  try {
    await m.extendedWaitUntil({ visible: selector, timeout })
    return true
  } catch (error) {
    if ((error as { code?: string }).code !== 'COMMAND_FAILED') throw error
    return false
  }
}

async function shot(m: AttachedDevice, name: string): Promise<void> {
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, await m.screenshot())
  log(`screenshot ${path}`)
}

async function signIn(m: AttachedDevice): Promise<void> {
  await m.launchApp({ appId: APP_ID, stopApp: true })
  if (!(await visible(m, { text: 'Sign in to TeamStation' }, 15000))) return
  // The password form only follows a tap the screen was ready for.
  for (let tries = 0; ; tries++) {
    await m.tapOn({ text: 'Use a password instead' })
    if (await visible(m, { text: 'PASSWORD' }, 5000)) break
    if (tries === 1) throw new Error('The password form did not open')
  }
  await m.tapOn({ text: 'parent@example.com' })
  await m.inputText({ text: FIXTURE.users.scorekeeper.email })
  // The password field has no text of its own to find it by.
  await m.tapOn({ point: '50%,57%' })
  await m.inputText({ text: PASSWORD })
  // Dismissing the keyboard sends the form on iOS; the button is the fallback.
  await m.hideKeyboard()
  if (await visible(m, { text: 'Sign in', index: 1 }, 2000))
    await m.tapOn({ text: 'Sign in', index: 1 })
  // iOS offers to save the password once the form is sent.
  if (await visible(m, { text: 'Not Now' }, 8000))
    await m.tapOn({ text: 'Not Now' })
}

/**
 * Home's own list, from wherever the app opened. A relaunch can come back on
 * the last screen of the Home tab's stack (an event page), so it is Home only
 * when the title says so. "Home" alone is no selector: an event's home team
 * is labelled Home too, so the tab is tapped where the tab bar draws it.
 */
const HOME_TAB = '27%,92%'
const SCHEDULE_TAB = '57%,92%'

async function home(m: AttachedDevice): Promise<void> {
  for (let tries = 0; tries < 4; tries++) {
    if (await visible(m, { text: 'Your Home' }, 3000)) {
      await m.extendedWaitUntil({ visible: { text: 'Hosts' }, timeout: 30000 })
      return
    }
    if (await visible(m, { text: 'Back' }, 1000)) {
      await m.tapOn({ text: 'Back' })
    } else {
      await m.openLink({ link: 'teamstation://schedule' })
      await m.extendedWaitUntil({
        visible: { text: 'Upcoming' },
        timeout: 30000
      })
      await m.tapOn({ point: HOME_TAB })
    }
  }
  await shot(m, 'home-missing')
  throw new Error('Home does not show its list')
}

async function schedule(m: AttachedDevice): Promise<void> {
  await m.tapOn({ point: SCHEDULE_TAB })
  await m.extendedWaitUntil({ visible: { text: 'Upcoming' }, timeout: 30000 })
  await m.extendedWaitUntil({ visible: { text: 'Visitors' }, timeout: 30000 })
}

/**
 * Leaves scoring as a scorekeeper does. A scoring session left open comes
 * back on the next launch, over every tab and link.
 */
async function exitScoring(m: AttachedDevice): Promise<void> {
  await m.tapOn({ text: 'Open scoring menu' })
  await m.tapOn({ text: 'Exit Current Game' })
  await m.extendedWaitUntil({ visible: { text: 'Box score' }, timeout: 15000 })
}

async function online(m: AttachedDevice): Promise<void> {
  await signIn(m)
  await home(m)
  await sleep(2000)
  await shot(m, `home-${LABEL}`)
  await schedule(m)
  await sleep(1500)
  await shot(m, `schedule-${LABEL}`)
  await m.openLink({ link: `teamstation://games/${FIXTURE.gameId}?tab=watch` })
  await m.extendedWaitUntil({ visible: { text: 'Box score' }, timeout: 30000 })
  await sleep(1500)
  await shot(m, `event-${LABEL}`)
  await m.openLink({ link: `teamstation://games/${FIXTURE.gameId}/score` })
  await m.extendedWaitUntil({ visible: { text: 'Ball' }, timeout: 30000 })
  if (LABEL === 'after') {
    // Online, a play is still recorded and sent at once.
    await m.tapOn({ text: 'Ball' })
    await sleep(3000)
  }
  await shot(m, `scoring-${LABEL}`)
  await exitScoring(m)
}

/** S5: synced online, then relaunched with no server. */
async function s5(m: AttachedDevice): Promise<void> {
  log('S5')
  await signIn(m)
  await home(m)
  await schedule(m)
  // Prefetch runs after Home's lists; give it time to store the game.
  await sleep(10000)
  await stopServer()
  await m.stopApp({ appId: APP_ID })
  await m.launchApp({ appId: APP_ID })
  await sleep(4000)
  await home(m)
  await m.extendedWaitUntil({
    visible: { id: 'offlineBanner' },
    timeout: 30000
  })
  await sleep(1000)
  await shot(m, 'home-offline')
  await schedule(m)
  await m.assertVisible({ id: 'offlineBanner' })
  await sleep(1000)
  await shot(m, 'schedule-offline')
}

/** S6: open the game, add a player, put him in, record a play, try a team. */
async function s6(m: AttachedDevice): Promise<void> {
  await schedule(m)
  await m.tapOn({ text: 'Visitors' })
  await m.tapOn({ text: 'Score' })
  await m.tapOn({ text: 'Full game scoring' })
  await m.extendedWaitUntil({ visible: { text: 'Ball' }, timeout: 30000 })
  await m.tapOn({ text: 'Open scoring menu' })
  await m.tapOn({ text: 'Set Team Rosters' })
  await m.tapOn({ text: 'Create Player' })
  // The sheet's fields share their names with their labels, and the
  // keyboard moves the sheet, so the first field is tapped where it opens
  // and Return carries on to the next: first name, last name, then the
  // number pad's Done.
  await m.tapOn({ point: '26%,30%' })
  await m.inputText({ text: `${PLAYER.first}\n` })
  await m.inputText({ text: `${PLAYER.last}\n` })
  await m.tapOn({ text: 'Done' })
  // Create Player is also the sheet's title and the button behind it.
  await m.tapOn({ point: '50%,77%' })
  const added = `${PLAYER.first} ${PLAYER.last[0]}`
  await m.extendedWaitUntil({ visible: { text: added }, timeout: 15000 })
  await sleep(1000)
  await shot(m, 'roster-offline')
  // Tapping a roster player puts him at the end of the lineup. A quick
  // swipe scrolls the lineup; a held one would drag a batter.
  await m.tapOn({ text: added })
  await sleep(1000)
  await m.swipe({ start: '75%,75%', end: '75%,40%', duration: 150 })
  // The roster column lists only players outside the lineup, so he shows
  // here once, in the lineup.
  await m.extendedWaitUntil({ visible: { text: added }, timeout: 10000 })
  await sleep(1000)
  await shot(m, 'lineup-offline')
  await m.tapOn({ text: 'Save Rosters' })
  await m.extendedWaitUntil({ visible: { text: 'Ball' }, timeout: 15000 })
  await m.tapOn({ text: 'Ball' })
  await sleep(2000)
  await shot(m, 'scoring-offline')
  await exitScoring(m)
  // Back to Home, still with no server, and the create waits.
  await m.stopApp({ appId: APP_ID })
  await m.launchApp({ appId: APP_ID })
  await sleep(4000)
  await home(m)
  await m.tapOn({ text: 'Create Team' })
  await m.extendedWaitUntil({
    visible: { id: 'offlineCreateMessage' },
    timeout: 10000
  })
  await m.assertVisible({ text: "Available when you're back online." })
  await m.assertNotVisible({ text: 'Team name' })
  await sleep(500)
  await shot(m, 'create-offline')
}

/** S7: the server is back; the queue drains and the server has it once. */
async function s7(m: AttachedDevice, before: ServerView): Promise<void> {
  const lines = [
    COMMAND,
    '',
    `before the phone went offline: ${JSON.stringify(before)}`
  ]
  await startServer()
  // Home's foreground read succeeds, which wakes the queue.
  await m.extendedWaitUntil({
    notVisible: { id: 'offlineBanner' },
    timeout: 120000
  })
  lines.push('the banner cleared')
  const token = await signInTestAccount(API, {
    email: FIXTURE.users.scorekeeper.email,
    password: PASSWORD
  })
  const after = await serverView(token)
  lines.push(`after the queue drained: ${JSON.stringify(after)}`)
  const added = after.named - before.named
  const pitched = after.pitches - before.pitches
  lines.push(`players named ${PLAYER.last} added: ${added}`)
  lines.push(`pitches added: ${pitched}`)
  lines.push(`added players in a lineup: ${after.inLineups - before.inLineups}`)
  writeFileSync(join(OUT, 'drain-once.log'), lines.join('\n') + '\n')
  log(lines.join('\n'))
  if (added !== 1)
    throw new Error(`expected one new player, the server has ${added}`)
  if (pitched !== 1)
    throw new Error(`expected one new pitch, the server has ${pitched}`)
  if (after.inLineups - before.inLineups !== 1)
    throw new Error('the new player is not in the lineup')
  await shot(m, 'home-drained')
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await makeUpcoming(true)
  await startServer()
  const m = await attach({
    daemon: required('MAESTRO_D'),
    device: required('TS_E2E_DEVICE'),
    appId: APP_ID,
    artifactDir: OUT
  })
  try {
    if (PHASES.includes('online')) {
      await online(m)
      // Its play started the game; S5 syncs it as upcoming again.
      await makeUpcoming()
    }
    const token = await signInTestAccount(API, {
      email: FIXTURE.users.scorekeeper.email,
      password: PASSWORD
    })
    for (const candidate of PLAYERS) {
      PLAYER = candidate
      if ((await serverView(token)).named === 0) break
    }
    log(`the player added offline is ${PLAYER.first} ${PLAYER.last}`)
    const before = await serverView(token)
    if (PHASES.includes('s5')) await s5(m)
    if (PHASES.includes('s6')) await s6(m)
    if (PHASES.includes('s7')) await s7(m, before)
  } finally {
    if (server != null) await stopServer()
    await m.detach()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  if (server?.pid != null) process.kill(-server.pid, 'SIGTERM')
  process.exit(1)
})
