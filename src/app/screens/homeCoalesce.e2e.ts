import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { groupFixture } from '../../test/groupFixtures'
import {
  browserSession,
  capture,
  log,
  maestro
} from '../../test/refinementsMaestro.e2e'
import { databaseUrlOf } from '../../test/screenScopeNotices'

/**
 * Home follows its scope's notices through the gate: 20 plays, each scoring a
 * run, posted one every 200 ms to a live game of a team the signed-in person
 * is in. For each of Home's two gated loads that show games, `GET /live` and
 * `GET /events?played=1&limit=1`, the browser's requests are timed against
 * the first `changed` frame the page heard: the first read starts within
 * 300 ms of it, later reads are at least 3 s apart, and there are at most
 * three. Home then shows the final score.
 *
 *   TS_ARTIFACTS_DIR=<dir> TS_MAESTRO_D_CLIENT=… MAESTRO_D_BIN=… \
 *     node -r sucrase/register src/app/screens/homeCoalesce.e2e.ts --scenario coalesce
 *
 * On a `groupFixture` server and `dist` (`node src/build.mjs`) unless
 * `TS_HOME_COALESCE_API` (the API base, `…/api/v1`) and `TS_HOME_COALESCE_WEB`
 * name servers already running; then `TS_HOME_COALESCE_TOKEN_FILE` holds a
 * session token of a scorekeeper of `TS_HOME_COALESCE_GAME`.
 * `TS_HOME_COALESCE_OBSERVE=1` writes the log and asserts nothing.
 */

const ROUTES = ['/live', '/events?played=1&limit=1'] as const

const PLAYS = 20
const GAP_MS = 200
const FIRST_WITHIN_MS = 300
const APART_MS = 3000
const MOST_READS = 3

interface Stack {
  api: string
  web: string
  token: string
  gameId: string
  close: () => Promise<void>
}

function scenarioOf(argv: readonly string[]): string {
  const at = argv.indexOf('--scenario')
  return at < 0 ? 'coalesce' : (argv[at + 1] ?? '')
}

async function running(api: string, web: string): Promise<Stack> {
  const tokenFile = process.env.TS_HOME_COALESCE_TOKEN_FILE
  const gameId = process.env.TS_HOME_COALESCE_GAME
  if (tokenFile == null || gameId == null)
    throw new Error(
      'Supply TS_HOME_COALESCE_TOKEN_FILE and TS_HOME_COALESCE_GAME with TS_HOME_COALESCE_API'
    )
  const token = (await readFile(tokenFile, 'utf8')).trim()
  return { api, web, token, gameId, close: async () => undefined }
}

/**
 * The server's socket, loaded at run time: it is typed for Node's timers,
 * and this file is checked with the DOM's.
 */
const { attachGameSocket } = createRequire(resolve('package.json'))(
  './src/server/socket/gameSocket'
) as {
  attachGameSocket: (
    server: Server,
    db: Awaited<ReturnType<typeof groupFixture>>['h']['db'],
    databaseUrl: string,
    options: { stopSignals: null }
  ) => { close: () => Promise<void> }
}

async function fixture(): Promise<Stack> {
  const f = await groupFixture(resolve('dist'))
  const socket = attachGameSocket(
    f.h.server,
    f.h.db,
    await databaseUrlOf(f.h.db),
    { stopSignals: null }
  )
  const gameId = 'gam_home_coalesce'
  await f.h.db
    .insertInto('games')
    .values({
      id: gameId,
      home_team_id: f.teamA,
      away_team_id: f.teamB,
      season_id: f.seasonA,
      start_at: new Date(),
      end_at: new Date(Date.now() + 2 * 3600_000),
      status: 'scheduled'
    })
    .execute()
  return {
    api: `${f.h.origin}/api/v1`,
    web: f.h.origin,
    token: f.h.tokens.get(101)!,
    gameId,
    close: async () => {
      await socket.close()
      await f.h.close()
    }
  }
}

