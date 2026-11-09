/**
 * The offline cache on a real phone whose traffic is dropped, then stalled:
 * screens opened online paint again on a relaunch with no network, scoring
 * and Confirm Swap never wait, and the writes reach the server in the order
 * they were entered. Driven through maestro-d's JavaScript library.
 *
 *   TS_OFFLINE_DEVICE_CONFIG=<config.json> \
 *   TS_MAESTRO_D_CLIENT=<maestro-d npm package entry> MAESTRO_D_BIN=<maestro-d> \
 *     node -r sucrase/register src/app/sync/offlineDevice.e2e.ts \
 *     --mode before|after --platform ios|android --device <id> --ip <phone address> \
 *     --artifacts <dir> [--log <file>] [--app-file <ipa|apk>] [--steps 1-8] [--keep-app]
 *
 * The server is a development seat running the commit under test, seeded by
 * `scripts/e2e/offlineDevice/fixture.ts`; the phone build is that commit's
 * build aimed at that seat, app id `app.teamstation.develop`. How to drop,
 * stall and clear the phone's traffic, and how to switch the seat's request
 * recorder and read its database, are commands the untracked config file
 * names, never here (`scripts/e2e/offlineDevice/README.md` lists its keys).
 *
 * `before` runs against the base build: every check that describes the new
 * behaviour is recorded as observed, never failed, and the request recorder
 * (`TS_REQUEST_RECORD`) is not read. `after` runs against the branch build:
 * the same checks are assertions, the recorder is switched on for the run
 * (and off, its lines deleted, at the end), and any failed check fails the
 * run once every screenshot is taken.
 *
 * The phone must already be claimed and on a network whose traffic the
 * config's commands can drop or stall. Each command names this phone's
 * address only, and the clear runs in `finally`; each command and its
 * answer is a `$` line in `<artifacts>/network.log`.
 *
 * Writes to the seat: scoring the fixture's upcoming game enters pitches, two
 * swaps of home and away, an event tag and a roster add on that game, which
 * puts the Add Existing candidate on the opened team. A later run needs that
 * game back at its fixture state and the candidate off that team (README).
 */
import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PNG } from 'pngjs'

import { hashEmailCode } from '../../server/auth/tokens'

/**
 * The commands that reach the seat and the phone's network: an untracked
 * file, never in Git. Each is a shell command line, run on this machine;
 * `{ip}` and `{ms}` are replaced by the phone's address and a delay in ms,
 * each quoted for the shell.
 */
interface Config {
  /** The ids `fixture.ts` printed. */
  fixture: string
  /** The signing team for the iOS driver. */
  teamId?: string
  network: {
    /** Drops every packet to and from `{ip}`. Fails when it is refused. */
    drop: string
    /** Delays every packet to and from `{ip}` by `{ms}`. Fails when refused. */
    stall: string
    /** Clears what `drop` and `stall` set on `{ip}`; fails if it is still set. */
    clear: string
    /** Exits 0 when `{ip}` is a phone the commands can shape; says which. */
    check: string
  }
  seat: {
    /** The seat's public origin. */
    origin: string
    /** The seat's request recorder (`TS_REQUEST_RECORD`). */
    record: {
      /** Switches it on, empty; the seat may restart. */
      on: string
      /** Switches it off, its lines deleted, and says so. */
      off: string
      /** Prints its lines so far. */
      read: string
    }
    /**
     * Runs the SQL on its standard input against the seat's database, prints
     * each row on a line, its columns separated by `|`, with no header or
     * footer, and fails on an error (psql's `-At -v ON_ERROR_STOP=1`).
     */
    sql: string
  }
}

function readConfig(): Config {
  const file = process.env.TS_OFFLINE_DEVICE_CONFIG
  if (file == null || file === '')
    throw new Error('Supply TS_OFFLINE_DEVICE_CONFIG')
  const config = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>
  const missing = Object.entries({
    fixture: config.fixture,
    'network.drop': config.network?.drop,
    'network.stall': config.network?.stall,
    'network.clear': config.network?.clear,
    'network.check': config.network?.check,
    'seat.origin': config.seat?.origin,
    'seat.record.on': config.seat?.record?.on,
    'seat.record.off': config.seat?.record?.off,
    'seat.record.read': config.seat?.record?.read,
    'seat.sql': config.seat?.sql
  })
    .filter(([, value]) => typeof value !== 'string' || value === '')
    .map(([key]) => key)
  if (missing.length > 0)
    throw new Error(
      `${file}: ${missing.join(', ')} missing (scripts/e2e/offlineDevice/README.md)`
    )
  return config as Config
}
const CONFIG = readConfig()

// ---------------------------------------------------------------- arguments

function arg(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`)
  if (at >= 0 && process.argv[at + 1] != null) return process.argv[at + 1]
  if (fallback != null) return fallback
  throw new Error(`Supply --${name}`)
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const MODE = arg('mode') as 'before' | 'after'
assert.ok(MODE === 'before' || MODE === 'after', `--mode ${MODE}`)
const PLATFORM = arg('platform') as 'ios' | 'android'
assert.ok(
  PLATFORM === 'ios' || PLATFORM === 'android',
  `--platform ${PLATFORM}`
)
const DEVICE = arg('device')
const IP = arg('ip')
assert.ok(
  /^\d{1,3}(\.\d{1,3}){3}$/.test(IP),
  `--ip ${IP} is not an IPv4 address`
)
const ARTIFACTS = resolve(arg('artifacts'))
const RUN_LOG = arg(
  'log',
  join(ARTIFACTS, `offlineDevice-${PLATFORM}-${MODE}.log`)
)
const APP_FILE = arg('app-file', '')
const TEAM_ID = CONFIG.teamId ?? ''
const FIXTURE = JSON.parse(readFileSync(CONFIG.fixture, 'utf8')) as {
  email: string
  personId: string
  upcomingGameId: string
  pastGameId: string
  teams: { opened: string; unopened: string }
  teamNames: { opened: string; unopened: string; opponent: string }
  seasonId: string
  leagueId: string
  candidate: { name: string; userId: string }
}
const STEPS = (() => {
  const [from, to] = arg('steps', '1-8').split('-').map(Number)
  return { from, to: to ?? from }
})()
const runs = (step: number): boolean => step >= STEPS.from && step <= STEPS.to

const APP_ID = 'app.teamstation.develop'
const DAEMON = process.env.MAESTRO_D ?? `offlineCache-${PLATFORM}`
const MAESTRO_BIN = process.env.MAESTRO_D_BIN ?? ''
const MAESTRO_CLIENT = process.env.TS_MAESTRO_D_CLIENT ?? ''
if (MAESTRO_BIN === '' || MAESTRO_CLIENT === '')
  throw new Error('Supply MAESTRO_D_BIN and TS_MAESTRO_D_CLIENT')
const NETWORK = CONFIG.network
const SEAT = CONFIG.seat
const SIGN_IN_CODE = String(100000 + Math.floor(Math.random() * 900000))
const TAG = 'stalled'
const CANDIDATE_SEARCH = FIXTURE.candidate.name.split(' ')[1].slice(0, 5)
/** The candidate's short name, as Add Existing and the roster list him. */
const CANDIDATE_SHORT = (() => {
  const [first, last] = FIXTURE.candidate.name.split(' ')
  return `${first} ${last[0]}`
})()
/** His row on Set Team Rosters: his name, not the search's or the note's. */
const CANDIDATE_ROW = new RegExp(`\\b${CANDIDATE_SHORT}\\b`)
const notCandidateRow = (n: Node): boolean =>
  !/^Choose |was added|already on the roster/.test(label(n))
const BANNER_RGB = [0x6b, 0x3e, 0x00]
/** How long an offline screen may take: the base build waits on each request's network timeout (~40 s). */
const SLOW = MODE === 'before' ? 90000 : 15000
/** The scoring screen's own line, which the app's banner is not drawn over. */
const OFFLINE_LINE = "Offline. Edits will send when you're back online."

// ------------------------------------------------------------------ logging

mkdirSync(ARTIFACTS, { recursive: true })
const NETWORK_LOG = join(ARTIFACTS, 'network.log')
function log(line: string): void {
  const stamped = `${new Date().toISOString()} [${PLATFORM} ${MODE}] ${line}`
  appendFileSync(RUN_LOG, stamped + '\n')
  console.log(stamped)
}
const failures: string[] = []
/**
 * A plan assertion. After: a failure is collected and fails the run at the
 * end. Before: the observation is recorded, never failed.
 */
function check(name: string, ok: boolean, detail = ''): boolean {
  const words = detail === '' ? '' : ` (${detail})`
  if (MODE === 'after') {
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${words}`)
    if (!ok) failures.push(name)
  } else
    log(
      `OBSERVED ${ok ? 'as the plan wants' : 'NOT as the plan wants'}: ${name}${words}`
    )
  return ok
}
const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

// ------------------------------------------------------------------ network

const quote = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`
/** A config command with its placeholders filled in, each quoted. */
function filled(command: string, values: Record<string, string>): string {
  return command.replace(/\{(\w+)\}/g, (whole, key: string) =>
    values[key] == null ? whole : quote(values[key])
  )
}
/** Runs a config command; `input` is its standard input. Throws on failure. */
function command(line: string, input?: string): string {
  return execFileSync('/bin/sh', ['-c', line], {
    encoding: 'utf8',
    input,
    timeout: 120000
  })
}
/** Runs one of the network commands, logged, and whether it succeeded. */
function networkCall(
  name: keyof Config['network'],
  values: Record<string, string> = {}
): { ok: boolean; answer: string } {
  const line = filled(NETWORK[name], { ip: IP, ...values })
  let ok = true
  let answer: string
  try {
    answer = command(line)
  } catch (error) {
    ok = false
    answer = `ERROR ${(error as Error).message}`
  }
  appendFileSync(NETWORK_LOG, `$ ${line}\n${answer.trim()}\n`)
  log(
    `network ${name} ${JSON.stringify(values)} -> ${answer.trim().slice(0, 200)}`
  )
  return { ok, answer }
}
function dropTraffic(): void {
  const { ok, answer } = networkCall('drop')
  assert.ok(ok, `drop refused: ${answer}`)
}
function stallTraffic(ms: number): void {
  const { ok, answer } = networkCall('stall', { ms: String(ms) })
  assert.ok(ok, `stall refused: ${answer}`)
}
function clearTraffic(): void {
  const { ok, answer } = networkCall('clear')
  if (!ok) log(`WARNING ${IP} still shaped after clear: ${answer}`)
}

// --------------------------------------------------------------------- seat

/** A string as an SQL literal. */
const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`
/** Runs SQL on the seat's database; its rows, one a line. */
function onSeatDb(query: string): string {
  return command(SEAT.sql, query)
}
/** The fixture games' sides, plays and tags (read only). */
function gameState(): string {
  return onSeatDb(
    `select g.id, 'home='||ht.name, 'away='||at.name, g.status, 'gen='||coalesce(g.play_generation::text,'-'),
  'current='||(g."currentPlay" is not null)::text,
  'plays='||(select count(*) from events e where e."gameId"=g.id),
  'tags='||(select count(*) from event_tags t where t.game_id=g.id)
from games g join teams ht on ht.id=g.home_team_id join teams at on at.id=g.away_team_id
where g.id in (${literal(FIXTURE.upcomingGameId)}, ${literal(FIXTURE.pastGameId)}) order by g.start_at;
`
  ).trim()
}
/**
 * Whether the Add Existing candidate plays on the opened team, as the seat
 * holds it (read only): `player`, `member` or `none`.
 */
function candidateOnOpened(): string {
  return onSeatDb(
    `select case when bool_or(is_player) then 'player'
            when count(*) > 0 then 'member' else 'none' end
  from memberships where team_id = ${literal(FIXTURE.teams.opened)} and user_id = ${literal(FIXTURE.candidate.userId)};
`
  ).trim()
}
/**
 * Sets the fixture person's newest pending sign-in code to the hash of a code
 * this run chose, computed by the server's own `hashEmailCode`, so no mailbox
 * is read. Touches that one row, and prints its id.
 */
