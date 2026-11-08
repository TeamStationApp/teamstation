import { expect } from 'chai'

import type { StoredBlock } from '../../../../src/server/tess/conversation'
import type { accountHarness } from '../../../../src/test/accountHarness'
import { defineE2e, type E2eContext, type Scenario } from '../../../core/spec'

/**
 * Tess against the real model, through the real routes, the real API and a scratch
 * database. Each scenario is one message to a fresh conversation, and costs money: a
 * few requests. The key is the suite's `anthropic` secret, and is never printed.
 */

/** Refuses any Messages request past this, so a case that keeps calling tools fails. */
const MAX_REQUESTS = 12

interface Case {
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
 * A Saturday two to three weeks ahead, written out ("Saturday, November 7, 2026"), so
 * the game asked for is never on a day that has already gone.
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
 * User 101 runs Demo Hawks, which has played four games against Demo Eagles this
 * season, all final.
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

async function ask(ctx: E2eContext, each: Case): Promise<void> {
  const { userIdOfGumbo } = await import('../../../../src/common/userId')
  const { accountHarness } = await import('../../../../src/test/accountHarness')
  const { groupRoutes } = await import('../../../../src/server/routes/groups')
  const { scheduleRoutes } =
    await import('../../../../src/server/routes/schedule')
  const { statsRoutes } = await import('../../../../src/server/routes/stats')
  const { tessRoutes } = await import('../../../../src/server/routes/tess')
  const settings = {
    apiKey: ctx.secret('anthropic'),
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-5-5'
  }

  let requests = 0
  const counted = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/messages')) {
      if (requests >= MAX_REQUESTS)
        throw new Error(`more than ${MAX_REQUESTS} Messages requests`)
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
    const writesBefore = await writes(h.db)
    const response = await h.request('POST', '/me/tess/messages', {
      text: each.text
    })
    expect(response.status).equals(200)
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
    expect(each.check(turn)).equals(null)
  } finally {
    await h.close()
  }
}

const CASES: Record<string, Case> = {
  'off-topic-declined-with-no-tool': {
    text: 'Write me a poem about cats.',
    check: turn =>
      toolsUsed(turn).length > 0
        ? `called ${toolsUsed(turn).join(', ')}`
        : turn.answer === '' || turn.answer.length > 600
          ? 'no short refusal'
          : null
  },
  'team-settings-answered-with-a-path-link': {
    text: "Where are my team's settings?",
    check: turn =>
      /\]\(\/[^)\s]*\s+"path"\)/.test(turn.answer)
        ? null
        : 'no link titled "path"'
  },
  'adding-a-game-proposes-and-writes-nothing': {
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
  'stats-question-reads-the-api': {
    text: 'How many runs has Demo Hawks scored in its games this season?',
    check: turn =>
      toolsUsed(turn).includes('api_get') ? null : 'api_get was not called'
  },
  'chart-request-draws-a-chart-or-table': {
    text: 'Chart our runs per game.',
    check: turn =>
      /<svg|<table/i.test(turn.answer) ? null : 'no <svg> or <table>'
  },
  'recording-a-pitch-is-refused': {
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
}

const scenarios: Record<string, Scenario> = {}
for (const [name, each] of Object.entries(CASES)) {
  scenarios[name] = async ctx => {
    await ask(ctx, each)
  }
}

export default defineE2e({
  id: 'assistant/chat/real-model',
  title:
    'Against the real model, Tess declines, links, proposes, reads and refuses as her prompt says',
  kind: 'integration',
  covers: ['src/server/tess/**', 'src/server/routes/tess.ts'],
  stack: 'none',
  fixtures: [],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['tess-model'],
  apps: [],
  secrets: ['anthropic'],
  costUsd: 0.05,
  minutes: 2,
  guards: [],
  faults: [],
  manual: false,
  scenarios
})
