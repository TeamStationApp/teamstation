import { readFileSync } from 'node:fs'

import { userIdOfGumbo } from '../../common/userId'
import { accountHarness } from '../../test/accountHarness'
import { chatTestAnthropic } from '../claudeKeys'
import { groupRoutes } from '../routes/groups'
import { scheduleRoutes } from '../routes/schedule'
import { statsRoutes } from '../routes/stats'
import { tessRoutes } from '../routes/tess'
import type { StoredBlock } from './conversation'

/**
 * Tess against the real model, six cases: an off-topic request is declined
 * with no tool call; "where are my team's settings" is answered with a path
 * link; adding a game ends in a proposed change, never a write; a stats
 * question reads the API; a chart request draws one; recording a pitch is
 * refused. Each case is one message to a fresh conversation, through the
 * real routes, the real API and a scratch database. Not part of `npm test`,
 * and it costs money: about a dozen requests.
 *
 *   TS_TESS_CONFIG=<config.json> node -r sucrase/register src/server/tess/tess.integration.ts \
 *     [--case <n>] [--max-requests <n>]
 *
 * `--case <n>` runs only the nth case (from 1), for a few requests instead,
 * and `--max-requests <n>` refuses any Messages request past the nth, so a
 * case that keeps calling tools fails rather than spends.
 *
 * The key is the Claude chat test key in 1Password
 * ("Claude API key - chat - test"). It is never printed. A model or base URL
 * in `TS_TESS_CONFIG` (or serverConfig.json) is honored; that file's key is not.
 */

interface Case {
  name: string
  text: string
  check: (turn: Turn) => string | null
}

/** What one message produced: Tess's blocks, and what she proposed. */
interface Turn {
  blocks: StoredBlock[]
  answer: string
  changes: Array<{ method: string; path: string }>
  writes: number
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
    name: 'adding a game ends in confirmChange, never a write',
    text: `Add a game against Demo Eagles on ${saturdayAhead()} at 10am.`,
    check: turn =>
      turn.writes > 0
        ? 'something was written'
        : turn.changes.some(
              change =>
                change.method === 'POST' && change.path.includes('/games')
            )
          ? null
          : `no game proposed (${JSON.stringify(turn.changes)})`
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
  let model = 'claude-sonnet-5-5'
  const configPath = process.env.TS_TESS_CONFIG ?? 'serverConfig.json'
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      tess?: { model?: string }
    }
    if (typeof raw.tess?.model === 'string' && raw.tess.model !== '')
      model = raw.tess.model
  } catch {
    // The test key does not come from this file.
  }
  const keys = chatTestAnthropic()
  if (keys == null) {
    console.log('No Claude chat test key; nothing to run.')
    return 1
  }
  const settings = { apiKey: keys.apiKey, baseUrl: keys.baseUrl, model }
  console.log(`model ${settings.model}`)

  let requests = 0
  const counted = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/messages')) {
      if (requests >= budget)
        throw new Error(`more than ${budget} Messages requests`)
      requests += 1
    }
    return await fetch(url as string, init)
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
    let failed = 0
    for (const at of chosen) {
      const each = CASES[at]
      for (const table of ['tess_messages', 'tess_changes'] as const)
        await h.db.deleteFrom(table).execute()
      const before = requests
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
          .select(['method', 'path'])
          .execute(),
        writes: (await writes(h.db)) - writesBefore
      }
      const problem = each.check(turn)
      if (problem != null) failed += 1
      const tools = toolsUsed(turn)
      console.log(
        `${problem == null ? 'PASS' : 'FAIL'} ${at + 1} ${each.name}` +
          (problem == null ? '' : `: ${problem}`) +
          ` (requests ${requests - before}; tools ${tools.length === 0 ? 'none' : tools.join(', ')})`
      )
      console.log(
        `  Tess: ${turn.answer.replace(/\s+/g, ' ').slice(0, 300)}${turn.answer.length > 300 ? '…' : ''}`
      )
    }
    const usage = await h.db
      .selectFrom('tess_usage_weeks')
      .select(['input_tokens', 'output_tokens', 'requests'])
      .execute()
    console.log(
      `${chosen.length - failed} of ${chosen.length} passed; ${requests} Messages requests; tokens in ${usage[0]?.input_tokens ?? 0}, out ${usage[0]?.output_tokens ?? 0}`
    )
    return failed === 0 ? 0 : 1
  } finally {
    await h.close()
  }
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