function setCodeOnce(after: string): string {
  const hash = hashEmailCode(SIGN_IN_CODE)
  assert.ok(/^[0-9a-f]{64}$/.test(hash), 'bad hash')
  return onSeatDb(
    `with chosen as (
update email_codes set code_hash = ${literal(hash)}
 where id = (select id from email_codes
              where lower(email) = lower(${literal(FIXTURE.email)}) and purpose = 'login'
                and consumed_at is null and expires_at > now()
                and created_at > ${literal(after)}::timestamptz
              order by created_at desc limit 1)
returning id)
select id from chosen;
`
  )
}
async function setSignInCode(after: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const out = setCodeOnce(after).trim()
    if (out !== '') {
      log(
        `sign-in code row set to hashEmailCode(<chosen code>): ${out.split('\n')[0]}`
      )
      return
    }
    await pause(2000)
  }
  throw new Error('No pending sign-in code row for the fixture person')
}
async function seatHealthy(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const status = execFileSync(
        'curl',
        [
          '-s',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          `${SEAT.origin}/api/v1/health`
        ],
        {
          encoding: 'utf8',
          timeout: 10000
        }
      )
      if (status === '200') return
    } catch {}
    await pause(2000)
  }
  throw new Error('The seat did not come back')
}
/** After mode: the seat writes the request log for the run. */
async function startRecorder(): Promise<void> {
  command(SEAT.record.on)
  await seatHealthy()
  // The health reads just made go through the recorder. One that drops
  // every line silently would pass every request-log check with nothing in
  // it.
  const written = recorded().filter(line => line.includes('/api/v1/health'))
  if (written.length === 0)
    throw new Error(
      'The request recorder wrote nothing: seat.record.read must print the lines seat.record.on has the seat write'
    )
  log(
    `request recorder on for the seat (TS_REQUEST_RECORD set; ${written.length} health reads recorded)`
  )
}
/** The recorder's lines, in arrival order. */
function recorded(): string[] {
  return command(SEAT.record.read)
    .split('\n')
    .filter(line => line.trim() !== '')
    .sort()
}
async function stopRecorder(): Promise<void> {
  const said = command(SEAT.record.off).trim()
  await seatHealthy()
  log(`request recorder off: ${said.replace(/\n/g, '; ')}`)
}

// ------------------------------------------------------------------- device

interface Node {
  type?: string
  id?: string
  text?: string
  enabled?: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
interface Device {
  launchApp: (o: unknown) => Promise<unknown>
  openLink: (o: unknown) => Promise<unknown>
  stopApp: (o: unknown) => Promise<unknown>
  tapOn: (o: unknown) => Promise<unknown>
  tapOnPoint: (o: unknown) => Promise<unknown>
  inputText: (o: unknown) => Promise<unknown>
  eraseText: (o: unknown) => Promise<unknown>
  hideKeyboard: (o?: unknown) => Promise<unknown>
  pressKey: (o: unknown) => Promise<unknown>
  scrollUntilVisible: (o: unknown) => Promise<unknown>
  swipe: (o: unknown) => Promise<unknown>
  hierarchy: () => Promise<Node>
  hierarchyRaw: () => Promise<Buffer>
  screenshot: () => Promise<Buffer>
  detach: () => Promise<unknown>
}
let m: Device
let screen = { width: 0, height: 0 }

const flat = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flat)
]
async function nodes(): Promise<Node[]> {
  const root = await m.hierarchy()
  const all = flat(root)
  const widest = all.reduce(
    (w, n) => Math.max(w, (n.bounds?.x ?? 0) + (n.bounds?.width ?? 0)),
    0
  )
  const tallest = all.reduce(
    (h, n) => Math.max(h, (n.bounds?.y ?? 0) + (n.bounds?.height ?? 0)),
    0
  )
  if (screen.width === 0)
    screen = {
      width: root.bounds?.width ?? widest,
      height: root.bounds?.height ?? tallest
    }
  return all
}
const label = (n: Node): string => (n.text ?? '').replace(/\s+/g, ' ').trim()
const matches = (n: Node, re: RegExp): boolean =>
  re.test(label(n)) || re.test(n.id ?? '')
const onScreen = (n: Node): boolean =>
  n.bounds != null &&
  n.bounds.width > 0 &&
  n.bounds.y + n.bounds.height > 0 &&
  n.bounds.y < screen.height &&
  n.bounds.x < screen.width &&
  n.bounds.x + n.bounds.width > 0
async function find(
  re: RegExp,
  where: (n: Node) => boolean = () => true
): Promise<Node | undefined> {
  return (await nodes()).find(n => matches(n, re) && onScreen(n) && where(n))
}
async function waitFor(
  re: RegExp,
  timeout = 15000,
  where: (n: Node) => boolean = () => true
): Promise<Node | undefined> {
  const end = Date.now() + timeout
  do {
    const found = await find(re, where).catch(() => undefined)
    if (found != null) return found
    await pause(400)
  } while (Date.now() < end)
  return undefined
}
/**
 * How long after `since` a hierarchy first no longer held a match: the time
 * that hierarchy was asked for, as reading one takes a few hundred ms. The
 * answer it came back at is logged beside it.
 */
async function gone(
  re: RegExp,
  timeout: number,
  where: (n: Node) => boolean = () => true,
  since = Date.now()
): Promise<number | undefined> {
  do {
    const asked = Date.now()
    if ((await find(re, where).catch(() => undefined)) == null) {
      log(
        `${re.source} gone in the hierarchy asked for ${asked - since} ms after the tap (answered at ${Date.now() - since} ms)`
      )
      return asked - since
    }
    await pause(100)
  } while (Date.now() - since < timeout)
  return undefined
}
async function tapNode(n: Node, duration?: number): Promise<void> {
  const b = n.bounds!
  await m.tapOnPoint({
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + b.height / 2),
    ...(duration == null ? {} : { duration })
  })
}
async function tap(
  re: RegExp,
  timeout = 15000,
  where?: (n: Node) => boolean
): Promise<void> {
  const n = await waitFor(re, timeout, where)
  if (n == null) throw new Error(`Nothing on screen matches ${re}`)
  await tapNode(n)
  await pause(700)
}
async function tryTap(
  re: RegExp,
  timeout = 5000,
  where?: (n: Node) => boolean
): Promise<boolean> {
  const n = await waitFor(re, timeout, where)
  if (n == null) return false
  await tapNode(n)
  await pause(700)
  return true
}
const inTabBar = (n: Node): boolean => (n.bounds?.y ?? 0) > screen.height * 0.82
const aboveTabBar = (n: Node): boolean =>
  (n.bounds?.y ?? 0) < screen.height * 0.82
const upper =
  (share: number) =>
  (n: Node): boolean =>
    (n.bounds?.y ?? 0) < screen.height * share

async function tab(name: 'Home' | 'Videos' | 'Schedule'): Promise<void> {
  await tap(new RegExp(`^${name}$`), SLOW, inTabBar)
  // A second tap pops the tab's stack to its root (a game opened from
  // Schedule stays on Schedule's stack).
  if ((await find(/^Back$/)) != null)
    await tap(new RegExp(`^${name}$`), 5000, inTabBar)
}
async function type(text: string): Promise<void> {
  if (PLATFORM === 'android') {
    await m.inputText({ text })
    return
  }
  // iOS drops and reorders characters typed at speed; one at a time holds.
  for (const c of text) await m.inputText({ text: c })
}
async function fieldValue(name: RegExp): Promise<string | undefined> {
  if (PLATFORM === 'android') {
    const field = (await nodes()).filter(n =>
      (n.type ?? '').includes('EditText')
    )
    return field.map(label).find(text => text !== '')
  }
  const raw = (await m.hierarchyRaw()).toString('utf8')
  for (const match of raw.matchAll(
    /<XCUIElementTypeTextField[^>]*?value="([^"]*)"[^>]*?name="([^"]*)"/g
  ))
    if (name.test(match[2])) return match[1]
  return undefined
}
async function fill(field: Node, text: string, name: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await tapNode(field)
    await pause(400)
    await m.eraseText({ characters: 64 })
    await type(text)
    const value = await fieldValue(name)
    if (PLATFORM === 'android' || value === text) return
    log(`typed "${value}" for "${text}", typing again`)
  }
  throw new Error(`Could not type ${text}`)
}

// -------------------------------------------------------------- screenshots

/** The plan's proving-artifact names; anything else is a support capture. */
function fileFor(shot: string): string {
  const named: Record<string, string> = {
    home: 'home-offline',
    upcoming: 'schedule-upcoming',
    past: 'schedule-past',
    all: 'schedule-all',
    videos: 'videos-offline',
    team: 'team-offline',
    season: 'season-offline',
    league: 'league-offline',
    game: 'game-offline',
    scoring: 'scoring-offline',
    swapStalled: 'swap-stalled',
    tagStalled: 'tag-stalled',
    addExistingStalled: 'add-existing-stalled',
    refreshStalled: 'refresh-stalled'
  }
  const androidNamed = ['home', 'videos', 'scoring']
  if (PLATFORM === 'ios' && named[shot] != null)
    return `${named[shot]}-${MODE}.png`
  if (PLATFORM === 'android' && androidNamed.includes(shot))
    return `${named[shot]}-android-${MODE}.png`
  return join('support', `${PLATFORM}-${shot}-${MODE}.png`)
}
let lastShot: Buffer | undefined
async function shot(name: string): Promise<Buffer> {
  const file = join(ARTIFACTS, fileFor(name))
  mkdirSync(join(ARTIFACTS, 'support'), { recursive: true })
  lastShot = await m.screenshot()
  writeFileSync(file, lastShot)
  log(`screenshot ${name} -> ${file}`)
  return lastShot
}
async function dumpHierarchy(name: string): Promise<void> {
  const lines = (await nodes())
    .filter(n => label(n) !== '' || (n.id ?? '') !== '')
    .map(
      n =>
        `${n.type ?? ''} #${n.id ?? ''} "${label(n).slice(0, 100)}" ${JSON.stringify(n.bounds)}${n.enabled === false ? ' disabled' : ''}`
    )
  mkdirSync(join(ARTIFACTS, 'support'), { recursive: true })
  writeFileSync(
    join(ARTIFACTS, 'support', `${PLATFORM}-${name}-${MODE}.hierarchy.txt`),
    lines.join('\n') + '\n'
  )
}

