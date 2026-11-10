/**
 * Legacy files that are more than one command: steps run in order, a
 * scenario per invocation, or arguments taken from an earlier script.
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { STACK_API, STACK_ORIGIN } from './legacyStack'

export interface Invocation {
  label?: string
  /** The device it runs on: web, none, ios-phone, android-phone, ios-sim, ipad-sim. */
  needs?: string
  args?: string[]
  env?: Record<string, string>
  /** Recorded blocked with this reason instead of being run. */
  blocked?: string
}

export interface RecipeContext {
  cwd: string
  /** Runs one invocation of another file, for a recipe that needs its output. */
  run: (file: string, invocation: Invocation) => Promise<number>
  /** Restarts the API, without `speech` when `speech` is false. */
  restartApi: (options: { speech: boolean }) => Promise<void>
  speech: boolean
}

export type Recipe = (context: RecipeContext) => Promise<Invocation[]>

const ROOT = join(homedir(), '.cursor/artifacts/202611080444-e2eSuite/legacy')

function dir(name: string): string {
  const path = join(ROOT, name)
  mkdirSync(path, { recursive: true })
  return path
}

interface ScoreboardState {
  games: Record<string, string>
  runner: string
  other: string
}

const SCOREBOARD_STATE = join(dir('_stack'), 'scoreboard-state.json')
let scoreboardSeeded: Promise<ScoreboardState | undefined> | undefined

/** The scoreboard seed's games and tokens, seeding once per sweep. */
async function scoreboardSeed(
  context: RecipeContext
): Promise<ScoreboardState | undefined> {
  scoreboardSeeded ??= (async () => {
    const code = await context.run('src/test/scoreboardServer.e2e.ts', {
      label: 'seed-for-log',
      args: ['--step', 'seed'],
      env: { TS_E2E_STATE: SCOREBOARD_STATE }
    })
    if (code !== 0 || !existsSync(SCOREBOARD_STATE)) return undefined
    return JSON.parse(readFileSync(SCOREBOARD_STATE, 'utf8')) as ScoreboardState
  })()
  return await scoreboardSeeded
}

const PLAYER_FIXTURE = join(dir('_stack'), 'playerLayouts-fixture.json')
let playerFixtureMade = false

/** Whether `source` watches the player-layouts fixture's games. */
export function needsPlayerFixture(source: string): boolean {
  return (
    source.includes('playerLayoutsRig') || source.includes('TS_PLAYER_FIXTURE')
  )
}

/** The player-layouts games on the stack, made once per database. */
export function playerFixtureEnv(cwd: string): Record<string, string> {
  if (!playerFixtureMade) {
    const made = spawnSync(
      process.execPath,
      [
        '-r',
        'sucrase/register',
        'scripts/e2e/playerLayouts/fixture.ts',
        '--out',
        PLAYER_FIXTURE
      ],
      { cwd, encoding: 'utf8', timeout: 30 * 60 * 1000 }
    )
    if (made.status !== 0) {
      throw new Error(
        `playerLayouts fixture failed: ${(made.stderr !== '' ? made.stderr : made.stdout).slice(-2000)}`
      )
    }
    playerFixtureMade = true
  }
  return { TS_PLAYER_FIXTURE: PLAYER_FIXTURE, TS_PLAYER_APP: STACK_ORIGIN }
}

/** Forgets seeds that lived in a database something has since dropped. */
export function forgetSeeds(): void {
  scoreboardSeeded = undefined
  playerFixtureMade = false
}

/** Whether `source` signs in as the chat seed's people. */
export function needsChatSeed(source: string): boolean {
  return source.includes('seed.txt') || source.includes('chatSeedTable')
}

/** Rebuilds the stack's database with the chat fixture, its table in `artifacts`. */
export function chatReset(cwd: string, artifacts: string): void {
  const reset = spawnSync('bash', ['scripts/chat-e2e-reset.sh', artifacts], {
    cwd,
    encoding: 'utf8'
  })
  if (reset.status !== 0) {
    throw new Error(`chat-e2e-reset failed: ${reset.stderr.slice(-2000)}`)
  }
  forgetSeeds()
}

function scoreboardLog(extra: string[] = []): Recipe {
  return async context => {
    const state = await scoreboardSeed(context)
    // The game ten minutes into its slot: its scoreboard is open.
    const game = state?.games['-10m']
    if (state == null || game == null) {
      return [{ blocked: 'the scoreboard seed printed no game id' }]
    }
    return [
      {
        args: ['--game', game, '--api', STACK_API, ...extra],
        env: { TS_TOKEN: state.runner }
      }
    ]
  }
}

