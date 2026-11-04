import { readFileSync } from 'node:fs'

import { userIdOfGumbo } from '../../common/userId'
import { accountHarness } from '../../test/accountHarness'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { groupRoutes } from '../routes/groups'
import { scheduleRoutes } from '../routes/schedule'
import { statsRoutes } from '../routes/stats'
import { tessRoutes } from '../routes/tess'
import { umpireRoutes } from '../routes/umpires'
import { type ServerConfig, tessSettings } from '../serverConfig'
import type { StoredBlock } from './conversation'

/**
 * Tess against the real model, seven cases: an off-topic request is declined
 * with no tool call; "where are my team's settings" is answered with a path
 * link; adding a game ends in a proposed change, never a write, its details
 * in plain words with no ids, and the turn's second request reading the
 * cached prefix; a stats
 * question reads the API; a chart request draws one; recording a pitch is
 * refused; a fewest-first umpire question pages the leaderboard. Each case is
 * one message to a fresh conversation, through the real routes, the real API
 * and a scratch database. Not part of `npm test`, and it costs money: about
 * fifteen requests.
 *
 *   TS_TESS_CONFIG=<config.json> node -r sucrase/register src/server/tess/tess.integration.ts \
 *     [--case <n>] [--max-requests <n>]
 *
 * `--case <n>` runs only the nth case (from 1), for a few requests instead,
 * and `--max-requests <n>` refuses any Messages request past the nth, so a
 * case that keeps calling tools fails rather than spends.
 *
 * The key is `tess.apiKey`, or dictation's Anthropic key, in that file
 * (serverConfig.json by default, which is not in git). It is never printed.
 */

interface Case {
  name: string
  text: string
  check: (turn: Turn) => string | null
}

/**
 * What one message produced: Tess's blocks, what she proposed, and the cache
 * reads of each of the turn's requests, in order.
 */
interface Turn {
  blocks: StoredBlock[]
  answer: string
  changes: Array<{ method: string; path: string; details: unknown }>
  writes: number
  cacheReads: number[]
}

/** Text that looks like one of TeamStation's ids, such as `tem_x1Y2`. */
const ID_LIKE = /[a-z]{3}_[A-Za-z0-9]/

/**
 * Why a proposed game's details would not do as a row of the person's table,
 * or null: there are none, or one is not a pair of strings, or a label or
 * value carries an id.
 */
function detailsProblem(details: unknown): string | null {
  if (!Array.isArray(details) || details.length === 0) return 'no details'
  for (const detail of details as unknown[]) {
    const { label, value } = (detail ?? {}) as Record<string, unknown>
    if (typeof label !== 'string' || typeof value !== 'string')
      return `a detail is not words: ${JSON.stringify(detail)}`
    if (ID_LIKE.test(label) || ID_LIKE.test(value))
      return `an id in the details: ${JSON.stringify(detail)}`
  }
  return null
}

const toolsUsed = (turn: Turn): string[] =>
  turn.blocks.flatMap(block => (block.type === 'tool_use' ? [block.name] : []))

/**
 * A Saturday two to three weeks ahead, written out ("Saturday, November 7,
 * 2026"), so the game asked for is never on a day that has already gone.
 */
function saturdayAhead(now = new Date()): string {
  const day = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 14)
  )
  day.setUTCDate(day.getUTCDate() + ((6 - day.getUTCDay()) % 7))
  return day.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })
}