/** The banner is under the tab bar, `#6B3E00`, with white text. */
async function checkBanner(png: Buffer): Promise<void> {
  const all = await nodes()
  const banner = all.find(
    n =>
      n.id === 'offlineBanner' ||
      n.id === 'offlineBannerText' ||
      label(n).startsWith('Offline. Edits will send')
  )
  check(
    'offline banner shows',
    banner != null,
    banner == null
      ? 'none in hierarchy'
      : `"${label(banner)}" at ${JSON.stringify(banner.bounds)}`
  )
  if (banner?.bounds == null) return
  const tabs = all.filter(
    n =>
      /^(Home|Videos|Schedule|Search|Chat)$/.test(label(n)) &&
      inTabBar(n) &&
      n.bounds != null
  )
  const tabBottom = Math.max(...tabs.map(n => n.bounds!.y + n.bounds!.height))
  check(
    'banner is below the tab bar',
    tabs.length > 0 && banner.bounds.y >= tabBottom - 4,
    `banner y ${banner.bounds.y}, tab bar bottom ${tabBottom}`
  )
  const image = PNG.sync.read(png)
  const scale = image.width / screen.width
  const b = banner.bounds
  const counts = new Map<string, number>()
  let white = 0
  let total = 0
  for (
    let y = Math.floor(b.y * scale);
    y < Math.min(image.height, (b.y + b.height) * scale);
    y += 2
  )
    for (
      let x = Math.floor(b.x * scale);
      x < Math.min(image.width, (b.x + b.width) * scale);
      x += 2
    ) {
      const i = (y * image.width + x) * 4
      const [r, g, bl] = [image.data[i], image.data[i + 1], image.data[i + 2]]
      total++
      if (r > 225 && g > 225 && bl > 225) white++
      const key = [r, g, bl].map(v => Math.round(v / 8) * 8).join(',')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  const dominant =
    [...counts.entries()].sort((a, c) => c[1] - a[1])[0]?.[0] ?? ''
  const rgb = dominant.split(',').map(Number)
  const near =
    rgb.length === 3 && rgb.every((v, i) => Math.abs(v - BANNER_RGB[i]) <= 20)
  check('banner background is #6B3E00', near, `dominant rgb(${dominant})`)
  check(
    'banner text is white',
    white > total * 0.01,
    `${white} of ${total} sampled pixels white`
  )
}

// ---------------------------------------------------------------- the steps

async function signIn(): Promise<void> {
  const start = await waitFor(/^Sign in to TeamStation$|^Your Home$/, 30000)
  if (start != null && label(start) === 'Your Home') {
    log('already signed in')
    return
  }
  const fields = async (): Promise<Node[]> =>
    (await nodes()).filter(
      n => /TextField|EditText/.test(n.type ?? '') && onScreen(n)
    )
  await fill((await fields())[0], FIXTURE.email, /E-mail address/)
  const asked = new Date(Date.now() - 5000).toISOString()
  await tap(/^Send me a sign-in code$/)
  await waitFor(/^Sign-in code$|^123456$/, 15000)
  await setSignInCode(asked)
  const codeField = (await fields())[1]
  // A complete six-digit code signs in by itself.
  await tapNode(codeField)
  await pause(400)
  await type(SIGN_IN_CODE)
  if ((await waitFor(/^Your Home$/, 5000)) == null) {
    await m.hideKeyboard().catch(() => undefined)
    await pause(800)
    const codeY = codeField.bounds?.y ?? 0
    const button = (await nodes()).find(
      n => label(n) === 'Sign in' && onScreen(n) && (n.bounds?.y ?? 0) > codeY
    )
    if (button != null) await tapNode(button)
    else await m.tapOn({ id: 'Go', optional: true })
  }
  const home = await waitFor(/^Your Home$/, 30000)
  assert.ok(home != null, 'Sign-in did not reach Home')
  log('signed in with the code set on the seat')
}

async function openFromHome(
  name: RegExp,
  section?: string,
  link?: string
): Promise<Node | undefined> {
  await tab('Home')
  if ((await waitFor(name, link == null ? SLOW : 8000, aboveTabBar)) == null)
    await m
      .scrollUntilVisible({
        element: { text: name.source },
        direction: 'DOWN',
        timeout: 10000
      })
      .catch(() => undefined)
  // A row under the floating tab bar is on screen but cannot take a tap there.
  for (let lift = 0; lift < 3; lift++) {
    if ((await find(name, aboveTabBar)) != null) break
    if ((await find(name)) == null) break
    const x = Math.round(screen.width / 2)
    await m.swipe({
      startX: x,
      startY: Math.round(screen.height * 0.7),
      endX: x,
      endY: Math.round(screen.height * 0.45),
      duration: 500
    })
    await pause(800)
  }
  if (!(await tryTap(name, 3000, aboveTabBar))) {
    if (link == null) return undefined
    // Home's list is not on screen (develop offline): open the screen by its link.
    log(`Home does not list ${name.source}; opening ${link}`)
    if (PLATFORM === 'android')
      // Two installed apps claim teamstation://; name the develop package so no chooser opens.
      execFileSync(
        'adb',
        [
          '-s',
          DEVICE,
          'shell',
          'am',
          'start',
          '-a',
          'android.intent.action.VIEW',
          '-d',
          link,
          APP_ID
        ],
        { stdio: 'ignore' }
      )
    else await m.openLink({ link })
    await pause(1500)
  }
  if (section != null) {
    const pill = await waitFor(
      new RegExp(`^${section}$`),
      SLOW,
      n => aboveTabBar(n) && upper(0.6)(n)
    )
    if (pill != null) {
      await tapNode(pill)
      await pause(1500)
    }
  }
  return await find(/./)
}

async function openUpcomingEvent(): Promise<boolean> {
  await tab('Schedule')
  await tryTap(/^Upcoming$/, 10000, upper(0.4))
  const row = await waitFor(/Offline Owls @ Offline Falcons/, SLOW, aboveTabBar)
  if (row == null) return false
  await tapNode(row)
  return (await waitFor(/^Score$/, SLOW)) != null
}

async function openScoring(): Promise<boolean> {
  if (!(await tryTap(/^Score$/, SLOW))) return false
  const choice = await waitFor(
    /^Full game scoring$|^Open scoring menu$/,
    Math.max(SLOW, 30000)
  )
  if (choice != null && label(choice) === 'Full game scoring')
    await tapNode(choice)
  return (await waitFor(/^Open scoring menu$/, Math.max(SLOW, 45000))) != null
}

async function undoLabel(): Promise<string> {
  const undo = (await nodes()).find(
    n =>
      /^Undo |^Nothing to undo$/.test(label(n)) &&
      (n.type ?? '').includes('Button')
  )
  return undo == null ? '(no Undo control)' : label(undo)
}

/** The game's writes in the order this run entered them, for step 8. */
const entered: Array<'pitch' | 'swap'> = []

async function pitch(): Promise<string> {
  const before = await undoLabel()
  await tap(
    /^Ball$/,
    15000,
    n => (n.type ?? '').includes('Button') || PLATFORM === 'android'
  )
  entered.push('pitch')
  await pause(800)
  const after = await undoLabel()
  log(`pitch Ball: undo control "${before}" -> "${after}"`)
  return after
}

// ----------------------------------------------------- swap screen recording

/** How long after the tap the sheet must be gone and the sides exchanged. */
const SWAP_MS = 1000
/** When after the tap the scorer is taken as settled, to compare frames with. */
const SETTLED_MS = 2500
/** Seconds the Android recording runs; it stops by itself. */
const ANDROID_CLIP_S = 5

/**
 * A recording around one Confirm Swap, every frame timed on this Mac's
 * clock, as is the tap: Android's `screenrecord` streams H.264 here and
 * each frame is timed as its first bytes arrive; the iPhone is recorded
 * here over USB (`iosScreenRecord.swift`), each frame timed by its capture.
 * Either way a frame is timed no earlier than it was drawn, and the tap no
 * later than it landed, so the time between them is never short.
 */
interface Clip {
  /** The movie under `<artifacts>/support/`: `.h264` (Android) or `.mov`. */
  file: string
  /** Each frame's index and its time on this Mac's clock, epoch ms. */
  framesCsv: string
  child: ChildProcess
  /** Android: the stream as it arrived, each chunk with its arrival time. */
  chunks?: Array<{ at: number; data: Buffer }>
}

/** The Mac's recorder of the iPhone screen, built once from its source. */
function iosRecorder(): string {
  const source = resolve('scripts/e2e/offlineDevice/iosScreenRecord.swift')
  const bin = join(tmpdir(), 'offlineDevice-iosScreenRecord')
  if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(source).mtimeMs)
    execFileSync('swiftc', ['-O', source, '-o', bin], { stdio: 'inherit' })
  return bin
}
/** The iPhone's name, which its USB screen capture device carries. */
function iosName(): string {
  const out = join(tmpdir(), `offlineDevice-devices-${process.pid}.json`)
  execFileSync(
    'xcrun',
    ['devicectl', 'list', 'devices', '--json-output', out],
    {
      stdio: 'ignore'
    }
  )
  const listed = JSON.parse(readFileSync(out, 'utf8')) as {
    result: {
      devices: Array<{
        hardwareProperties: { udid?: string }
        deviceProperties: { name?: string }
      }>
    }
  }
  rmSync(out)
  const name = listed.result.devices.find(
    d => d.hardwareProperties.udid === DEVICE
  )?.deviceProperties.name
  if (name == null) throw new Error(`devicectl does not list ${DEVICE}`)
  return name
}