/**
 * A fresh existing-player fixture in the stack's database, at the path the
 * script reads, then the script's table rows (or its header's one run). A
 * fixture file left from another database holds passwords it no longer has.
 */
function existingPlayer(file: string): Recipe {
  return async context => {
    const made = spawnSync(
      process.execPath,
      ['-r', 'sucrase/register', 'scripts/e2e/existingPlayer/fixture.ts'],
      { cwd: context.cwd, encoding: 'utf8' }
    )
    if (made.status !== 0) {
      return [
        {
          blocked: `existingPlayer fixture failed: ${made.stderr.slice(-300)}`
        }
      ]
    }
    return tableRecipe(context.cwd, file) ?? [{}]
  }
}

const REPLAY_TWICE = ['pills', 'controls', 'liveInPlay', 'board']
const REPLAY_ONCE = [
  'replay',
  'announcer',
  'live',
  'liveAnnouncer',
  'finalAnnouncer',
  'noAnnouncer',
  'rewind',
  'rewindLive',
  'rewindAnnouncer',
  'scorers'
]

function seedReplay(cwd: string): void {
  const seeded = spawnSync(
    process.execPath,
    ['-r', 'sucrase/register', 'src/server/dev/replaySeed.ts'],
    { cwd, encoding: 'utf8' }
  )
  if (seeded.status !== 0) {
    throw new Error(`replaySeed failed: ${seeded.stderr.slice(-2000)}`)
  }
}

const NO_PREVIEW =
  'the scoring fixture preview SCORING_TEST_URL names is not in the repository: nothing serves a scoring screen that opens with no sign-in'
const NO_HOST =
  'the offline native host this script launches is not in the repository: index.js registers only Root'

/** Paths that need a seat or something the repository does not contain. */
export const BLOCKED: Record<string, string> = {
  'scripts/scoring-feedback-safari.mjs': NO_PREVIEW,
  'scripts/scoring-field-gestures-safari.mjs': NO_PREVIEW,
  'scripts/scoring-player-setup-safari.mjs': NO_PREVIEW,
  'scripts/scoring-reanimated-safari.mjs': NO_PREVIEW,
  'scripts/scoring-roster-hold-safari.mjs': NO_PREVIEW,
  'scripts/scoring-roster-safari.mjs': NO_PREVIEW,
  'scripts/scoring-rules-safari.mjs': NO_PREVIEW,
  'scripts/scoring-safari.mjs': NO_PREVIEW,
  'scripts/scoring-teams-bunts-safari.mjs': NO_PREVIEW,
  'scripts/scoring-ui-updates-safari.mjs': NO_PREVIEW,
  'scripts/scoring-player-setup-native.mjs': NO_HOST,
  'scripts/scoring-roster-hold-native.mjs': NO_HOST,
  'mobile/test/teamStationAppSignInLink.e2e.ts':
    'needs a seat: its TS_API_BASE_URL is a seat reached through a Mason build',
  'src/app/quietStreamNative.e2e.ts':
    'the bundle app.teamstation.app.quietqa it launches has no build recipe in the repository',
  'src/app/chat/chat2.e2e.ts':
    'CHAT2_FIXTURE_FILE needs CHAT_RECOVERY_OWNER_FILE, private server settings nothing in the repository writes',
  'src/app/components/cardSpacing.e2e.ts':
    'the synthetic preview it opens (cardSpacingPreview.tsx) is not an entry of any build in the repository',
  'src/app/uiFixes.e2e.ts':
    'needs a copy of production in the database (game gam_demo000000000001), which this task does not have',
  'src/app/passwordForm.e2e.ts':
    'the benchmark app PASSWORD_BENCHMARK_APP names has no build recipe in the repository',
  'src/app/passwordNative.e2e.ts':
    'the benchmark app PASSWORD_BENCHMARK_APP names has no build recipe in the repository',
  'scripts/e2e/observability/run.ts':
    'checks what reaches a deployed log collector: OBSERVABILITY_LOG_URL is that https collector and OBSERVABILITY_SECRETS its credentials, neither of which a local stack has',
  'src/app/settingsPillSweep.e2e.ts':
    'compares against support/pill-sweep-before.json and before-fixture.json, captured once for an earlier task; nothing in the repository makes them',
  'scripts/e2e/playbackReliability/playbackReliability.e2e.ts':
    'needs a real source game with uploads and a 1Password test account on a deployed server'
}

