import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

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
import type { ToolUseBlock } from './messagesApi'

/**
 * Tess against the real model, ten cases: an off-topic request is declined
 * with no tool call; "where are my team's settings" is answered with a path
 * link; adding a game ends in a proposed change, never a write, its details
 * in plain words with no ids, and the turn's second request reading the
 * cached prefix; a stats
 * question reads the API; a chart request draws one; recording a pitch is
 * refused; a fewest-first umpire question pages the leaderboard; a source
 * question uses the cached source map and reads the relevant implementation;
 * finding an umpire for a game reads availability and commitments and says
 * who was left out; and an umpire question naming no league, from an admin
 * of two, asks which league first. Each case is
 * one message to a fresh conversation, through the real routes, the real API
 * and a scratch database. Not part of `npm test`, and it costs money: about
 * fifteen requests for the first eight, and up to twelve for each of the two
 * umpire cases.
 *
 *   TS_TESS_CONFIG=<config.json> node -r sucrase/register src/server/tess/tess.integration.ts \
 *     [--case <n>] [--max-requests <n>]
 *
 * `--case <n>` runs only the nth case (from 1), for a few requests instead,
 * and `--max-requests <n>` refuses any Messages request past the nth, so a
 * case that keeps calling tools fails rather than spends.
 *
 * With `TS_TESS_TRANSCRIPT=<file>`, each case run writes its question, each
 * tool call's name, path and query, and Tess's whole answer to that file.
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

/** The turn's tool calls, in order. */
const toolCalls = (turn: Turn): ToolUseBlock[] =>
  turn.blocks.filter(
    (block): block is ToolUseBlock => block.type === 'tool_use'
  )

/** One tool call written for the transcript: its name, path and query. */
function callText(call: ToolUseBlock): string {
  const input = (call.input ?? {}) as {
    path?: string
    query?: unknown
  }
  if (call.name === 'api_get')
    return `${call.name} ${input.path ?? ''}${input.query == null ? '' : ` ${JSON.stringify(input.query)}`}`
  return `${call.name} ${JSON.stringify(call.input)}`
}