async function startClip(name: string): Promise<Clip> {
  mkdirSync(join(ARTIFACTS, 'support'), { recursive: true })
  const base = join(ARTIFACTS, 'support', `${PLATFORM}-${name}-${MODE}`)
  const framesCsv = `${base}.frames.csv`
  if (PLATFORM === 'android') {
    const chunks: Array<{ at: number; data: Buffer }> = []
    const child = spawn(
      'adb',
      [
        '-s',
        DEVICE,
        'exec-out',
        'screenrecord',
        '--output-format=h264',
        '--time-limit',
        String(ANDROID_CLIP_S),
        '--bit-rate',
        '12000000',
        '-'
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    child.stdout?.on('data', (data: Buffer) => {
      chunks.push({ at: Date.now(), data })
    })
    const started = Date.now()
    while (chunks.length === 0 && Date.now() - started < 5000) await pause(50)
    if (chunks.length === 0)
      throw new Error('screenrecord sent nothing within 5 s')
    await pause(500)
    return { file: `${base}.h264`, framesCsv, child, chunks }
  }
  const capture = iosCapture
  if (capture == null) throw new Error('the iPhone screen capture is not open')
  capture.child.stdin?.write(`start ${base}.mov ${framesCsv}\n`)
  await capture.next(/^recording$/)
  await pause(500)
  return { file: `${base}.mov`, framesCsv, child: capture.child }
}

/**
 * The iPhone's screen capture, open from before the driver connects to the
 * end of the run: opening it moves the phone's USB to another
 * configuration, which drops every connection to the phone open then.
 */
interface IosCapture {
  child: ChildProcess
  /** The next line the recorder says that matches `re`. */
  next: (re: RegExp) => Promise<string>
}
let iosCapture: IosCapture | undefined
async function openIosCapture(): Promise<void> {
  const child = spawn(iosRecorder(), [iosName()], {
    stdio: ['pipe', 'pipe', 'inherit']
  })
  const waiting: Array<{
    re: RegExp
    resolve: (line: string) => void
    reject: (error: Error) => void
  }> = []
  let said = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    said += chunk.toString()
    const lines = said.split('\n')
    said = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('error')) waiting.shift()?.reject(new Error(line))
      const at = waiting.findIndex(w => w.re.test(line))
      if (at >= 0) waiting.splice(at, 1)[0].resolve(line)
    }
  })
  child.on('exit', code => {
    for (const w of waiting.splice(0))
      w.reject(new Error(`the iPhone recorder exited ${code}`))
  })
  const next = async (re: RegExp): Promise<string> =>
    await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the iPhone recorder never said ${re.source}`))
      }, 30000)
      waiting.push({
        re,
        resolve: line => {
          clearTimeout(timer)
          resolve(line)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        }
      })
    })
  iosCapture = { child, next }
  log(`iPhone screen capture open: ${await next(/^ready /)}`)
  // The phone's connections come back on its new USB configuration.
  await pause(5000)
}
function closeIosCapture(): void {
  const capture = iosCapture
  iosCapture = undefined
  capture?.child.stdin?.end()
}

/**
 * The frames of an H.264 stream and the arrival time of each: a frame
 * starts at a slice NAL unit (type 1 or 5) whose first macroblock is 0.
 */
function h264Frames(chunks: Array<{ at: number; data: Buffer }>): {
  stream: Buffer
  times: number[]
} {
  const stream = Buffer.concat(chunks.map(c => c.data))
  const ends: number[] = []
  let total = 0
  for (const c of chunks) ends.push((total += c.data.length))
  const times: number[] = []
  let chunk = 0
  for (let i = 0; i + 4 < stream.length; i++) {
    if (stream[i] !== 0 || stream[i + 1] !== 0 || stream[i + 2] !== 1) continue
    const type = stream[i + 3] & 0x1f
    if ((type === 1 || type === 5) && (stream[i + 4] & 0x80) !== 0) {
      while (ends[chunk] <= i) chunk++
      times.push(chunks[chunk].at)
    }
    i += 2
  }
  return { stream, times }
}

async function stopClip(clip: Clip, name: string): Promise<number[]> {
  const ended = new Promise<void>(resolve => {
    if (clip.child.exitCode != null) resolve()
    else
      clip.child.on('exit', () => {
        resolve()
      })
  })
  if (PLATFORM === 'ios') {
    iosCapture?.child.stdin?.write('stop\n')
    await iosCapture?.next(/^stopped /)
  } else await Promise.race([ended, pause((ANDROID_CLIP_S + 10) * 1000)])
  let times: number[]
  if (clip.chunks != null) {
    const read = h264Frames(clip.chunks)
    writeFileSync(clip.file, read.stream)
    times = read.times
    writeFileSync(
      clip.framesCsv,
      times.map((t, i) => `${i},${t}`).join('\n') + '\n'
    )
  } else
    times = readFileSync(clip.framesCsv, 'utf8')
      .trim()
      .split('\n')
      .map(line => Number(line.split(',')[1]))
  log(`recording ${name} -> ${clip.file} (${times.length} frames)`)
  return times
}

interface Frames {
  width: number
  height: number
  /** Each frame, gray, at a quarter of the movie's size. */
  pixels: Buffer[]
}
function readFrames(file: string): Frames {
  const input = file.endsWith('.h264')
    ? ['-f', 'h264', '-i', file]
    : ['-i', file]
  const [width, height] = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      ...input.slice(input.length - 1)
    ],
    { encoding: 'utf8' }
  )
    .trim()
    .split(',')
    .map(n => Math.floor(Number(n) / 4))
  const raw = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      ...input,
      '-fps_mode',
      'passthrough',
      '-vf',
      `scale=${width}:${height},format=gray`,
      '-f',
      'rawvideo',
      '-'
    ],
    { maxBuffer: 1 << 30 }
  )
  const size = width * height
  const pixels: Buffer[] = []
  for (let at = 0; at + size <= raw.length; at += size)
    pixels.push(raw.subarray(at, at + size))
  return { width, height, pixels }
}

interface Region {
  x: number
  y: number
  width: number
  height: number
}
/** A hierarchy rectangle in the quarter-size frame's pixels. */
function inFrame(b: Region, frames: Frames): Region {
  const scale = frames.width / screen.width
  const x = Math.max(0, Math.floor(b.x * scale))
  const y = Math.max(0, Math.floor(b.y * scale))
  return {
    x,
    y,
    width: Math.max(1, Math.min(frames.width - x, Math.ceil(b.width * scale))),
    height: Math.max(
      1,
      Math.min(frames.height - y, Math.ceil(b.height * scale))
    )
  }
}
/** Mean absolute gray difference of two frames inside a region. */
function differ(a: Buffer, b: Buffer, r: Region, width: number): number {
  let sum = 0
  let count = 0
  for (let y = r.y; y < r.y + r.height; y++)
    for (let x = r.x; x < r.x + r.width; x++) {
      sum += Math.abs(a[y * width + x] - b[y * width + x])
      count++
    }
  return count === 0 ? 0 : sum / count
}

interface SwapTiming {
  /** ms from the tap to the first frame with the swap drawn. */
  ms?: number
  detail: string
}

/**
 * Reads the recording around one Confirm Swap. The last frame by 2.5 s
 * after the tap is the settled scorer. The swap is drawn at the
 * first frame after the tap in which the sheet's area, the scoreboard and
 * every fielder's nameplate (the old side's and the new side's) each match
 * that settled frame, within 8% of how far it was from it before the tap.
 * Saves that frame, and the last one before the tap.
 */
function swapTiming(
  clip: Clip,
  times: number[],
  name: string,
  areas: { sheet: Region; scoreboard: Region; plates: Region[] },
  tapSentAt: number
): SwapTiming {
  const frames = readFrames(clip.file)
  const n = frames.pixels.length
  if (n !== times.length)
    return {
      detail: `the movie has ${n} frames and ${times.length} times; ${clip.file}`
    }
  const before = times.filter(t => t < tapSentAt).length - 1
  if (before < 0 || n - before < 3)
    return {
      detail: `the recording has ${before + 1} frames before the tap and ${n - before - 1} after`
    }
  // The settled scorer: the last frame by 2.5 s after the tap, before
  // anything later (a stalled read's line, a redrawn field) changes it.
  const settledAt = times.reduce(
    (at, t, i) => (t <= tapSentAt + SETTLED_MS ? i : at),
    n - 1
  )
  const last = frames.pixels[Math.max(before + 2, settledAt)]
  const w = frames.width
  const regions = [
    { what: 'the sheet area', r: inFrame(areas.sheet, frames) },
    { what: 'the scoreboard', r: inFrame(areas.scoreboard, frames) },
    ...areas.plates.map((p, i) => ({
      what: `nameplate ${i + 1}`,
      r: inFrame(p, frames)
    }))
  ].map(region => ({
    ...region,
    span: differ(frames.pixels[before], last, region.r, w)
  }))
  const unchanged = regions.filter(
    region =>
      (region.what === 'the sheet area' || region.what === 'the scoreboard') &&
      region.span < 3
  )
  if (
    unchanged.length > 0 ||
    !regions.some(r => r.what.startsWith('name') && r.span >= 3)
  )
    return {
      detail: `the recording does not show the swap: ${regions.map(r => `${r.what} ${r.span.toFixed(1)}`).join(', ')}`
    }
  const done = (i: number): boolean =>
    regions.every(
      region =>
        differ(frames.pixels[i], last, region.r, w) <=
        Math.max(2, region.span * 0.08)
    )
  let swapped = -1
  for (let i = before + 1; i < n && swapped < 0; i++) if (done(i)) swapped = i
  if (swapped < 0) return { detail: 'no frame matches the settled scorer' }
  const ms = Math.round(times[swapped] - tapSentAt)
  const still = (index: number, file: string): void => {
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      ...(clip.file.endsWith('.h264') ? ['-f', 'h264'] : []),
      '-i',
      clip.file,
      '-fps_mode',
      'passthrough',
      '-vf',
      `select=eq(n\\,${index})`,
      '-frames:v',
      '1',
      file
    ])
  }
  const base = join(ARTIFACTS, 'support', `${PLATFORM}-${name}`)
  const frame = `${base}-swapped-${MODE}.png`
  still(swapped, frame)
  still(swapped - 1, `${base}-beforeSwapped-${MODE}.png`)
  still(before, `${base}-tapped-${MODE}.png`)
  const previous = swapped - 1 > before ? swapped - 1 : undefined
  return {
    ms,
    detail: `tap sent at frame ${before}+; the swap is drawn at frame ${swapped} of ${n}, ${ms} ms after the tap was sent${previous == null ? '' : ` (frame ${previous} at ${Math.round(times[previous] - tapSentAt)} ms was not yet)`}; ${clip.file}; ${frame}`
  }
}

// --------------------------------------------------------------------- swap

async function swapSheetText(): Promise<Node | undefined> {
  await tap(/^Open scoring menu$/)
  await tap(/^Swap Home and Away/)
  return await waitFor(/will bat first/, 10000)
}

/** The fielders' nameplates on the scorer ("Sam R"), the fielding side's. */
function fielderNodes(all: Node[]): Node[] {
  return all.filter(
    n =>
      /^[A-Z][a-z]+ [A-Z]$/.test(label(n)) &&
      onScreen(n) &&
      (n.bounds?.y ?? 0) > screen.height * 0.2 &&
      (n.bounds?.y ?? 0) < screen.height * 0.75
  )
}
function fielders(all: Node[]): string[] {
  return [...new Set(fielderNodes(all).map(label))].sort()
}

/** The scorer itself is drawn: its menu, and no "Loading game" in its place. */
function scorerPainted(all: Node[]): boolean {
  return (
    all.some(n => label(n) === 'Open scoring menu') &&
    !all.some(n => label(n).startsWith('Loading game'))
  )
}

/**
 * Whether a picture is drawn in the area under the game's section pills: the
 * share of sampled pixels that are bright or coloured. The fixture's poster
 * is colour bars; a black box with a spinner scores near zero.
 */
function pictureDrawn(
  png: Buffer,
  pills: Node
): { drawn: boolean; share: number } {
  const image = PNG.sync.read(png)
  const scale = image.width / screen.width
  const b = pills.bounds!
  const top = Math.floor((b.y + b.height + 8) * scale)
  const bottom = Math.min(
    image.height,
    Math.floor((b.y + b.height + 8 + screen.height * 0.25) * scale)
  )
  const left = Math.floor(screen.width * 0.05 * scale)
  const right = Math.floor(screen.width * 0.95 * scale)
  let lit = 0
  let total = 0
  for (let y = top; y < bottom; y += 3)
    for (let x = left; x < right; x += 3) {
      const i = (y * image.width + x) * 4
      const [r, g, bl] = [image.data[i], image.data[i + 1], image.data[i + 2]]
      total++
      const max = Math.max(r, g, bl)
      const min = Math.min(r, g, bl)
      if (max - min > 60 || (max > 200 && min > 200)) lit++
    }
  const share = total === 0 ? 0 : lit / total
  return { drawn: share > 0.2, share }
}

/**
 * Opens the past game (the fixture's game with a video) from Past and its
 * Videos section; answers whether the poster is drawn there.
 */
async function openPastGameVideos(name: string): Promise<boolean> {
  await tab('Schedule')
  await tryTap(/^Past$/, 10000, upper(0.4))
  const row = await waitFor(/Offline Owls @ Offline Falcons/, SLOW, aboveTabBar)
  if (row == null) {
    log('no past game row')
    return false
  }
  await tapNode(row)
  const pill = await waitFor(
    /^Videos$/,
    SLOW,
    n =>
      aboveTabBar(n) &&
      upper(0.7)(n) &&
      (n.bounds?.y ?? 0) > screen.height * 0.25
  )
  if (pill == null) {
    log('the past game has no Videos section')
    return false
  }
  await tapNode(pill)
  let drawn = { drawn: false, share: 0 }
  const started = Date.now()
  for (let attempt = 0; attempt < 8 && !drawn.drawn; attempt++) {
    await pause(attempt === 0 ? 2000 : 2500)
    const png = await m.screenshot()
    drawn = pictureDrawn(png, pill)
    log(
      `${name}: picture under the Videos section ${Math.round(drawn.share * 100)}% lit, ${Date.now() - started} ms after opening it`
    )
  }
  await shot(name)
  await dumpHierarchy(name)
  return drawn.drawn
}

interface SwapRead {
  /** From the recording: the tap to the sheet gone and the sides exchanged. */
  timing: SwapTiming
  /** Once settled, the scorer is drawn, not "Loading game". */
  painted: boolean
  /** Once settled, the fielders are the other side's. */
  exchanged: boolean
  before: string[]
  after: string[]
}

/**
 * Confirm Swap, recorded: the recording runs from the open sheet to three
 * seconds after the tap and is saved with the frame where the swap is drawn
 * (`Clip`, `swapTiming`).
 * With `stalledShot`, a screenshot two seconds after the tap. Leaves the
 * sheet closed.
 */
async function confirmSwap(
  name: string,
  stalledShot?: string
): Promise<SwapRead | undefined> {
  const was = await nodes()
  const before = fielders(was)
  const plates = fielderNodes(was)
  const text = await swapSheetText()
  log(
    `swap sheet: "${text == null ? '' : label(text)}"; fielders before: ${before.join(', ')}`
  )
  const confirm = await waitFor(
    /^(Confirm Swap|Reset and Swap)$/,
    10000,
    n => (n.type ?? '').includes('Button') || PLATFORM === 'android'
  )
  if (confirm == null || text == null) {
    log('no Confirm Swap button')
    return undefined
  }
  const button = confirm.bounds!
  const top = Math.min(text.bounds!.y, button.y) - 12
  const sheet = {
    x: 0,
    y: top,
    width: screen.width,
    height: button.y + button.height + 12 - top
  }
  // The scoreboard is drawn, not in the hierarchy: the band under the menu.
  const menu = was.find(n => label(n) === 'Open scoring menu')?.bounds
  const scoreboard = {
    x: 0,
    y: menu == null ? screen.height * 0.15 : menu.y + menu.height,
    width: screen.width,
    height: screen.width * 0.2
  }
  const clip = await startClip(name)
  const tappedAt = Date.now()
  let tapReturned: number | undefined
  try {
    await tapNode(confirm)
    tapReturned = Date.now() - tappedAt
  } finally {
    entered.push('swap')
  }
  if (stalledShot != null) {
    await pause(Math.max(0, 2000 - (Date.now() - tappedAt)))
    const all = await nodes()
    const still = all.find(n =>
      /^(Confirm Swap|Reset and Swap)$/.test(label(n))
    )
    log(
      `two seconds after Confirm Swap: sheet ${still == null ? 'closed' : 'open'}${still?.enabled === false ? ', Confirm Swap disabled (gray)' : ''}; fielders ${fielders(all).join(', ')}`
    )
    await shot(stalledShot)
    await dumpHierarchy(stalledShot)
  }
  await pause(Math.max(0, 3000 - (Date.now() - tappedAt)))
  const times = await stopClip(clip, name)
  const late = await gone(
    /^(Confirm Swap|Reset and Swap)$/,
    MODE === 'before' ? 150000 : 30000
  )
  if (late == null) {
    log('swap sheet still open; cancelling it')
    await tryTap(/^Cancel$/, 3000)
  }
  const settled = await nodes()
  const after = fielders(settled)
  let timing: SwapTiming
  try {
    timing = swapTiming(
      clip,
      times,
      name,
      {
        sheet,
        scoreboard,
        plates: [...plates, ...fielderNodes(settled)].map(p => p.bounds!)
      },
      tappedAt
    )
  } catch (error) {
    timing = {
      detail: `the recording could not be read: ${(error as Error).message}`
    }
  }
  const read: SwapRead = {
    timing,
    painted: scorerPainted(settled),
    exchanged:
      before.length >= 5 &&
      after.length >= 5 &&
      !after.some(n => before.includes(n)),
    before,
    after
  }
  log(
    `Confirm Swap ${name}: ${timing.detail}; the driver's tap call returned ${tapReturned ?? '-'} ms after it was sent; settled fielders ${after.join(', ')}`
  )
  return read
}