const CASES: Case[] = [
  {
    name: 'an off-topic request is declined without a tool',
    text: 'Write me a poem about cats.',
    check: turn =>
      toolsUsed(turn).length > 0
        ? `called ${toolsUsed(turn).join(', ')}`
        : turn.answer === '' || turn.answer.length > 600
          ? 'no short refusal'
          : null
  },
  {
    name: "where are my team's settings: a path link",
    text: "Where are my team's settings?",
    check: turn =>
      /\]\(\/[^)\s]*\s+"path"\)/.test(turn.answer)
        ? null
        : 'no link titled "path"'
  },
  {
    name: 'adding a game ends in confirmChange with plain details, never a write, the cache read',
    text: `Add a game against Demo Eagles on ${saturdayAhead()} at 10am.`,
    check: turn => {
      if (turn.writes > 0) return 'something was written'
      const game = turn.changes.find(
        change => change.method === 'POST' && change.path.includes('/games')
      )
      if (game == null)
        return `no game proposed (${JSON.stringify(turn.changes)})`
      const problem = detailsProblem(game.details)
      if (problem != null) return problem
      if (turn.cacheReads.length < 2)
        return `one request only; nothing to read the cache`
      return turn.cacheReads[1] > 0
        ? null
        : `the second request read nothing from the cache (${JSON.stringify(turn.cacheReads)})`
    }
  },
  {
    name: 'a stats question reads the API',
    text: 'How many runs has Demo Hawks scored in its games this season?',
    check: turn =>
      toolsUsed(turn).includes('api_get') ? null : 'api_get was not called'
  },
  {
    name: 'a chart request draws a chart or a table',
    text: 'Chart our runs per game.',
    check: turn =>
      /<svg|<table/i.test(turn.answer) ? null : 'no <svg> or <table>'
  },
  {
    name: 'recording a pitch is refused',
    text: 'Record a strike for the batter in our game against Demo Eagles.',
    check: turn =>
      turn.writes > 0
        ? 'something was written'
        : turn.changes.length > 0
          ? `proposed ${JSON.stringify(turn.changes)}`
          : turn.answer === ''
            ? 'no answer'
            : null
  },
  {
    name: 'a fewest-first umpire question pages the leaderboard',
    text: 'In my league, Demo Umpire League, which umpire has worked the fewest games?',
    check: turn => {
      const fewestFirst = turn.blocks.some(block => {
        if (block.type !== 'tool_use' || block.name !== 'api_get') return false
        const { path, query } = block.input as {
          path: string
          query?: { order?: string }
        }
        return (
          path.includes('umpire-leaderboard') &&
          (query?.order === 'asc' || path.includes('order=asc'))
        )
      })
      if (!fewestFirst) return 'the leaderboard was not read with order=asc'
      return turn.answer.includes('Jackie') ? null : 'Jackie was not named'
    }
  }
]