/** Whether a call reads a league's umpire list, by REST or by GraphQL. */
function readsUmpireList(call: ToolUseBlock): boolean {
  const input = (call.input ?? {}) as { path?: string; query?: unknown }
  if (call.name === 'api_get')
    return /^\/leagues\/[^/]+\/umpires(\?|$)/.test(input.path ?? '')
  return (
    call.name === 'graphql_query' && /\bumpires\s*\(/.test(String(input.query))
  )
}

/** Whether a call asks the umpire list for a time: availableAt, or day and time. */
function asksAvailability(call: ToolUseBlock): boolean {
  if (!readsUmpireList(call)) return false
  const text = JSON.stringify(call.input)
  return /availableAt|\bday\b/.test(text)
}

/** Whether a call reads an umpire's commitments, by REST or by GraphQL. */
function readsCommitments(call: ToolUseBlock): boolean {
  const input = (call.input ?? {}) as { path?: string; query?: unknown }
  return call.name === 'api_get'
    ? /\/umpires\/[^/]+\/commitments/.test(input.path ?? '')
    : call.name === 'graphql_query' &&
        String(input.query).includes('umpireCommitments')
}

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
    text: `Add a Demo Hawks game against Demo Eagles on ${saturdayAhead()} at 10am.`,
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
  },
  {
    name: 'a source question uses the index with a narrowed first call',
    text: 'How many tool rounds can Tess use before stopping? Explain from TeamStation source code and quote the relevant constant with its source path.',
    check: turn => {
      const calls = turn.blocks.filter(
        (block): block is ToolUseBlock =>
          block.type === 'tool_use' && block.name.startsWith('source_')
      )
      const first = calls[0]
      if (first == null) return 'no source tool was used'
      const input = first.input as { path?: string; name?: string }
      if (
        first.name !== 'source_find_definition' &&
        (input.path == null ||
          input.path === 'src' ||
          input.path === 'src/DIRECTORY_MAP.md')
      )
        return 'first source call was not narrowed'
      if (
        calls.some(
          block =>
            (block.input as { path?: string }).path === 'src/DIRECTORY_MAP.md'
        )
      )
        return 'spent a tool round on the cached map'
      if (!turn.cacheReads.slice(1).some(count => count > 0))
        return 'source request did not reuse its cached prefix'
      if (
        !turn.answer.includes('MAX_TOOL_ROUNDS') ||
        !/\b20\b/.test(turn.answer) ||
        !turn.answer.includes('src/server/tess/agent.ts')
      )
        return 'answer did not cite the actual limit and source'
      return turn.writes === 0 && turn.changes.length === 0
        ? null
        : 'source question proposed or performed a write'
    }
  },
  {
    name: 'finding an umpire for a game reads availability and commitments and says who was left out',
    text: 'Find me an umpire for the Demo Rockets v Demo Comets game.',
    check: turn => {
      const calls = toolCalls(turn)
      if (!calls.some(asksAvailability))
        return 'the umpire list was not asked for the game’s time'
      if (!calls.some(readsCommitments)) return 'no commitments were read'
      if (turn.writes > 0 || turn.changes.length > 0)
        return 'something was proposed or written'
      // Ids belong only in link targets, never in the words.
      const words = turn.answer.replace(/\]\([^)]*\)/g, ']')
      const id = /\b(?:sea|lea|gam|usr|tem)_\w+/.exec(words)
      if (id != null) return `the answer shows the id ${id[0]}`
      if (!turn.answer.includes('Hank')) return 'Hank Aaron was not named'
      const near = (name: string, reason: RegExp): boolean =>
        turn.answer
          .split(/\n+/)
          .some(line => line.includes(name) && reason.test(line))
      if (!near('Willie', /umpir|assign|busy|conflict|already/i))
        return 'Willie Mays was not said to be umpiring then'
      if (!near('Jackie', /filter|availab|weekend|Saturday|Sunday/i))
        return 'Jackie Robinson was not said to be filtered out'
      return null
    }
  },
  {
    name: 'an umpire question naming no league asks which league first',
    text: 'Which umpires haven’t filtered out Tuesdays at 3 pm?',
    check: turn => {
      const read = toolCalls(turn).filter(readsUmpireList)
      if (read.length > 0)
        return `read an umpire list before asking (${read.map(callText).join('; ')})`
      if (!/league/i.test(turn.answer) || !turn.answer.includes('?'))
        return 'did not ask which league'
      return turn.writes === 0 && turn.changes.length === 0
        ? null
        : 'something was proposed or written'
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
  const transcript = process.env.TS_TESS_TRANSCRIPT
  if (transcript != null) writeFileSync(transcript, '')
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
      if (transcript != null)
        appendFileSync(
          transcript,
          [
            `# Case ${at + 1}: ${each.name}`,
            `# ${problem == null ? 'PASS' : `FAIL: ${problem}`}`,
            '',
            `Question: ${each.text}`,
            '',
            'Tool calls:',
            ...toolCalls(turn).map(call => `- ${callText(call)}`),
            '',
            'Answer:',
            turn.answer,
            '',
            ''
          ].join('\n')
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
 * one and no games; its Umpire Spring season has the Demo Rockets v Demo
 * Comets game, while Willie Mays umpires another, and Willie and Jackie have
 * saved their availability. 101 also runs Demo Umpire League B, where Hank
 * Aaron umpires too.
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
  // Umpire Spring: Demo Rockets v Demo Comets on Tuesday 2027-04-13 at
  // 18:30 in Los Angeles, and at the same time a game Willie Mays umpires.
  await db
    .insertInto('seasons')
    .values({
      id: 'sea_umpire_spring',
      league_id: league,
      name: 'Umpire Spring',
      year: 2027,
      starts_on: '2027-03-01',
      ends_on: '2027-06-30',
      timezone: 'America/Los_Angeles'
    })
    .execute()
  await db
    .insertInto('teams')
    .values([
      { id: 'tem_umpires_rockets', name: 'Demo Rockets' },
      { id: 'tem_umpires_comets', name: 'Demo Comets' }
    ])
    .execute()
  await db
    .insertInto('season_teams')
    .values(
      [
        'tem_umpires_rockets',
        'tem_umpires_comets',
        'tem_umpires_a',
        'tem_umpires_b'
      ].map(team => ({ season_id: 'sea_umpire_spring', team_id: team }))
    )
    .execute()
  const springEvening = new Date('2027-04-14T01:30:00Z')
  await db
    .insertInto('games')
    .values([
      {
        id: 'gam_umpires_rockets',
        home_team_id: 'tem_umpires_rockets',
        away_team_id: 'tem_umpires_comets',
        season_id: 'sea_umpire_spring',
        start_at: springEvening,
        timezone: 'America/Los_Angeles',
        venue: 'Demo Field 1'
      },
      {
        id: 'gam_umpires_busy',
        home_team_id: 'tem_umpires_a',
        away_team_id: 'tem_umpires_b',
        season_id: 'sea_umpire_spring',
        start_at: springEvening,
        timezone: 'America/Los_Angeles',
        venue: 'Demo Field 2'
      }
    ])
    .execute()
  // A second league 101 runs, where Hank Aaron umpires too.
  await db
    .insertInto('leagues')
    .values({
      id: 'lea_umpires_b',
      name: 'Demo Umpire League B',
      umpire_management: true
    })
    .execute()
  await db
    .insertInto('scope_roles')
    .values({
      id: 'srl_umpires_b',
      user_id: owner,
      scope_type: 'league',
      scope_id: 'lea_umpires_b',
      role: 'admin',
      granted_by: null
    })
    .execute()
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
  await db
    .insertInto('league_umpires')
    .values({
      league_id: 'lea_umpires_b',
      user_id: userIdOfGumbo(301),
      granted_by: owner
    })
    .execute()
  await db
    .insertInto('umpire_assignments')
    .values({
      game_id: 'gam_umpires_busy',
      slot: 'uty_plate:1',
      user_id: userIdOfGumbo(302),
      assigned_by: owner
    })
    .execute()
  // Willie Mays saved weekday evenings, Jackie Robinson weekends only, and
  // Hank Aaron nothing.
  await db
    .insertInto('umpire_availability')
    .values([
      {
        user_id: userIdOfGumbo(302),
        league_id: league,
        days: [0, 1, 2, 3, 4],
        from_time: '17:00',
        to_time: '23:00',
        timezone: 'America/Los_Angeles'
      },
      {
        user_id: userIdOfGumbo(303),
        league_id: league,
        days: [5, 6],
        timezone: 'America/Los_Angeles'
      }
    ])
    .execute()
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