/** The checks one Confirm Swap must pass. */
function checkSwap(prefix: string, read: SwapRead | undefined): void {
  check(
    `${prefix}Confirm Swap: in the recording the sheet is gone, the other side is fielding and the scoreboard is exchanged within ${SWAP_MS} ms of sending the tap`,
    read?.timing.ms != null && read.timing.ms <= SWAP_MS,
    read == null ? 'no Confirm Swap button' : read.timing.detail
  )
  check(
    `${prefix}Confirm Swap: the scorer stays drawn, not "Loading game"`,
    read?.painted === true
  )
  check(
    `${prefix}Confirm Swap: the other side is fielding`,
    read?.exchanged === true,
    read == null ? '' : `${read.before.join(', ')} -> ${read.after.join(', ')}`
  )
}

/** The side batting first, as the swap sheet says (then the sheet is cancelled). */
async function battingFirst(): Promise<string | undefined> {
  const text = await swapSheetText()
  await tryTap(/^Cancel$/, 5000)
  await pause(500)
  // The sheet names who will bat first after a swap: the other side bats first now.
  const next = /^(.+?) will bat first/.exec(
    text == null ? '' : label(text)
  )?.[1]
  if (next == null) return undefined
  return next === FIXTURE.teamNames.opened
    ? FIXTURE.teamNames.opponent
    : FIXTURE.teamNames.opened
}

/** Picks the opened team's side of the roster sheet, whichever bats first. */
async function openedTeamSide(): Promise<void> {
  const side = await waitFor(
    new RegExp(`^${FIXTURE.teamNames.opened}$`),
    10000,
    upper(0.3)
  )
  if (side == null) log('no team pill on the roster sheet')
  else {
    await tapNode(side)
    await pause(800)
    log(`roster sheet on ${FIXTURE.teamNames.opened}`)
  }
}

/** Scrolls the roster sheet until Add Existing Player is clear of its footer. */
async function revealAddExisting(): Promise<Node | undefined> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const all = await nodes()
    const row = all.find(
      n => label(n) === 'Add Existing Player' && n.bounds != null
    )
    const footer = all.find(
      n => label(n) === 'Save Rosters' && n.bounds != null
    )
    const footerTop = footer?.bounds?.y ?? screen.height * 0.85
    if (
      row?.bounds != null &&
      row.bounds.y + row.bounds.height / 2 < footerTop - 10 &&
      row.bounds.y > screen.height * 0.25
    )
      return row
    const x = Math.round(screen.width / 2)
    await m.swipe({
      startX: x,
      startY: Math.round(screen.height * 0.65),
      endX: x,
      endY: Math.round(screen.height * 0.4),
      duration: 500
    })
    await pause(700)
  }
  return undefined
}

/**
 * Scoring for steps 6 and 7. Before mode only: develop cannot open the event
 * without the network, so the shape is cleared, scoring is opened online, and
 * `reapply` puts the shape back (a recorded deviation from the plan's order).
 */
async function ensureScoring(
  step: number,
  reapply: () => void
): Promise<boolean> {
  if ((await find(/^Open scoring menu$/)) != null) return true
  if (MODE === 'after') return false
  log(
    `step ${step}: scoring did not open without the network on develop; clearing the shape, opening scoring online, then shaping again (deviation)`
  )
  clearTraffic()
  await m.stopApp({ appId: APP_ID })
  await m.launchApp({ appId: APP_ID })
  await waitFor(/^Your Home$/, 60000)
  const ok = (await openUpcomingEvent()) && (await openScoring())
  reapply()
  await pause(3000)
  return ok
}

async function step1(): Promise<void> {
  log(
    `step 1: device ${DEVICE} at ${IP}; seat ${SEAT.origin}; seat game state: ${gameState().replace(/\n/g, ' ; ')}`
  )
  const before = candidateOnOpened()
  log(
    `${FIXTURE.candidate.name} on ${FIXTURE.teamNames.opened} before the run: ${before}`
  )
  assert.ok(
    before !== 'player',
    `${FIXTURE.candidate.name} already plays on ${FIXTURE.teamNames.opened}: take him off before another run (README)`
  )
  assert.ok(
    networkCall('check').ok,
    `${IP} is not a phone the network commands can shape (network.check)`
  )
  if (APP_FILE !== '') {
    if (PLATFORM === 'ios') {
      try {
        execFileSync(
          'xcrun',
          [
            'devicectl',
            'device',
            'uninstall',
            'app',
            '--device',
            DEVICE,
            APP_ID
          ],
          { stdio: 'ignore' }
        )
      } catch {}
      execFileSync(
        'xcrun',
        ['devicectl', 'device', 'install', 'app', '--device', DEVICE, APP_FILE],
        { stdio: 'ignore', timeout: 600000 }
      )
    } else {
      try {
        execFileSync('adb', ['-s', DEVICE, 'uninstall', APP_ID], {
          stdio: 'ignore'
        })
      } catch {}
      execFileSync('adb', ['-s', DEVICE, 'install', '-r', APP_FILE], {
        stdio: 'ignore',
        timeout: 600000
      })
    }
    log(`installed ${APP_FILE}`)
  }
  await m.launchApp({ appId: APP_ID, stopApp: true })
  log(`launched ${APP_ID}`)
}

/**
 * A schedule read other than Upcoming's: Past, All (a `/events` read with no
 * `when`), Videos, or a team's games.
 */