async function main(): Promise<void> {
  const scenario = scenarioOf(process.argv)
  if (scenario === 'shown')
    throw new Error('--scenario shown is not written yet')
  if (scenario !== 'coalesce')
    throw new Error(`No scenario ${scenario}: coalesce or shown`)
  const out = process.env.TS_ARTIFACTS_DIR
  if (out == null) throw new Error('Supply TS_ARTIFACTS_DIR')
  await mkdir(out, { recursive: true })
  const observe = process.env.TS_HOME_COALESCE_OBSERVE === '1'
  const api = process.env.TS_HOME_COALESCE_API
  const web = process.env.TS_HOME_COALESCE_WEB
  if ((api == null) !== (web == null))
    throw new Error('Supply both TS_HOME_COALESCE_API and TS_HOME_COALESCE_WEB')
  const stack =
    api == null || web == null
      ? await fixture()
      : await running(api.replace(/\/+$/, ''), web.replace(/\/+$/, ''))
  const file = 'home-coalesce.log'
  await writeFile(join(out, file), '')
  const say = async (line: string): Promise<void> => {
    await log(out, file, line)
  }
  const d = await maestro(process.env.MAESTRO_D ?? 'homeCoalesce')
  const s = await browserSession(d, 'home-coalesce-web', 390, 844, out)
  try {
    await say(
      `# ${observe ? 'observe only' : 'asserting'}; API ${stack.api}, web ${stack.web}, game ${stack.gameId}`
    )
    const authorized = { authorization: `Bearer ${stack.token}` }
    const apiPath = new URL(stack.api).pathname
    // The browser's own clock for both: CDP stamps requests and socket frames
    // on one monotonic clock, in seconds.
    const reads: Array<{ at: number; path: string }> = []
    const notices: number[] = []
    let firstAt: number | undefined
    const since = (at: number): string =>
      firstAt == null ? '-' : `${Math.round((at - firstAt) * 1000)} ms`
    const cdp = await s.page.createCDPSession()
    await cdp.send('Network.enable')
    cdp.on('Network.requestWillBeSent', event => {
      const url = new URL(event.request.url)
      if (
        event.request.method !== 'GET' ||
        url.origin !== new URL(stack.api).origin
      )
        return
      if (!url.pathname.startsWith(apiPath)) return
      const path = url.pathname.slice(apiPath.length) + url.search
      reads.push({ at: event.timestamp, path })
      if (firstAt != null)
        console.log(`  read ${path} at ${since(event.timestamp)}`)
    })
    cdp.on('Network.webSocketFrameReceived', event => {
      let frame: { type?: string; scope?: string }
      try {
        frame = JSON.parse(event.response.payloadData) as typeof frame
      } catch {
        return
      }
      if (frame.type !== 'changed' || frame.scope !== 'home') return
      notices.push(event.timestamp)
      firstAt ??= event.timestamp
      console.log(
        `  notice ${event.response.payloadData} at ${since(event.timestamp)}`
      )
    })
    const sent: string[] = []
    cdp.on('Network.webSocketFrameSent', event => {
      sent.push(event.response.payloadData)
    })

    const games = await fetch(`${stack.api}/games/${stack.gameId}/events`, {
      headers: authorized
    })
    expect(games.status, await games.clone().text()).equals(200)
    const { plays: rows } = (await games.json()) as {
      plays: Array<{
        gumbo: {
          about?: { atBatIndex?: number }
          result?: { awayScore?: number; homeScore?: number }
        }
      }>
    }
    let index = 0
    let away = 0
    let home = 0
    for (const row of rows) {
      const at = row.gumbo.about?.atBatIndex ?? -1
      if (at < index) continue
      index = at + 1
      away = row.gumbo.result?.awayScore ?? away
      home = row.gumbo.result?.homeScore ?? home
    }
    await say(
      `# the game has ${rows.length} plays; posting from at-bat ${index}, ${away}-${home}`
    )

    await s.browser.setCookie({
      name: 'ts_session',
      value: encodeURIComponent(stack.token),
      domain: new URL(stack.web).hostname,
      path: '/'
    })
    await s.m.openBrowser({ url: `${stack.web}/` })
    // Home's first reads, then long enough that the gate holds no read back.
    const opened = Date.now()
    while (
      ROUTES.some(route => !reads.some(read => read.path === route)) &&
      Date.now() - opened < 30_000
    )
      await new Promise(resolve => setTimeout(resolve, 100))
    await new Promise(resolve => setTimeout(resolve, 4000))
    const scopeSubscribes = sent.filter(text => text.includes('"scope"'))
    await say(`# scope frames sent: ${scopeSubscribes.join(' ')}`)
    const before = reads.length
    await say(`# Home opened; ${before} API reads so far`)

    for (let i = 0; i < PLAYS; i++) {
      const started = Date.now()
      away += 1
      const response = await fetch(
        `${stack.api}/games/${stack.gameId}/events`,
        {
          method: 'POST',
          headers: { ...authorized, 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'live',
            source: { system: 'manual' },
            plays: [
              {
                about: {
                  atBatIndex: index + i,
                  inning: 1,
                  halfInning: 'top',
                  isScoringPlay: true
                },
                count: { outs: 0 },
                result: {
                  eventType: 'home_run',
                  awayScore: away,
                  homeScore: home,
                  rbi: 1,
                  description: 'Home run'
                }
              }
            ]
          })
        }
      )
      const text = await response.text()
      if (response.status !== 200)
        throw new Error(`post ${i + 1} answered ${response.status} ${text}`)
      console.log(`  post ${i + 1}/${PLAYS}: ${away}-${home}`)
      const left = GAP_MS - (Date.now() - started)
      if (left > 0) await new Promise(resolve => setTimeout(resolve, left))
    }
    // Long enough for every read the gate still owes.
    await new Promise(resolve => setTimeout(resolve, 7000))

    await say(`# ${notices.length} home notices heard`)
    const first = notices[0]
    for (const route of ROUTES) {
      const times = reads
        .slice(before)
        .filter(
          read => read.path === route && first != null && read.at >= first
        )
        .map(read => read.at)
      const gaps = times.slice(1).map((at, i) => (at - times[i]) * 1000)
      const lead =
        times[0] == null || first == null
          ? undefined
          : (times[0] - first) * 1000
      const spaced =
        gaps.length === 0
          ? 'none'
          : gaps.map(gap => `${Math.round(gap)} ms`).join(', ')
      await say(
        `GET ${route}: ${times.length} reads after the first notice, at ${times.map(since).join(', ')}; ` +
          `first ${lead == null ? 'none' : `${Math.round(lead)} ms`} after it; ` +
          `gaps ${spaced}`
      )
      if (observe) continue
      expect(lead, `${route}: a read after the first notice`).not.equals(
        undefined
      )
      expect(lead!, `${route}: the first read is prompt`).most(FIRST_WITHIN_MS)
      for (const gap of gaps)
        expect(gap, `${route}: reads ${APART_MS} ms apart`).least(APART_MS - 50)
      expect(times.length, `${route}: at most ${MOST_READS}`).most(MOST_READS)
    }

    const score = String(away)
    const shown = await s.page
      .waitForFunction(
        (want: string) =>
          [...document.querySelectorAll('*')].some(
            node => node.childElementCount === 0 && node.textContent === want
          ),
        { timeout: observe ? 5000 : 15000 },
        score
      )
      .then(() => true)
      .catch(() => false)
    await say(`# Home shows the final score ${away}-${home}: ${shown}`)
    await capture(s.m, out, 'home-coalesce.png')
    if (!observe) expect(shown, 'Home shows the final score').equals(true)
    console.log(
      observe
        ? 'Observed Home’s reads (no assertions)'
        : 'Home read at once, then at most every 3 s, and shows the final score'
    )
  } finally {
    await s.browser.disconnect()
    await s.m.detach()
    await d.shutdown()
    await stack.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