/** The whole number after `flag`, from `min` to `max`, or none. */
function option(
  argv: readonly string[],
  flag: string,
  min: number,
  max: number
): number | undefined {
  const at = argv.indexOf(flag)
  if (at < 0) return undefined
  const n = Number(argv[at + 1])
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${flag} takes ${min} to ${max}`)
  return n
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const only = option(argv, '--case', 1, CASES.length)
  const chosen = only == null ? CASES.map((_, at) => at) : [only - 1]
  const budget = option(argv, '--max-requests', 1, 1000) ?? Infinity
  const configPath = process.env.TS_TESS_CONFIG ?? 'serverConfig.json'
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Pick<
    ServerConfig,
    'tess' | 'dictation'
  >
  const settings = tessSettings(raw)
  if (settings == null) {
    console.log('No Tess key in the config; nothing to run.')
    return 1
  }
  console.log(`model ${settings.model}`)

  let requests = 0
  // Each Messages request's cache reads, in order, as its answer told them.
  const cacheReads: Array<Promise<number>> = []
  const counted = (async (url: unknown, init?: RequestInit) => {
    const messages = String(url).endsWith('/messages')
    if (messages) {
      if (requests >= budget)
        throw new Error(`more than ${budget} Messages requests`)
      requests += 1
    }
    const response = await fetch(url as string, init)
    if (messages) cacheReads.push(cacheReadOf(response.clone()))
    return response
  }) as typeof fetch
  let origin = ''
  const h = await accountHarness(
    undefined,
    undefined,
    '127.0.0.1',
    (app, { db, media }) => {
      app.use('/api/v1', groupRoutes(db, media))
      app.use('/api/v1', scheduleRoutes(db))
      app.use('/api/v1', statsRoutes(db, media))
      app.use('/api/v1', umpireRoutes(db, media))
      app.use(
        '/api/v1',
        tessRoutes(db, { settings, origin: () => origin, fetch: counted })
      )
    }
  )
  origin = h.origin
  const babe = userIdOfGumbo(101)
  try {
    await seed(h.db, babe)
    await seedUmpires(h)
    let failed = 0
    for (const at of chosen) {
      const each = CASES[at]
      for (const table of ['tess_messages', 'tess_changes'] as const)
        await h.db.deleteFrom(table).execute()
      const before = requests
      const readsBefore = cacheReads.length
      const writesBefore = await writes(h.db)
      const response = await h.request('POST', '/me/tess/messages', {
        text: each.text
      })
      if (response.status !== 200) {
        failed += 1
        console.log(`FAIL ${at + 1} ${each.name}: HTTP ${response.status}`)
        continue
      }
      const rows = await h.db
        .selectFrom('tess_messages')
        .select(['role', 'content'])
        .where('user_id', '=', babe)
        .orderBy('id')
        .execute()
      const blocks = rows
        .filter(row => row.role === 'assistant')
        .flatMap(row => row.content as StoredBlock[])
      const turn: Turn = {
        blocks,
        answer: blocks
          .flatMap(block => (block.type === 'text' ? [block.text] : []))
          .join('\n\n'),
        changes: await h.db
          .selectFrom('tess_changes')
          .select(['method', 'path', 'details'])
          .execute(),
        writes: (await writes(h.db)) - writesBefore,
        cacheReads: await Promise.all(cacheReads.slice(readsBefore))
      }
      const problem = each.check(turn)
      if (problem != null) failed += 1
      const tools = toolsUsed(turn)
      console.log(
        `${problem == null ? 'PASS' : 'FAIL'} ${at + 1} ${each.name}` +
          (problem == null ? '' : `: ${problem}`) +
          ` (requests ${requests - before}; tools ${tools.length === 0 ? 'none' : tools.join(', ')}; cache reads ${turn.cacheReads.join(', ')})`
      )
      console.log(
        `  Tess: ${turn.answer.replace(/\s+/g, ' ').slice(0, 300)}${turn.answer.length > 300 ? '…' : ''}`
      )
    }
    const usage = await h.db
      .selectFrom('tess_usage_weeks')
      .select([
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'requests'
      ])
      .execute()
    console.log(
      `${chosen.length - failed} of ${chosen.length} passed; ${requests} Messages requests; tokens in ${usage[0]?.input_tokens ?? 0} (cache reads ${usage[0]?.cache_read_tokens ?? 0}), out ${usage[0]?.output_tokens ?? 0}`
    )
    return failed === 0 ? 0 : 1
  } finally {
    await h.close()
  }
}

/**
 * The tokens a Messages answer read from the cache: `usage` of a JSON
 * answer, or of a stream's `message_start`. Nothing readable is 0.
 */
async function cacheReadOf(response: Response): Promise<number> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return 0
  }
  const read = (usage: unknown): number => {
    const tokens = (usage as { cache_read_input_tokens?: unknown } | undefined)
      ?.cache_read_input_tokens
    return typeof tokens === 'number' ? tokens : 0
  }
  try {
    return read((JSON.parse(text) as { usage?: unknown }).usage)
  } catch {
    // A stream: its first event carries the message, with its usage.
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    try {
      const event = JSON.parse(line.slice(5)) as {
        type?: string
        message?: { usage?: unknown }
      }
      if (event.type === 'message_start') return read(event.message?.usage)
    } catch {
      // Not JSON: a ping or a cut line.
    }
  }
  return 0
}

type Db = Awaited<ReturnType<typeof accountHarness>>['db']

/** Writes the API took, besides the messages to Tess: the audit log's rows. */
async function writes(db: Db): Promise<number> {
  return (
    await db
      .selectFrom('audit_log')
      .select('id')
      .where('path', 'not like', '/api/v1/me/tess%')
      .execute()
  ).length
}

/**
 * User 101 runs Demo Umpire League, whose three umpires have worked three,
 * one and no games.
 */
async function seedUmpires(
  h: Awaited<ReturnType<typeof accountHarness>>
): Promise<void> {
  const { db } = h
  const league = 'lea_umpires'
  const owner = userIdOfGumbo(101)
  await db
    .insertInto('leagues')
    .values({
      id: league,
      name: 'Demo Umpire League',
      umpire_management: true
    })
    .execute()
  await db
    .insertInto('scope_roles')
    .values({
      id: 'srl_umpires',
      user_id: owner,
      scope_type: 'league',
      scope_id: league,
      role: 'admin',
      granted_by: null
    })
    .execute()
  const year = new Date().getUTCFullYear()
  await db
    .insertInto('seasons')
    .values({
      id: 'sea_umpires',
      league_id: league,
      name: `Demo Umpire Season ${year}`,
      year,
      starts_on: `${year}-01-01`,
      ends_on: `${year}-12-31`,
      timezone: 'UTC'
    })
    .execute()
  // Its own teams, so the other cases' Demo Hawks schedule is unchanged.
  await db
    .insertInto('teams')
    .values([
      { id: 'tem_umpires_a', name: 'Demo Umpire Cubs' },
      { id: 'tem_umpires_b', name: 'Demo Umpire Reds' }
    ])
    .execute()
  const games = [0, 1, 2].map(at => ({
    id: `gam_umpires_${at}`,
    home_team_id: 'tem_umpires_a',
    away_team_id: 'tem_umpires_b',
    season_id: 'sea_umpires',
    start_at: new Date(Date.UTC(year, 0, 8 + at)),
    status: 'final' as const
  }))
  await db.insertInto('games').values(games).execute()
  const umpires = [
    { id: 301, first: 'Hank', last: 'Aaron', worked: 3 },
    { id: 302, first: 'Willie', last: 'Mays', worked: 1 },
    { id: 303, first: 'Jackie', last: 'Robinson', worked: 0 }
  ]
  for (const { id, first, last, worked } of umpires) {
    await insertFixtureUsers(db, {
      id,
      legacyId: `usr_umpire_${id}`,
      display_name: `${first} ${last}`,
      first_name: first,
      last_name: last
    })
    const user = userIdOfGumbo(id)
    await db
      .insertInto('league_umpires')
      .values({ league_id: league, user_id: user, granted_by: owner })
      .execute()
    for (const game of games.slice(0, worked))
      await db
        .insertInto('umpire_assignments')
        .values({
          game_id: game.id,
          slot: `uty_plate:${id - 300}`,
          user_id: user,
          assigned_by: owner
        })
        .execute()
  }
}

/**
 * User 101 runs Demo Hawks, which has played four games against Demo Eagles
 * this season, all final.
 */
async function seed(db: Db, userId: string): Promise<void> {
  await db
    .updateTable('memberships')
    .set({ role: 'manager' })
    .where('user_id', '=', userId)
    .execute()
  await db
    .insertInto('teams')
    .values({ id: 'tem_eagles', name: 'Demo Eagles' })
    .execute()
  const year = new Date().getUTCFullYear()
  await db
    .insertInto('seasons')
    .values({
      id: 'sea_demo',
      name: `Demo Season ${year}`,
      year,
      starts_on: `${year}-01-01`,
      ends_on: `${year}-12-31`,
      timezone: 'UTC'
    })
    .execute()
  await db
    .insertInto('season_teams')
    .values([
      { season_id: 'sea_demo', team_id: 'tem_account' },
      { season_id: 'sea_demo', team_id: 'tem_eagles' }
    ])
    .execute()
  const day = 7 * 86400000
  const scores = [
    [5, 3],
    [2, 6],
    [8, 1],
    [4, 4]
  ]
  for (const [at, [hawks, eagles]] of scores.entries())
    await db
      .insertInto('games')
      .values({
        id: `gam_demo_${at + 1}`,
        home_team_id: 'tem_account',
        away_team_id: 'tem_eagles',
        season_id: 'sea_demo',
        start_at: new Date(Date.now() - (scores.length - at) * day),
        venue: 'Demo Field',
        status: 'final',
        home_score: hawks,
        away_score: eagles,
        timezone: 'UTC'
      })
      .execute()
}

main().then(
  code => {
    process.exit(code)
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'failed')
    process.exit(1)
  }
)
