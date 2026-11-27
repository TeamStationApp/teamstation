import { expect } from 'chai'

import { TeamStationClient, type TessMessage } from '../../../../src/common/api'
import { passwordBytes } from '../../../../src/common/passwordProtocol'
import { nativeArgon } from '../../../../src/server/auth/passwords'
import {
  defineHarness,
  type HarnessContext,
  type HarnessScenario
} from '../../../core/spec'

/**
 * Tess against the real model, through the stack's real API: its
 * `real-model` service gives the API the caller's key, which this test never
 * holds. Each scenario seeds the `tess` world (its admin runs Demo Hawks, with
 * finals against Demo Eagles) and sends one message to a fresh conversation,
 * and costs money: a few requests.
 */

interface Case {
  text: string
  check: (turn: Turn) => string | null
}

/** What one message produced, as the API answers it: Tess's reply and what she proposed. */
interface Turn {
  answer: string
  /** The labels of the tool calls she made (`stepLabel`). */
  steps: string[]
  changes: Array<{ method: string; path: string; status: string }>
  /** Whether the API wrote anything besides Tess's own messages, or the team's games changed. */
  wrote: boolean
}

/** A tool call is a step; reading the API is "Reading: …" (`stepLabels.ts`). */
const toolsUsed = (turn: Turn): string[] => turn.steps
const readsTheApi = (turn: Turn): boolean =>
  turn.steps.some(
    step => step === 'Reading the API' || step.startsWith('Reading: ')
  )

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

/** The team's games, as ids and scores: what a write would change. */
async function gamesOf(
  client: TeamStationClient,
  teamId: string
): Promise<string> {
  const games = await client.teamGames(teamId)
  return JSON.stringify(games.map(game => game.id).sort())
}

/** Writes the API took, besides the messages to Tess: the audit log's rows, read on the stack. */
async function writes(ctx: HarnessContext): Promise<number> {
  const control = ctx.stack.control
  if (control == null) throw new Error('this stack has no control routes')
  const { rows } = await control.sql(
    "SELECT count(*)::int AS n FROM audit_log WHERE path NOT LIKE '/api/v1/me/tess%'"
  )
  return Number(rows[0]?.n ?? 0)
}

async function ask(ctx: HarnessContext, each: Case): Promise<void> {
  const world = await ctx.fixture('tess')
  const admin = world.accounts.admin
  const baseUrl = `${ctx.stack.origin.replace(/\/+$/, '')}/api/v1`
  const session = await new TeamStationClient({
    baseUrl,
    passwordKdf: async (password, parameters) =>
      await nativeArgon(passwordBytes(password), parameters)
  }).signInWithPassword(admin.email, admin.password)
  const signedIn = new TeamStationClient({ baseUrl, token: session.token })
  const team = world.ids.teamA
  const before = await gamesOf(signedIn, team)
  const writesBefore = await writes(ctx)
  const sent: TessMessage[] = await signedIn.sendTessMessage(each.text)
  const replies = sent.filter(message => message.role === 'assistant')
  expect(replies.length, 'Tess answered').greaterThan(0)
  const turn: Turn = {
    answer: replies.map(reply => reply.text).join('\n\n'),
    steps: replies.flatMap(reply => (reply.steps ?? []).map(s => s.label)),
    changes: replies.flatMap(reply =>
      reply.changes.map(change => ({
        method: change.method,
        path: change.path,
        status: change.status
      }))
    ),
    wrote: false
  }
  // Nothing runs until the person holds Confirm: a change that ran, or a
  // game that appeared or went, is a write the turn made.
  turn.wrote =
    (await writes(ctx)) - writesBefore > 0 ||
    turn.changes.some(change => change.status !== 'pending') ||
    (await gamesOf(signedIn, team)) !== before
  expect(each.check(turn)).equals(null)
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
      turn.wrote
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
    check: turn => (readsTheApi(turn) ? null : 'api_get was not called')
  },
  'chart-request-draws-a-chart-or-table': {
    text: 'Chart our runs per game.',
    check: turn =>
      /<svg|<table/i.test(turn.answer) ? null : 'no <svg> or <table>'
  },
  'recording-a-pitch-is-refused': {
    text: 'Record a strike for the batter in our game against Demo Eagles.',
    check: turn =>
      turn.wrote
        ? 'something was written'
        : turn.changes.length > 0
          ? `proposed ${JSON.stringify(turn.changes)}`
          : turn.answer === ''
            ? 'no answer'
            : null
  }
}

const scenarios: Record<string, HarnessScenario> = {}
for (const [name, each] of Object.entries(CASES)) {
  scenarios[name] = async ctx => {
    await ask(ctx, each)
  }
}

export default defineHarness({
  id: 'assistant/chat/real-model',
  title:
    'Against the real model, Tess declines, links, proposes, reads and refuses as her prompt says',
  kind: 'integration',
  covers: ['src/server/tess/**', 'src/server/routes/tess.ts'],
  stack: 'isolated',
  fixtures: ['tess'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: ['real-model'],
  apps: [],
  secrets: [],
  costUsd: 0.05,
  minutes: 2,
  guards: [],
  faults: [],
  manual: false,
  scenarios
})