/** The scenarios of files that run once per mode, from `e2e/legacyRuns.json`. */
export function tableRecipe(
  cwd: string,
  file: string
): Invocation[] | undefined {
  const table = JSON.parse(
    readFileSync(join(cwd, 'e2e/legacyRuns.json'), 'utf8')
  ) as Record<string, Invocation[]>
  return table[file]
}

export const RECIPES: Record<string, Recipe> = {
  'src/test/scoreboardServer.e2e.ts': async () => {
    const state = join(dir('scoreboardServer.e2e'), 'state.json')
    return ['seed', 'e1', 'e2', 'e3', 'e4', 'e5'].map(step => ({
      label: step,
      args: ['--step', step],
      env: { TS_E2E_STATE: state }
    }))
  },
  'scripts/e2e/scoreboardLog/e2.mjs': scoreboardLog(),
  'scripts/e2e/scoreboardLog/e3.mjs': scoreboardLog(),
  'scripts/e2e/scoreboardLog/e4.mjs': scoreboardLog(['--offset', '1234']),
  'scripts/e2e/scoreboardLog/e5.mjs': scoreboardLog(),
  'src/app/autoScheduler.e2e.ts': async () => [{ args: [] }],
  // The scoreboard seed's open game, and its scorer's token in a private file
  // (never the synced artifacts).
  'src/app/screens/homeCoalesce.e2e.ts': async context => {
    const file = 'src/app/screens/homeCoalesce.e2e.ts'
    const state = await scoreboardSeed(context)
    const game = state?.games['-10m']
    if (state == null || game == null) {
      return [{ blocked: 'the scoreboard seed printed no game id' }]
    }
    const tokenFile = join(
      mkdtempSync(join(tmpdir(), 'homeCoalesce-')),
      'token'
    )
    writeFileSync(tokenFile, state.runner, { mode: 0o600 })
    const env = {
      TS_HOME_COALESCE_TOKEN_FILE: tokenFile,
      TS_HOME_COALESCE_GAME: game
    }
    return (tableRecipe(context.cwd, file) ?? [{}]).map(run => ({
      ...run,
      env: { ...run.env, ...env }
    }))
  },
  // The replay seed's final game, whose pitchers are listed in mound order.
  'src/app/screens/boxScoreOrder.e2e.ts': async context => {
    seedReplay(context.cwd)
    return [
      {
        env: {
          REPLAY_GAME: 'gam_replaySeedFinal',
          REPLAY_SHOT: 'box-score-pitchers-after',
          REPLAY_EXPECT: 'mound',
          REPLAY_ARTIFACTS: '{legacy:boxScoreOrder.e2e}'
        }
      }
    ]
  },
  // A fresh fixture in the stack's database, at the path the script reads.
  'scripts/e2e/existingPlayer/existingPlayer.native.e2e.ts': existingPlayer(
    'scripts/e2e/existingPlayer/existingPlayer.native.e2e.ts'
  ),
  'src/app/scoring/existingPlayer.e2e.ts': existingPlayer(
    'src/app/scoring/existingPlayer.e2e.ts'
  ),
  'src/app/screens/teamPlayers.e2e.ts': existingPlayer(
    'src/app/screens/teamPlayers.e2e.ts'
  ),
  'src/app/replay/replay.e2e.ts': async context => {
    seedReplay(context.cwd)
    const runs: Invocation[] = []
    for (const scenario of REPLAY_TWICE) {
      for (const phase of ['before', 'after']) {
        runs.push({
          label: `${scenario}-${phase}`,
          args: [],
          env: { REPLAY_SCENARIO: scenario, REPLAY_PHASE: phase }
        })
      }
    }
    for (const scenario of REPLAY_ONCE) {
      const announcer =
        scenario.endsWith('nnouncer') && scenario !== 'noAnnouncer'
      runs.push(
        announcer && !context.speech
          ? {
              label: scenario,
              blocked: 'no xAI speech key in the secrets file or the vault'
            }
          : {
              label: scenario,
              args: [],
              env: { REPLAY_SCENARIO: scenario }
            }
      )
    }
    return runs
  }
}
