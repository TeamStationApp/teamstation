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

import { STACK_API, STACK_DATABASE, STACK_ORIGIN } from './legacyStack'

export interface Invocation {
  label?: string
  /** The device it runs on: web, none, ios-phone, android-phone, ios-sim, ipad-sim. */
  needs?: string
  args?: string[]
  env?: Record<string, string>
  /** Recorded blocked with this reason instead of being run. */
  blocked?: string
  /** Done just before it runs: a fixture it must find as it was made. */
  prepare?: () => void
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
    // Kept whole beside the stack's logs: a result line holds only its end.
    writeFileSync(
      join(dir('_stack'), 'playerLayouts-fixture.log'),
      `${made.stdout}\n${made.stderr}`
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

/**
 * chat.e2e's E11 media, made once: a photo, and a clip of more than thirty
 * seconds, about 20 MB, that Chrome plays (H.264). Answers their directory.
 */
export function chatMedia(ffmpeg = process.env.TS_FFMPEG ?? 'ffmpeg'): string {
  const media = dir('fixtures')
  const made = (name: string, args: string[]): void => {
    if (existsSync(join(media, name))) return
    const run = spawnSync(
      ffmpeg,
      ['-loglevel', 'error', '-y', ...args, join(media, name)],
      { encoding: 'utf8' }
    )
    if (run.status !== 0)
      throw new Error(`making ${name} failed: ${run.stderr.slice(-1000)}`)
  }
  made('photo.jpg', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720',
    '-frames:v',
    '1'
  ])
  made('clip.mp4', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30:duration=40',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    '4M',
    '-movflags',
    '+faststart'
  ])
  return media
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

/**
 * The existing-player fixture, a game-only guest on the Falcons' side of its
 * game, and a one-time sign-in link for their coach that lands on the game.
 */
const gameRosterLayout: Recipe = async context => {
  const made = await existingPlayer('src/app/scoring/gameRosterLayout.e2e.ts')(
    context
  )
  if (made.some(run => run.blocked != null)) return made
  const linked = spawnSync(
    process.execPath,
    [
      '-r',
      'sucrase/register',
      'scripts/e2e/gameRosterLayout/fixture.ts',
      '--origin',
      STACK_ORIGIN
    ],
    { cwd: context.cwd, encoding: 'utf8' }
  )
  if (linked.status !== 0) {
    return [
      {
        blocked: `gameRosterLayout fixture failed: ${linked.stderr.slice(-300)}`
      }
    ]
  }
  const { url } = JSON.parse(linked.stdout.trim().split('\n').pop() ?? '{}')
  return made.map(run => ({
    ...run,
    env: { ...run.env, ROSTER_TEST_URL: url }
  }))
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

/**
 * The scenarios that use the announcer: its speaker is offered only by a
 * server with speech (`narration` in its health), as noAnnouncer checks.
 */
const REPLAY_SPEECH = new Set([
  'replay',
  'announcer',
  'liveAnnouncer',
  'finalAnnouncer',
  'rewindAnnouncer',
  'scorers'
])

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

/**
 * Concurrent scoring in Chromium against the stack, a freshly seeded game for
 * each run as its README asks. The fixture holds the fake accounts'
 * passwords, so it is written to a private temporary file, never to the
 * synced artifacts. Network recovery shapes two phones' links.
 */
const concurrentScoring: Recipe = async context => {
  const runs: Array<{
    label: string
    args: string[]
    env?: Record<string, string>
  }> = [
    ...['updates', 'follow', 'lineups', 'four-innings', 'stale-tail'].map(
      scenario => ({ label: scenario, args: ['--scenario', scenario] })
    ),
    ...['0', '1'].flatMap(older =>
      ['0', '1'].map(first => ({
        label: `conflicts-older${older}-first${first}`,
        args: ['--scenario', 'conflicts'],
        env: {
          TS_CONCURRENT_OLDER_AUTHOR: older,
          TS_CONCURRENT_FIRST_AUTHOR: first
        }
      }))
    )
  ]
  const fixtures = mkdtempSync(join(tmpdir(), 'concurrentScoring-'))
  const invocations: Invocation[] = []
  for (const run of runs) {
    const fixture = join(fixtures, `${run.label}.json`)
    const seeded = spawnSync(
      process.execPath,
      ['-r', 'sucrase/register', 'src/test/concurrentScoring/seed.ts'],
      {
        cwd: context.cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          TS_CONCURRENT_DATABASE_NAME: STACK_DATABASE,
          TS_CONCURRENT_FIXTURE: fixture
        }
      }
    )
    invocations.push(
      seeded.status === 0
        ? {
            label: run.label,
            needs: 'web',
            args: [...run.args, '--surface', 'chromium'],
            env: {
              ...run.env,
              TS_CONCURRENT_ORIGIN: STACK_ORIGIN,
              TS_CONCURRENT_FIXTURE: fixture,
              TS_CONCURRENT_ARTIFACTS: dir(`concurrentScoring.e2e/${run.label}`)
            }
          }
        : {
            label: run.label,
            blocked: `the concurrent scoring seed failed: ${seeded.stderr.slice(-300)}`
          }
    )
  }
  invocations.push({
    label: 'network-recovery',
    blocked:
      'shapes two phones through the bench network shaper (TS_NETWORK_SHAPING_URL, TS_CONCURRENT_IP_A/B)'
  })
  return invocations
}

/**
 * The button icons on the web from their own fixture page, built here. The
 * native surfaces need the fixture apps scripts/build-button-icons-native.mjs
 * builds, installed on a leased device.
 */
const buttonIcons: Recipe = async context => {
  const fixture = dir('buttonIcons.e2e/fixture')
  const built = spawnSync(
    process.execPath,
    ['scripts/build-button-icons-fixture.mjs'],
    {
      cwd: context.cwd,
      encoding: 'utf8',
      env: { ...process.env, TS_ICON_FIXTURE_DIR: fixture }
    }
  )
  const native =
    'needs the native fixture app built and installed on a leased device'
  return [
    built.status === 0
      ? {
          label: 'web',
          needs: 'web',
          env: { TS_ICON_FIXTURE_DIR: fixture, TS_ICON_SURFACE: 'web' }
        }
      : {
          label: 'web',
          blocked: `the button icon fixture did not build: ${built.stderr.slice(-300)}`
        },
    { label: 'ios', blocked: native },
    { label: 'android', blocked: native }
  ]
}

export const RECIPES: Record<string, Recipe> = {
  'src/app/scoring/concurrentScoring.e2e.ts': concurrentScoring,
  'src/test/buttonIcons.e2e.ts': buttonIcons,
  'src/test/buttonIcons.gallery.e2e.ts': async () => [
    {
      label: 'ios',
      blocked:
        'needs the native gallery fixture app built and installed on a leased device'
    },
    {
      label: 'android',
      blocked:
        'needs the native gallery fixture app built and installed on a leased device'
    }
  ],
  'src/app/chat/chat.e2e.ts': async context => [
    ...(tableRecipe(context.cwd, 'src/app/chat/chat.e2e.ts') ?? [{}]).map(
      run => ({ ...run, env: { ...run.env, TS_CHAT_FIXTURES: chatMedia() } })
    )
  ],
  // It reads the browser profiles chat.e2e signed in with: chat.e2e runs
  // first when this sweep has not run it.
  'src/app/chat/chatHistory.e2e.ts': async context => {
    const file = 'src/app/chat/chat.e2e.ts'
    const profiles = join(dir('chat.e2e'), 'profiles')
    if (!existsSync(profiles))
      for (const run of await RECIPES[file](context))
        await context.run(file, run)
    if (!existsSync(profiles))
      return [{ blocked: 'chat.e2e left no browser profiles to read' }]
    return tableRecipe(context.cwd, 'src/app/chat/chatHistory.e2e.ts') ?? [{}]
  },
  'src/test/scoreboardServer.e2e.ts': async () => {
    const state = join(dir('scoreboardServer.e2e'), 'state.json')
    return ['seed', 'e1', 'e2', 'e3', 'e4', 'e5'].map(step => ({
      label: step,
      args: ['--step', step],
      env: { TS_E2E_STATE: state }
    }))
  },
  'scripts/e2e/scoreboardLog/e2.mjs': scoreboardLog(),
  // It reads back the scoring and log changes e2 makes on the same game: e2
  // runs first, whichever droplet or order the sweep gave them.
  'scripts/e2e/scoreboardLog/e3.mjs': async context => {
    const runs = await scoreboardLog()(context)
    if (runs.some(run => run.blocked != null)) return runs
    const file = 'scripts/e2e/scoreboardLog/e2.mjs'
    for (const run of await RECIPES[file](context))
      if ((await context.run(file, { ...run, label: 'for-e3' })) !== 0)
        return [{ blocked: 'e2 did not leave the game its changes' }]
    return runs
  },
  'scripts/e2e/scoreboardLog/e4.mjs': scoreboardLog(['--offset', '1234']),
  // It plays the recordings of the fake broadcaster's HEVC in Chrome.
  'scripts/e2e/scoreboardLog/e5.mjs': async context =>
    (await scoreboardLog()(context)).map(run =>
      run.blocked == null ? { ...run, needs: 'hevc' } : run
    ),
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
  'src/app/scoring/gameRosterLayout.e2e.ts': gameRosterLayout,
  // The names fixture in the stack's database, kept out of the synced
  // artifacts; the scorer signs in with the code the stack API logs.
  'src/app/scoring/playerNames.e2e.ts': async context => {
    const made = spawnSync(
      process.execPath,
      ['-r', 'sucrase/register', 'src/server/dev/namesFixture.ts'],
      { cwd: context.cwd, encoding: 'utf8' }
    )
    if (made.status !== 0)
      return [
        { blocked: `the names fixture failed: ${made.stderr.slice(-300)}` }
      ]
    const fixture = join(
      mkdtempSync(join(tmpdir(), 'playerNames-')),
      'fixture.json'
    )
    writeFileSync(fixture, made.stdout, { mode: 0o600 })
    return (
      tableRecipe(context.cwd, 'src/app/scoring/playerNames.e2e.ts') ?? [
        { needs: 'web' }
      ]
    ).map(run => ({
      ...run,
      env: {
        ...run.env,
        PLAYER_NAMES_FIXTURE: fixture,
        PLAYER_NAMES_API_LOG: '{stack:apiLog}'
      }
    }))
  },
  // Each scenario finds the seed's games as the seed made them: one that
  // scores on the game in progress leaves its play there for the next.
  'src/app/replay/replay.e2e.ts': async context => {
    const prepare = (): void => {
      seedReplay(context.cwd)
    }
    const runs: Invocation[] = []
    // `before` was the proof on the build without these controls, which
    // expects them absent: on this build only `after` is a test.
    for (const scenario of REPLAY_TWICE)
      runs.push({
        label: scenario,
        args: [],
        env: { REPLAY_SCENARIO: scenario, REPLAY_PHASE: 'after' },
        prepare
      })
    for (const scenario of REPLAY_ONCE) {
      runs.push(
        REPLAY_SPEECH.has(scenario) && !context.speech
          ? {
              label: scenario,
              blocked: 'no xAI speech key in the secrets file or the vault'
            }
          : {
              label: scenario,
              args: [],
              env: { REPLAY_SCENARIO: scenario },
              prepare
            }
      )
    }
    return runs
  }
}