function scheduleOtherThanUpcoming(path: string): boolean {
  const [route, query = ''] = path.split('?')
  const params = new URLSearchParams(query)
  if (/^\/api\/v1\/teams\/[^/]+\/(games|videos)/.test(route)) return true
  if (/\/videos(\b|$)/.test(route) && !/\/videos\/[^/]+\/stills\//.test(route))
    return true
  if (route !== '/api/v1/events' || params.has('season')) return false
  return params.get('when') !== 'upcoming' || params.get('hasVideo') === '1'
}

let recorderMark = 0
async function step2(): Promise<void> {
  log(
    'step 2: sign in, Upcoming only, then Past, team, season, league, event, scoring, Add Existing'
  )
  await signIn()
  if (MODE === 'after') recorderMark = recorded().length
  await tab('Schedule')
  await tryTap(/^Upcoming$/, 10000, upper(0.4))
  check(
    'Upcoming shows a row online',
    (await waitFor(/Offline Owls @ Offline Falcons/, 20000, aboveTabBar)) !=
      null
  )
  await pause(3000)
  if (MODE === 'after') {
    const lines = recorded().slice(recorderMark)
    const bad = lines.filter(l =>
      scheduleOtherThanUpcoming(l.split(' ')[2] ?? '')
    )
    log(`requests while only Upcoming was open:\n${lines.join('\n')}`)
    check(
      'with Upcoming only, no Past, All, Videos or team-games request',
      bad.length === 0,
      bad.join(' | ')
    )
  } else
    log(
      'request log not read in before mode (TS_REQUEST_RECORD does not exist on develop)'
    )
  await tap(/^Past$/, 10000, upper(0.4))
  check(
    'Past shows a row online',
    (await waitFor(/Offline Owls @ Offline Falcons/, 20000, aboveTabBar)) !=
      null
  )
  // The past game, the one with a video: open it and its Videos section so
  // its poster is drawn (and kept) while online.
  check(
    'online: the past game opens and its Videos section draws the poster',
    await openPastGameVideos('pastVideosOnline')
  )
  await openFromHome(
    new RegExp(`^${FIXTURE.teamNames.opened}`),
    'Schedule',
    `teamstation://teams/${FIXTURE.teams.opened}`
  )
  log(`opened team ${FIXTURE.teamNames.opened} and its Schedule`)
  await openFromHome(
    // The season's own row: on Android a team row's subtitle starts with
    // the season's name too ("Offline Fall Demo · 1–0").
    /^Offline Fall Demo($|, )/,
    'Schedule',
    `teamstation://seasons/${FIXTURE.seasonId}`
  )
  log('opened season Offline Fall Demo and its Schedule')
  await openFromHome(
    /^Offline Demo League$/,
    undefined,
    `teamstation://leagues/${FIXTURE.leagueId}`
  )
  // The league's season row is one control, read as "Open <season>".
  const league = await waitFor(/^Open Offline Fall Demo$/, 20000, upper(0.8))
  check('the league opens online', league != null)
  await shot('leagueOnline')
  assert.ok(await openUpcomingEvent(), 'The upcoming event did not open online')
  log('opened the upcoming event')
  assert.ok(await openScoring(), 'Scoring did not open online')
  log('opened scoring')
  await tap(/^Open scoring menu$/)
  await tap(/^Set Team Rosters$/)
  await openedTeamSide()
  const addRow = await revealAddExisting()
  assert.ok(addRow != null, 'Add Existing Player is not reachable')
  await tapNode(addRow)
  await pause(700)
  const search = await waitFor(/^Search players$/, 15000)
  assert.ok(search != null, 'Add Existing did not open online')
  await tapNode(search)
  await type(CANDIDATE_SEARCH)
  const found = await waitFor(
    new RegExp(`^Choose ${CANDIDATE_SHORT}\\b`),
    20000
  )
  check(
    `online Add Existing search "${CANDIDATE_SEARCH}" lists ${FIXTURE.candidate.name}`,
    found != null
  )
  await m.hideKeyboard().catch(() => undefined)
  await tryTap(/^Cancel$/, 5000)
  await tryTap(/^Cancel$/, 5000)
  if (MODE === 'after') {
    const lines = recorded().slice(recorderMark)
    const unopened = lines.filter(
      l => l.includes(FIXTURE.teams.unopened) && /games|schedule|events/.test(l)
    )
    check(
      `no games request for the unopened team ${FIXTURE.teamNames.unopened}`,
      unopened.length === 0,
      unopened.join(' | ')
    )
  }
}

async function step3(): Promise<void> {
  log('step 3: drop the traffic')
  dropTraffic()
}

async function step4(): Promise<void> {
  log('step 4: stop the app and launch it')
  await m.stopApp({ appId: APP_ID })
  await pause(1500)
  await m.launchApp({ appId: APP_ID })
  await pause(8000)
}

async function step5(): Promise<void> {
  log('step 5: the loaded screens with the network dropped')
  // Home
  const homeAt = Date.now()
  const home = await waitFor(
    new RegExp(`^${FIXTURE.teamNames.opened}`),
    MODE === 'before' ? 150000 : 20000
  )
  log(`Home team name after ${Math.round((Date.now() - homeAt) / 1000)} s`)
  check('Home hierarchy contains the team name', home != null)
  await pause(2000)
  const homePng = await shot('home')
  await dumpHierarchy('home')
  await checkBanner(homePng)
  // Schedule: Upcoming, Past, All
  await tab('Schedule')
  for (const [pill, name] of [
    ['Upcoming', 'upcoming'],
    ['Past', 'past'],
    ['All', 'all']
  ] as const) {
    const opened = await tryTap(new RegExp(`^${pill}$`), 10000, upper(0.4))
    const rows = async (): Promise<Node[]> =>
      (await nodes()).filter(
        n =>
          label(n).includes('Offline Owls @ Offline Falcons') &&
          aboveTabBar(n) &&
          onScreen(n) &&
          (n.type ?? '').includes('Button')
      )
    await waitFor(/Offline Owls @ Offline Falcons/, SLOW, aboveTabBar)
    await pause(1500)
    const shown = await rows()
    if (pill === 'All')
      check(
        'All (never opened) shows the upcoming and the past game',
        shown.length >= 2,
        `${shown.length} rows; tab ${opened ? 'opened' : 'missing'}`
      )
    else
      check(
        `${pill} shows a row from the request that tab made`,
        shown.length >= 1,
        `${shown.length} rows`
      )
    await shot(name)
    await dumpHierarchy(name)
  }
  // Videos
  await tab('Videos')
  const video = await waitFor(
    /video/,
    SLOW,
    n => aboveTabBar(n) && label(n).includes('Offline Owls @ Offline Falcons')
  )
  check(
    'Videos (never opened) shows the past game with its video',
    video != null
  )
  await pause(1500)
  await shot('videos')
  await dumpHierarchy('videos')
  // Team, unopened team, season, league
  await openFromHome(
    new RegExp(`^${FIXTURE.teamNames.opened}`),
    'Schedule',
    `teamstation://teams/${FIXTURE.teams.opened}`
  )
  await waitFor(/vs Offline Owls/, SLOW)
  const teamRows = (await nodes()).filter(
    n => label(n).includes('vs Offline Owls') && onScreen(n)
  )
  check(
    'the opened team opens and shows its schedule',
    teamRows.length >= 1,
    `${teamRows.length} schedule rows`
  )
  await shot('team')
  await dumpHierarchy('team')
  await openFromHome(
    new RegExp(`^${FIXTURE.teamNames.unopened}$`),
    'Schedule',
    `teamstation://teams/${FIXTURE.teams.unopened}`
  )
  const heronRows = (await nodes()).filter(
    n =>
      /vs |@ /.test(label(n)) &&
      (n.type ?? '').includes('Button') &&
      aboveTabBar(n) &&
      upper(0.8)(n)
  )
  check(
    'the unopened team has no stored games',
    heronRows.length === 0,
    `${heronRows.length} game rows`
  )
  await shot('unopenedTeam')
  await dumpHierarchy('unopenedTeam')
  await openFromHome(
    // The season's own row: on Android a team row's subtitle starts with
    // the season's name too ("Offline Fall Demo · 1–0").
    /^Offline Fall Demo($|, )/,
    'Schedule',
    `teamstation://seasons/${FIXTURE.seasonId}`
  )
  const seasonOpen = await waitFor(/^Offline Fall Demo$/, SLOW)
  await pause(3000)
  const seasonRows = (await nodes()).filter(
    n =>
      /Offline Owls @ Offline Falcons|Offline Falcons/.test(label(n)) &&
      (n.type ?? '').includes('Button') &&
      upper(0.82)(n) &&
      (n.bounds?.y ?? 0) > screen.height * 0.4
  )
  check(
    'the season opens and shows its schedule',
    seasonOpen != null && seasonRows.length >= 1,
    `${seasonRows.length} rows`
  )
  await shot('season')
  await dumpHierarchy('season')
  await openFromHome(
    /^Offline Demo League$/,
    undefined,
    `teamstation://leagues/${FIXTURE.leagueId}`
  )
  await pause(MODE === 'before' ? 30000 : 2000)
  check(
    'the league opens',
    (await waitFor(/^Offline Demo League$/, 5000, upper(0.3))) != null &&
      (await waitFor(/^Open Offline Fall Demo$/, 5000, upper(0.8))) != null
  )
  await shot('league')
  await dumpHierarchy('league')
  // The past game's event page and its Videos section: the poster drawn
  // from the stored picture, not a black box with a spinner.
  check(
    'the past game opens and its Videos section draws the stored poster',
    await openPastGameVideos('game')
  )
  // Event and scoring
  const event = await openUpcomingEvent()
  check('the upcoming event opens', event)
  await pause(1500)
  await shot('upcomingEvent')
  await dumpHierarchy('upcomingEvent')
  const scoring = event && (await openScoring())
  check('scoring opens on that event', scoring)
  await pause(2000)
  await shot('scoring')
  await dumpHierarchy('scoring')
}

async function step6(): Promise<void> {
  log('step 6: with the network dropped, a pitch, Confirm Swap, the next pitch')
  if (
    !(await ensureScoring(6, () => {
      dropTraffic()
    }))
  ) {
    log('scoring is not open; step 6 cannot run')
    check('scoring is open for step 6', false)
    return
  }
  const first = await battingFirst()
  log(`batting first before the swap: ${first}`)
  await pitch()
  checkSwap('', await confirmSwap('swapOfflineRecording'))
  await shot('swapOffline')
  const after = await battingFirst()
  check(
    'the sides are exchanged',
    first != null && after != null && after !== first,
    `${first} -> ${after}`
  )
  const next = await pitch()
  check('the next pitch is taken', next.startsWith('Undo '), next)
  await shot('afterSwapPitchOffline')
}

async function step7(): Promise<void> {
  log('step 7: stalled link (30000 ms)')
  if (
    !(await ensureScoring(7, () => {
      stallTraffic(30000)
    }))
  ) {
    check('scoring is open for step 7', false)
    return
  }
  // Scoring's own offline line appears only once the request deadline has
  // passed on a stalled link. From fully online: the line gone, then the
  // stall, then a pitch whose send stalls. A hierarchy read takes 6–8 s on
  // the iPhone, too coarse to place the line against a 10 s deadline, so the
  // line is timed by screenshots (a few hundred ms each) of the band across
  // the top of the scorer where it draws: a light pill on the dark scorer.
  const lineLit = (png: Buffer): number => {
    const image = PNG.sync.read(png)
    const top = Math.floor(image.height * 0.065)
    const bottom = Math.floor(image.height * 0.105)
    let lit = 0
    let total = 0
    for (let y = top; y < bottom; y += 2)
      for (
        let x = Math.floor(image.width * 0.08);
        x < image.width * 0.92;
        x += 2
      ) {
        const i = (y * image.width + x) * 4
        total++
        if (
          image.data[i] > 215 &&
          image.data[i + 1] > 215 &&
          image.data[i + 2] > 205
        )
          lit++
      }
    return total === 0 ? 0 : lit / total
  }
  clearTraffic()
  let online = false
  let litNow = 1
  const clearedAt = Date.now()
  while (!online && Date.now() - clearedAt < 120000) {
    litNow = lineLit(await m.screenshot())
    online = litNow < 0.3
    if (!online) await pause(1000)
  }
  log(
    `offline line ${online ? 'gone' : 'STILL SHOWN'} ${Math.round((Date.now() - clearedAt) / 1000)} s after the shape was cleared (band ${litNow.toFixed(2)} lit)`
  )
  // The writes queued while the phone was dropped go out now. A send still in
  // flight when the link stalls hits its own deadline and shows the line early,
  // so wait until the seat has every swap entered so far and the game's writes
  // have stopped arriving.
  if (MODE === 'after') {
    const writes = (): string[] =>
      recorded().filter(
        l =>
          l.includes(`/games/${FIXTURE.upcomingGameId}/`) &&
          /^\S+\s+(POST|PUT|DELETE)\s/.test(l)
      )
    const swaps = entered.filter(kind => kind === 'swap').length
    let last = -1
    let quietSince = Date.now()
    const drainStarted = Date.now()
    while (Date.now() - drainStarted < 120000) {
      const now = writes()
      if (now.length !== last) {
        last = now.length
        quietSince = Date.now()
      }
      const arrivedSwaps = now.filter(l => /\/swap-sides\b/.test(l)).length
      if (arrivedSwaps >= swaps && Date.now() - quietSince >= 6000) break
      await pause(2000)
    }
    log(
      `queued writes drained ${Math.round((Date.now() - drainStarted) / 1000)} s after the line went: ${last} writes to the game at the seat, ${swaps} swaps entered`
    )
  }
  // The deadline is timed from a quiet phone: nothing of the app's in flight
  // when the link stalls, or a request sent before the pitch hits its own
  // deadline first. The seat logs each request as it ends, so the app is
  // idle once the log has had no new line for QUIET_MS.
  const QUIET_MS = 8000
  {
    let count = recorded().length
    let quietSince = Date.now()
    const waitStarted = Date.now()
    while (Date.now() - quietSince < QUIET_MS) {
      if (Date.now() - waitStarted > 120000) break
      await pause(1000)
      const now = recorded().length
      if (now !== count) {
        count = now
        quietSince = Date.now()
      }
    }
    log(
      `seat request log ${Date.now() - quietSince >= QUIET_MS ? 'quiet' : 'STILL BUSY'} for ${Math.round((Date.now() - quietSince) / 1000)} s before the stall (${count} lines, waited ${Math.round((Date.now() - waitStarted) / 1000)} s)`
    )
  }
  // Ball is found first: a hierarchy read takes seconds, which would come
  // between the stall and the pitch.
  const ball = await waitFor(
    /^Ball$/,
    15000,
    n => (n.type ?? '').includes('Button') || PLATFORM === 'android'
  )
  if (ball == null) throw new Error('no Ball button for the stalled pitch')
  stallTraffic(30000)
  const stalledAt = Date.now()
  await tapNode(ball)
  const pitchedAt = Date.now()
  entered.push('pitch')
  log(`stalled pitch tapped ${pitchedAt - stalledAt} ms after the stall`)
  const samples: Array<{ stall: number; pitch: number; lit: number }> = []
  let firstShown: (typeof samples)[number] | undefined
  while (Date.now() - stalledAt < 45000) {
    const at = Date.now()
    const png = await m.screenshot()
    const sample = {
      stall: at - stalledAt,
      pitch: at - pitchedAt,
      lit: lineLit(png)
    }
    samples.push(sample)
    if (sample.lit > 0.5 && firstShown == null) {
      firstShown = sample
      writeFileSync(
        join(
          ARTIFACTS,
          'support',
          `${PLATFORM}-offlineLineFirstShown-${MODE}.png`
        ),
        png
      )
    }
    if (firstShown != null && sample.stall > firstShown.stall + 2000) break
  }
  const early = samples.filter(r => r.stall < 9000)
  // What the band shows is scoring's offline line: on Android its text is in
  // the hierarchy; on iOS only its id is.
  const lineNode = (await nodes()).find(
    n =>
      upper(0.15)(n) &&
      (label(n) === OFFLINE_LINE || n.id === 'scoringSaveStatus')
  )
  log(
    `the lit band is ${lineNode == null ? 'NOT' : `"${label(lineNode)}" (${lineNode.id ?? ''})`}, scoring's own line`
  )
  log(
    `offline line after the stall (screenshots asked, ms after the stall / after the pitch: share of the band lit): ${samples.map(r => `${r.stall}/${r.pitch}:${r.lit.toFixed(2)}`).join(' ')}`
  )
  log(
    firstShown == null
      ? 'offline line never shown within 45 s of the stall'
      : `offline line first shown ${firstShown.stall} ms after the stall, ${firstShown.pitch} ms after the pitch`
  )
  // What the phone had asked the seat for around the stall: a request in
  // flight when the link stalls reaches its own deadline from when it began.
  // The recorder notes each request by when it arrived, once it is answered.
  if (MODE === 'after') {
    const from = new Date(stalledAt - 20000).toISOString()
    const to = new Date(stalledAt + 15000).toISOString()
    const near = recorded().filter(l => {
      const at = l.split(' ')[0] ?? ''
      return at >= from && at <= to
    })
    log(
      `requests the seat saw from 20 s before the stall to 15 s after it (stall at ${new Date(stalledAt).toISOString()}):\n${near
        .map(l => {
          const [at, ...rest] = l.split(' ')
          return `${((Date.parse(at) - stalledAt) / 1000).toFixed(1)}s ${rest.join(' ')}`
        })
        .join('\n')}`
    )
  }
  check(
    "stalled: scoring's offline line is absent until 9 s after the stall",
    online && early.length > 0 && early.every(r => r.lit < 0.5),
    `${early.length} screenshots before 9 s from the stall, last at ${early.at(-1)?.stall ?? '-'} ms, ${early.filter(r => r.lit >= 0.5).length} with the line`
  )
  check(
    "stalled: scoring's own offline line shows by 13 s after the pitch",
    firstShown != null && firstShown.pitch <= 13000,
    firstShown == null
      ? 'never shown within 45 s'
      : `first shown ${firstShown.stall} ms after the stall, ${firstShown.pitch} ms after the pitch`
  )
  await shot('offlineLineStalled')

  // The stalled swap must land away from the base build's stalled picture,
  // which has the opened team fielding: bring the opponent onto the field
  // first if it is not there, then swap on the stalled link.
  const battingNow = await battingFirst()
  if (battingNow === FIXTURE.teamNames.opened) {
    log(
      `${battingNow} bat first: a stalled swap first, so the measured one puts them up`
    )
    await pitch()
    checkSwap(
      'stalled (first): ',
      await confirmSwap('swapStalledFirstRecording')
    )
  }
  await pitch()
  const closed = await confirmSwap('swapStalledRecording', 'swapStalled')
  checkSwap('stalled: ', closed)
  const battingAfter = await battingFirst()
  check(
    `stalled: after the swap ${FIXTURE.teamNames.opened} bat first`,
    battingAfter === FIXTURE.teamNames.opened,
    `${battingAfter}`
  )

  // Event tag
  // A reset swap leaves no play to tag, and its Undo is the roster's
  // ("Undo Roster changed"): always enter a pitch, the play to tag.
  const tagged = await pitch()
  check('stalled: a pitch to tag is taken', tagged.startsWith('Undo '), tagged)
  const undo = (await nodes()).find(
    n => label(n).startsWith('Undo ') && (n.type ?? '').includes('Button')
  )
  if (PLATFORM === 'android')
    // On Android the tag history never opens from a hold on Undo, on the base
    // build as well, and there is no other way in: not this branch's change.
    log(
      'tag: skipped: pre-existing, history does not open on Android (a hold on Undo opens nothing, on develop as well)'
    )
  else if (undo == null) log('no Undo control to hold for the tag editor')
  else {
    await tapNode(undo, 2200)
    // One read of the screen takes 6–8 s on the iPhone: poll for the
    // history and its first row well past that.
    const prompt = await waitFor(/^Tap event to assign a tag\.$/, 30000)
    const row = await waitFor(/^Tag event: /, 30000)
    log(
      `tag history ${prompt == null ? 'did not open' : 'open'}; first row "${row == null ? '' : label(row)}"`
    )
    if (row != null) {
      await tapNode(row)
      const field = await waitFor(/^New tag$/, 15000)
      if (field != null) {
        await tapNode(field)
        await type(TAG)
        // No hideKeyboard: on iOS it swipes down, which dismisses the sheet.
        // The sheet rides above the keyboard, so Save tag is on screen.
        const save = await waitFor(/^Save tag$/, 5000)
        if (save == null)
          log(
            'no Save tag button above the keyboard; pressing Enter (the field saves on submit)'
          )
        {
          const savedAt = Date.now()
          if (save != null) await tapNode(save)
          else await m.pressKey({ key: 'Enter' })
          const closed = await gone(
            /^(Save tag|Saving tag…|New tag)$/,
            1000,
            undefined,
            savedAt
          )
          check(
            'stalled: saving an event tag closes the editor at once',
            closed != null,
            closed == null ? 'editor open after 1 s' : `${closed} ms`
          )
          await pause(Math.max(0, 2000 - (closed ?? 1000)))
          const saving = await find(/^Saving tag…$/)
          log(
            `two seconds after Save tag: ${saving != null ? '"Saving tag…" shown, editor open' : 'no "Saving tag…"'}`
          )
          await shot('tagStalledClosed')
          await dumpHierarchy('tagStalledClosed')
          if (closed == null) {
            const late = await gone(
              /^(Save tag|Saving tag…)$/,
              MODE === 'before' ? 150000 : 30000
            )
            log(
              late == null
                ? 'tag editor still open; cancelling'
                : `tag editor closed ${late} ms later`
            )
            if (late == null) await tryTap(/^Cancel$/, 3000)
          }
        }
      } else log('tag editor did not open')
    }
    // The saved tag, where the scorer shows it: reopen the history and find
    // the tag on its play.
    if ((await find(/^Tap event to assign a tag\.$/)) == null) {
      const again = (await nodes()).find(
        n => label(n).startsWith('Undo ') && (n.type ?? '').includes('Button')
      )
      if (again != null) await tapNode(again, 2200)
    }
    await waitFor(/^Tap event to assign a tag\.$/, 30000)
    const shown = await waitFor(new RegExp(`\\b${TAG}\\b`, 'i'), 30000)
    check(
      `stalled: the saved tag "${TAG}" shows on its play in the history`,
      shown != null,
      shown == null
        ? 'not in the history'
        : `"${label(shown)}" at y ${shown.bounds?.y}`
    )
    await shot('tagStalled')
    await dumpHierarchy('tagStalled')
    await tryTap(/^Tap event to assign a tag\.$/, 1000).catch(() => undefined)
    if ((await find(/^Tap event to assign a tag\.$/)) != null)
      await m.tapOnPoint({ x: 20, y: Math.round(screen.height * 0.25) })
  }

  // Defensive sheet Refresh
  const fielder = (await nodes()).find(
    n =>
      /^[A-Z][a-z]+ [A-Z]$/.test(label(n)) &&
      onScreen(n) &&
      (n.bounds?.y ?? 0) > screen.height * 0.2 &&
      (n.bounds?.y ?? 0) < screen.height * 0.7
  )
  if (fielder == null) log('no fielder nameplate to open the defensive sheet')
  else {
    await tapNode(fielder)
    const sheet = await waitFor(
      /^Assign (pitcher|catcher|first base|second base|shortstop|third base|left field|center field|right field)$/,
      10000
    )
    log(`defensive sheet: ${sheet == null ? 'did not open' : label(sheet)}`)
    if (sheet != null) {
      // The sheet's Refresh: Create Player, then cancel it, reads the game
      // again behind the sheet. On iOS the Create Player sheet, a sheet over a
      // sheet, is not in the hierarchy; its backdrop above it cancels it the
      // same way its Cancel does, so the tap goes there, by position.
      await tap(
        /^Create Player$/,
        10000,
        n => (n.bounds?.y ?? 0) > screen.height * 0.5
      )
      await pause(1500)
      await shot('createPlayerOpen')
      const cancel = (await nodes())
        .filter(n => label(n) === 'Cancel' && onScreen(n))
        .sort((a, b) => (b.bounds?.y ?? 0) - (a.bounds?.y ?? 0))
      const sheetTop = sheet.bounds?.y ?? screen.height
      const nested = cancel.find(
        n => Math.abs((n.bounds?.y ?? 0) - sheetTop) > 30
      )
      if (nested != null) {
        log(
          `Create Player's Cancel is in the hierarchy at y ${nested.bounds?.y}`
        )
        await tapNode(nested)
      } else {
        log(
          "Create Player's sheet is not in the hierarchy; tapping its backdrop at the top of the screen"
        )
        await m.tapOnPoint({
          x: Math.round(screen.width / 2),
          y: Math.round(screen.height * 0.12)
        })
      }
      await pause(1500)
      const all = await nodes()
      const refreshing = all.find(n => /^Refreshing game\.\.\.$/.test(label(n)))
      // The sheet's own controls: the pitch buttons behind a sheet are
      // always off while it is up, as they are under every sheet.
      const choices = all.filter(
        n =>
          label(n).startsWith('Assign ') &&
          (n.type ?? '').includes('Button') &&
          onScreen(n)
      )
      const off = choices.filter(n => n.enabled === false)
      const create = all.find(
        n => label(n) === 'Create Player' && (n.type ?? '').includes('Button')
      )
      check(
        'stalled: during the defensive Refresh the field controls stay on',
        refreshing == null &&
          choices.length > 0 &&
          off.length === 0 &&
          create != null &&
          create.enabled !== false,
        `${refreshing != null ? '"Refreshing game..." shown; ' : ''}${choices.length} fielder choices, ${off.length} off; Create Player ${create == null ? 'missing' : create.enabled === false ? 'off' : 'on'}`
      )
      await shot('refreshStalled')
      await dumpHierarchy('refreshStalled')
      if (refreshing != null) {
        const late = await gone(
          /^Refreshing game\.\.\.$/,
          MODE === 'before' ? 150000 : 30000
        )
        log(
          late == null
            ? 'still refreshing'
            : `refresh finished ${late} ms later`
        )
      }
      await tryTap(/^Cancel$/, 5000, upper(0.5))
    }
  }

  // Leave scoring and return; Set Team Rosters
  await tryTap(/^Open scoring menu$/, 5000)
  const exited = await tryTap(/^Exit Current Game$/, 5000)
  // tryTap waits 700 ms after its tap: the event screen is asked for from
  // then, and must be there at once, painted from the phone.
  const asked = Date.now()
  const left = await waitFor(/^Score$/, MODE === 'before' ? 150000 : 10000)
  const leftMs = left == null ? undefined : Date.now() - asked + 700
  check(
    'stalled: leaving scoring shows the event screen at once, painted from the phone',
    exited && leftMs != null && leftMs <= 3000,
    leftMs == null ? 'not within 10 s' : `${leftMs} ms after the tap`
  )
  await shot('exitStalled')
  log(
    left == null
      ? 'leaving scoring did not reach the event'
      : `left scoring: the event screen ${leftMs} ms after the tap`
  )
  if (left == null || !(await openScoring())) {
    check('stalled: scoring reopens', false)
    return
  }
  await tap(/^Open scoring menu$/)
  await tap(/^Set Team Rosters$/)
  await pause(1000)
  await openedTeamSide()
  await revealAddExisting()
  const roster = await nodes()
  const addExisting = roster.find(n => label(n) === 'Add Existing Player')
  const createPlayer = roster.find(n => label(n) === 'Create Player')
  check(
    'stalled: Set Team Rosters has Add Existing and Create Player enabled',
    addExisting != null &&
      createPlayer != null &&
      addExisting.enabled !== false &&
      createPlayer.enabled !== false,
    `Add Existing ${addExisting == null ? 'missing' : addExisting.enabled === false ? 'disabled' : 'enabled'}, Create Player ${createPlayer == null ? 'missing' : createPlayer.enabled === false ? 'disabled' : 'enabled'}`
  )
  await shot('addExistingStalled')
  await dumpHierarchy('addExistingStalled')

  // Dropped again: Add Existing finds the player kept from step 2
  dropTraffic()
  const addAgain = await revealAddExisting()
  if (addAgain != null) await tapNode(addAgain)
  const opened = addAgain != null
  const search = opened
    ? await waitFor(/^Search players$/, MODE === 'before' ? 60000 : 10000)
    : undefined
  if (search == null) {
    check('offline: Add Existing opens', false, 'no search field')
  } else {
    await tapNode(search)
    await type(CANDIDATE_SEARCH)
    const choose = await waitFor(
      new RegExp(`^Choose ${CANDIDATE_SHORT}\\b`),
      20000
    )
    check(
      `offline: Add Existing lists ${FIXTURE.candidate.name}`,
      choose != null
    )
    await m.hideKeyboard().catch(() => undefined)
    if (choose != null) {
      await tapNode(choose)
      await pause(1500)
      // Add to Roster opens with the jersey field focused: on iOS the number
      // pad covers the sheet's own Add to Roster button, so close the pad with
      // its Done first, then bring the button above the fold. The sheet's
      // title reads Add to Roster as well; only the button is a Button.
      const done = await waitFor(
        /^Done$/,
        3000,
        n => (n.bounds?.y ?? 0) > screen.height * 0.5
      )
      if (done != null) {
        await tapNode(done)
        await pause(800)
      }
      const reachable = (n: Node): boolean =>
        (n.type ?? '').includes('Button') &&
        n.bounds != null &&
        n.bounds.y + n.bounds.height < screen.height * 0.92
      let confirm = await waitFor(/^Add to Roster$/, 8000, reachable)
      for (let lift = 0; confirm == null && lift < 4; lift++) {
        const x = Math.round(screen.width / 2)
        await m.swipe({
          startX: x,
          startY: Math.round(screen.height * 0.7),
          endX: x,
          endY: Math.round(screen.height * 0.35),
          duration: 500
        })
        await pause(800)
        confirm = await waitFor(/^Add to Roster$/, 3000, reachable)
      }
      if (confirm == null)
        check(`offline: Add to Roster opens for ${CANDIDATE_SHORT}`, false)
      else {
        await tapNode(confirm)
        // Both sheets close on the add: Add to Roster and the search.
        const closed = await gone(
          /^(Add as Pool Player|Search players)$/,
          MODE === 'before' ? 60000 : 10000
        )
        const note = await find(new RegExp(`^${CANDIDATE_SHORT} was added`))
        log(note == null ? 'no "was added" note' : `note "${label(note)}"`)
        // Back on Set Team Rosters, the Falcons side: his row is on it.
        const row =
          closed == null
            ? undefined
            : await waitFor(CANDIDATE_ROW, 10000, notCandidateRow)
        const sheet = await find(/^Save Rosters$/)
        check(
          `offline: ${FIXTURE.candidate.name} is added to ${FIXTURE.teamNames.opened}'s roster on screen`,
          closed != null && sheet != null && row != null,
          closed == null
            ? 'Add to Roster or the search still open'
            : `${sheet == null ? 'not' : 'back'} on Set Team Rosters; ${row == null ? 'no row of his' : `row "${label(row)}"`}`
        )
      }
      await shot('addExistingOffline')
    } else {
      await shot('addExistingOffline')
      await tryTap(/^Cancel$/, 3000)
    }
  }
  const saved = await tryTap(/^Save Rosters$/, 5000)
  if (saved) {
    const closed = await gone(
      /^Save Rosters$/,
      MODE === 'before' ? 60000 : 5000
    )
    log(
      closed == null
        ? 'roster sheet still open after Save Rosters; cancelling'
        : `roster sheet closed ${closed} ms after Save Rosters`
    )
    if (closed == null) await tryTap(/^Cancel$/, 3000)
  }
}

async function step8(): Promise<void> {
  log('step 8: clear the shape; the writes arrive in order')
  // The phone was stalled, then dropped, and is now cleared with the app left
  // in the foreground (no relaunch): every queued write must reach the seat
  // on its own. Wait up to 90 s for all of them and note when each arrived.
  const clearedAt = new Date()
  clearTraffic()
  if (MODE === 'after') {
    const swaps = entered.filter(kind => kind === 'swap').length
    const gameWrites = (): string[] =>
      recorded().filter(
        l =>
          l.includes(`/games/${FIXTURE.upcomingGameId}/`) &&
          /^\S+\s+(POST|PUT|DELETE)\s/.test(l)
      )
    const rosterAdd = (): string[] =>
      recorded().filter(l =>
        new RegExp(
          `^\\S+\\s+POST\\s+\\S*/teams/${FIXTURE.teams.opened}/roster-players\\b.*\\s2\\d\\d\\b`
        ).test(l)
      )
    let complete = false
    let quietSince = Date.now()
    let last = -1
    while (Date.now() - clearedAt.getTime() < 90000) {
      const writes = gameWrites()
      if (writes.length !== last) {
        last = writes.length
        quietSince = Date.now()
      }
      const lastSwapAt = writes
        .map(l => /\/swap-sides\b/.test(l))
        .lastIndexOf(true)
      complete =
        writes.filter(l => /\/swap-sides\b/.test(l)).length >= swaps &&
        writes.slice(lastSwapAt + 1).some(l => /\/events\b/.test(l)) &&
        rosterAdd().length > 0
      if (complete && Date.now() - quietSince >= 6000) break
      await pause(3000)
    }
    const after = recorded().filter(
      l => (l.split(' ')[0] ?? '') >= clearedAt.toISOString()
    )
    const arrivals = after
      .filter(l => /^\S+\s+(POST|PUT|DELETE)\s/.test(l))
      .map(l => {
        const [at, method, path, status] = l.split(' ')
        return `+${((Date.parse(at) - clearedAt.getTime()) / 1000).toFixed(1)}s ${method} ${path.replace(/^\/api\/v1/, '')} ${status}`
      })
    log(
      `writes that reached the seat after the shape cleared at ${clearedAt.toISOString()} (app in the foreground, not relaunched):\n${arrivals.join('\n')}`
    )
    check(
      'every queued write (pitches, every swap, the roster add) reaches the seat within 90 s of the clear, without a relaunch',
      complete,
      `${arrivals.length} writes, the last ${arrivals.at(-1)?.split(' ')[0] ?? '-'} after the clear`
    )
    const failed = recorded().filter(l => /\s5\d\d$/.test(l))
    check(
      'no 5xx answer from the seat during the run',
      failed.length === 0,
      failed.join(' | ')
    )
  } else await pause(60000)
  log(`seat game state after the run: ${gameState().replace(/\n/g, ' ; ')}`)
  if (MODE === 'after') {
    // Every write to the scored game, in arrival order; a pitch is a save of
    // the game's plays, and saves that follow each other without a swap
    // between may arrive as one.
    const lines = recorded().filter(
      l =>
        l.includes(`/games/${FIXTURE.upcomingGameId}/`) &&
        /^\S+\s+(POST|PUT|DELETE)\s/.test(l)
    )
    writeFileSync(
      join(ARTIFACTS, `request-log-${PLATFORM}.log`),
      lines.join('\n') + '\n'
    )
    const kinds = lines
      .map(l =>
        /\/swap-sides\b/.test(l)
          ? 'swap'
          : /\/events\b/.test(l)
            ? 'pitch'
            : null
      )
      .filter((kind): kind is 'swap' | 'pitch' => kind != null)
    const merged = kinds.filter((kind, i) => i === 0 || kind !== kinds[i - 1])
    // What this run entered, merged the same way. The pitch entered to tag,
    // and a save that follows a reset swap, come after the last swap; through
    // the last swap the arrivals must be the order entered.
    const enteredMerged = entered.filter(
      (kind, i) => i === 0 || kind !== entered[i - 1]
    )
    const expected = enteredMerged.slice(
      0,
      enteredMerged.lastIndexOf('swap') + 1
    )
    const lastSwap = merged.lastIndexOf('swap')
    const order = merged.slice(0, lastSwap + 1)
    log(
      `writes to ${FIXTURE.upcomingGameId}, in arrival order:\n${lines.join('\n')}`
    )
    check(
      'the request log shows the pitches and the swaps in the order entered',
      expected.length > 0 &&
        order.join(',') === expected.join(',') &&
        merged.slice(lastSwap + 1).every(kind => kind === 'pitch'),
      `entered ${entered.join(',')}; arrived ${kinds.join(',')} (repeats merged, through the last swap: arrived ${order.join(',')}, entered ${expected.join(',')}; after it: ${lastSwap + 1 < merged.length ? merged.slice(lastSwap + 1).join(',') : 'nothing'})`
    )
    // The add queued offline in step 7 reached the server once the shape
    // cleared, and the player is on the opened team.
    const adds = recorded().filter(l =>
      new RegExp(
        `^\\S+\\s+POST\\s+\\S*/teams/${FIXTURE.teams.opened}/roster-players\\b.*\\s2\\d\\d\\b`
      ).test(l)
    )
    check(
      `the request log shows the queued add to ${FIXTURE.teamNames.opened}'s roster`,
      adds.length > 0,
      adds.join(' | ')
    )
  } else log('request log not read in before mode')
  const onTeam = candidateOnOpened()
  check(
    `${FIXTURE.candidate.name} is on ${FIXTURE.teamNames.opened} on the server`,
    onTeam === 'player',
    onTeam
  )
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  log(`run start: ${process.argv.slice(2).join(' ')}`)
  execFileSync(MAESTRO_BIN, ['ps'], { stdio: 'inherit' })
  const { MaestroD } = createRequire(resolve('package.json'))(MAESTRO_CLIENT)
  const daemon = await MaestroD.connect({
    name: DAEMON,
    bin: MAESTRO_BIN,
    idleTimeout: 0
  })
  await daemon.detach(DEVICE).catch(() => undefined)
  if (PLATFORM === 'ios') await openIosCapture()
  m = (await daemon.attach({
    device: DEVICE,
    platform: PLATFORM,
    appId: APP_ID,
    artifacts: 'on-failure',
    ...(PLATFORM === 'ios' && TEAM_ID !== '' ? { teamId: TEAM_ID } : {})
  })) as Device
  let recorder = false
  try {
    if (MODE === 'after' && runs(2)) {
      recorder = true
      await startRecorder()
    }
    const steps = [step1, step2, step3, step4, step5, step6, step7, step8]
    for (let i = 0; i < steps.length; i++) {
      if (!runs(i + 1)) continue
      try {
        await steps[i]()
      } catch (error) {
        log(`step ${i + 1} stopped: ${(error as Error).message}`)
        await shot(`step${i + 1}-error`).catch(() => undefined)
        if (i + 1 <= 2) throw error
        if (MODE === 'after')
          failures.push(`step ${i + 1}: ${(error as Error).message}`)
      }
    }
  } finally {
    clearTraffic()
    closeIosCapture()
    if (recorder)
      await stopRecorder().catch((error: unknown) => {
        log(`recorder cleanup failed: ${(error as Error).message}`)
      })
    if (!flag('keep-app'))
      await m.stopApp({ appId: APP_ID }).catch(() => undefined)
    daemon.close()
  }
  log(
    `run end: ${failures.length === 0 ? 'no failed assertions' : `FAILED: ${failures.join('; ')}`}`
  )
  if (MODE === 'after' && failures.length > 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  log(`run failed: ${(error as Error).stack ?? String(error)}`)
  closeIosCapture()
  try {
    clearTraffic()
  } catch {}
  process.exitCode = 1
})
