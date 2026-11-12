/**
 * Runs legacy scripts one after another over the shared stack:
 *
 *   node -r sucrase/register e2e/core/legacySweep.ts <results file> [path…]
 *
 * With no paths it runs every path in `e2e/legacy.json` `modules`. Each line
 * of the results file is status, exit, path and reason, tab separated.
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { legacyCommand } from './legacyCommand'
import {
  BLOCKED,
  chatReset,
  type Invocation,
  needsChatSeed,
  needsPlayerFixture,
  playerFixtureEnv,
  RECIPES,
  tableRecipe
} from './legacyRecipes'
import {
  type LegacyStack,
  STACK_MEDIA_ORIGINS,
  stackArtifacts,
  startLegacyStack
} from './legacyStack'
import { type LegacyRun, runLegacy } from './runLegacy'

/**
 * The device variables for a run that needs `needs`, or undefined when this
 * sweep has no such device. A simulator run gets the simulator as its iOS device.
 */
function deviceFor(
  needs: string | undefined,
  stack: { speech: boolean }
): NodeJS.ProcessEnv | undefined {
  const env = process.env
  switch (needs) {
    case undefined:
    case 'web':
    case 'none':
      return {}
    // The stack's API holds a speech key: dictation is offered.
    case 'speech':
      return stack.speech ? {} : undefined
    // A browser here plays HEVC: Chrome on a Mac does, by VideoToolbox; on a
    // machine with no GPU (a server) it does not. E2E_HEVC=1 says it does.
    case 'hevc':
      return process.platform === 'darwin' || env.E2E_HEVC === '1'
        ? {}
        : undefined
    case 'ios-phone':
      return env.E2E_IOS_UDID == null
        ? undefined
        : { E2E_DEVICE: env.E2E_IOS_UDID }
    case 'android-phone':
      return env.E2E_ANDROID_SERIAL == null
        ? undefined
        : { E2E_DEVICE: env.E2E_ANDROID_SERIAL }
    case 'ios-sim':
    case 'ipad-sim':
      return env.E2E_SIM_UDID == null
        ? undefined
        : { E2E_IOS_UDID: env.E2E_SIM_UDID, E2E_DEVICE: env.E2E_SIM_UDID }
    default:
      return undefined
  }
}

/**
 * One run per alternative of a header value written `a|b|c`, which the plan
 * reads as each value the script accepts. A platform value picks its device.
 */
export function alternatives(source: string, file: string): Invocation[] {
  const command = legacyCommand(source, file)
  const choice = Object.entries(command.env).find(([, value]) =>
    /^[\w.-]+(\|[\w.-]+)+$/.test(value)
  )
  if (choice == null) return [{}]
  const [key, value] = choice
  return value.split('|').map(option => ({
    label: option,
    env: { [key]: option },
    needs:
      option === 'android'
        ? 'android-phone'
        : option === 'ios'
          ? 'ios-phone'
          : undefined
  }))
}

/**
 * `files` with each one that continues from another's run (`{legacy:<name>}`
 * in its table) moved to just after that one, so nothing resets the database
 * in between.
 */
export function continuingAfter(
  files: string[],
  table: (file: string) => Invocation[] | undefined
): string[] {
  const after = new Map<string, string[]>()
  const moved = new Set<string>()
  for (const file of files) {
    const from = /\{legacy:([^}]+)\}/.exec(JSON.stringify(table(file) ?? []))
    const earlier =
      from == null
        ? undefined
        : files.find(
            other => legacyArtifacts(other) === legacyArtifacts(`${from[1]}.x`)
          )
    if (earlier == null || earlier === file) continue
    after.set(earlier, [...(after.get(earlier) ?? []), file])
    moved.add(file)
  }
  return files
    .filter(file => !moved.has(file))
    .flatMap(file => [file, ...(after.get(file) ?? [])])
}

/** The directory `runLegacy` gives `file`'s artifacts. */
function legacyArtifacts(file: string): string {
  const name = file
    .split('/')
    .at(-1)!
    .replace(/\.[^.]+$/, '')
  return join(homedir(), '.cursor/artifacts/202611080444-e2eSuite/legacy', name)
}

/** Files whose own run takes longer than the default limit. */
const LONG: Record<string, number> = {
  'src/app/scoring/scoring.e2e.ts': 90 * 60 * 1000,
  // Its time-zone, settings and schedule checks run past twenty minutes.
  'src/app/screens/eventInfo2.e2e.ts': 40 * 60 * 1000
}

const DAEMONS = ['e2eSuite', 'e2eSuite-ios', 'e2eSuite-android']

function maestroBin(): string {
  try {
    const raw = JSON.parse(
      readFileSync(
        join(homedir(), '.config/teamstation-e2e/local.json'),
        'utf8'
      )
    ) as { maestroBin?: string }
    if (raw.maestroBin != null) return raw.maestroBin
  } catch {
    // No local settings: the shared install below.
  }
  return join(homedir(), '.maestro-d/bin/maestro-d')
}

function daemonPid(bin: string, name: string): number | undefined {
  const status = spawnSync(bin, ['status', '--daemon', name], {
    encoding: 'utf8',
    timeout: 20_000
  })
  if (status.status !== 0) return undefined
  const match = /pid (\d+)/.exec(status.stdout)
  return match == null ? undefined : Number(match[1])
}

/** A daemon built apart from its drivers finds them under `maestroHome`. */
function daemonEnv(): NodeJS.ProcessEnv {
  try {
    const raw = JSON.parse(
      readFileSync(
        join(homedir(), '.config/teamstation-e2e/local.json'),
        'utf8'
      )
    ) as { maestroHome?: string }
    if (raw.maestroHome != null) {
      return { ...process.env, MAESTRO_RUNNER_HOME: raw.maestroHome }
    }
  } catch {
    // No local settings: the daemon finds its drivers beside its binary.
  }
  return process.env
}

/** Stops `name` however it is stuck, then starts it fresh. */
export function restartDaemon(bin: string, name: string): void {
  const pid = daemonPid(bin, name)
  if (pid != null) {
    spawnSync(bin, ['stop', '--daemon', name], { timeout: 30_000 })
    try {
      process.kill(pid, 0)
      process.kill(pid, 'SIGKILL')
    } catch {
      // `stop` ended it already.
    }
  }
  const started = spawnSync(
    bin,
    ['start', '--daemon', name, '--idle-timeout', '0'],
    { encoding: 'utf8', timeout: 60_000, env: daemonEnv() }
  )
  if (started.status !== 0) {
    throw new Error(`maestro-d start ${name} failed: ${started.stderr}`)
  }
}

/** Starts a daemon that is not running; leaves a running one alone. */
function ensureDaemon(bin: string, name: string): void {
  if (daemonPid(bin, name) == null) restartDaemon(bin, name)
}

async function main(): Promise<void> {
  const [results, ...given] = process.argv.slice(2)
  if (results == null) throw new Error('usage: legacySweep <results> [path…]')
  const cwd = process.cwd()
  const listed =
    given.length > 0
      ? given
      : Object.keys(
          (
            JSON.parse(readFileSync(join(cwd, 'e2e/legacy.json'), 'utf8')) as {
              modules: Record<string, string>
            }
          ).modules
        )
  const files = continuingAfter(listed, file => tableRecipe(cwd, file))
  const defaultTimeout = Number(process.env.LEGACY_TIMEOUT_MS ?? 20 * 60 * 1000)
  const bin = maestroBin()
  // The loopback harnesses serve `dist` and put their media on a port of
  // their own, so this build's policy lets in any loopback port.
  const built = spawnSync(process.execPath, ['src/build.mjs'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      TS_API_BASE_URL: '/api/v1',
      TS_MEDIA_ORIGINS: STACK_MEDIA_ORIGINS
    }
  })
  if (built.status !== 0) throw new Error(`web build failed: ${built.stderr}`)
  const stack: LegacyStack = await startLegacyStack(cwd, stackArtifacts())
  // Once, so the phones' daemons carry this sweep's environment.
  for (const name of DAEMONS.slice(1)) restartDaemon(bin, name)
  try {
    for (const file of files) {
      // A script may shut the shared web daemon down when it finishes.
      restartDaemon(bin, 'e2eSuite')
      for (const name of DAEMONS.slice(1)) ensureDaemon(bin, name)
      const timeoutMs = LONG[file] ?? defaultTimeout
      const started = Date.now()
      let line: string
      try {
        // What every run of the file shares: the player games, once made.
        let shared: Record<string, string> = {}
        const run = async (
          path: string,
          invocation: Invocation
        ): Promise<LegacyRun> => {
          const device = deviceFor(invocation.needs, stack)
          if (device == null) {
            return {
              file: path,
              status: 'pending',
              exit: 3,
              reason: `needs ${invocation.needs ?? ''}, which is not attached to this sweep`
            }
          }
          if (invocation.blocked != null) {
            return {
              file: path,
              status: 'blocked',
              exit: 2,
              reason: invocation.blocked
            }
          }
          invocation.prepare?.()
          // `{legacy:<name>}` in a value is that script's artifact directory, for
          // a script that reads what an earlier one left (chat.e2e's profiles);
          // `{stack:apiLog}` is the stack API's log, for a sign-in code.
          const env = Object.fromEntries(
            Object.entries(invocation.env ?? {}).map(([key, value]) => [
              key,
              value
                .replace(/\{legacy:([^}]+)\}/g, (_, name: string) =>
                  legacyArtifacts(`${name}.x`)
                )
                .replaceAll('{stack:apiLog}', stack.apiLog)
            ])
          )
          return await runLegacy(
            path,
            cwd,
            { ...process.env, ...device },
            timeoutMs,
            {
              stack: stack.env,
              args: invocation.args,
              env: {
                TS_CHAT_API_LOG: stack.apiLog,
                ...shared,
                ...env
              },
              label: invocation.label
            }
          )
        }
        const source = readFileSync(join(cwd, file), 'utf8')
        // A script that continues from another's run (`{legacy:…}`) keeps that
        // run's database; every other chat script starts from a fresh seed.
        const continues = JSON.stringify(tableRecipe(cwd, file) ?? []).includes(
          '{legacy:'
        )
        if (needsChatSeed(source) && !continues && BLOCKED[file] == null) {
          chatReset(cwd, legacyArtifacts(file))
          stack.reseed()
          // The database was dropped under the running API: its pools, feeds
          // and listeners start again on the new one.
          await stack.restartApi({ speech: stack.speech })
        }
        const recipe = RECIPES[file]
        const invocations: Invocation[] =
          BLOCKED[file] != null
            ? [{ blocked: BLOCKED[file] }]
            : recipe == null
              ? (tableRecipe(cwd, file) ?? alternatives(source, file))
              : await recipe({
                  cwd,
                  speech: stack.speech,
                  restartApi: stack.restartApi,
                  run: async (path, invocation) =>
                    (await run(path, invocation)).exit
                })
        // The player games take minutes to make: only for a run that can go.
        const runnable = invocations.some(
          invocation =>
            invocation.blocked == null &&
            deviceFor(invocation.needs, stack) != null
        )
        if (runnable && needsPlayerFixture(source))
          shared = playerFixtureEnv(cwd)
        const runs: LegacyRun[] = []
        for (const invocation of invocations) {
          runs.push(await run(file, invocation))
        }
        await stack.ensureApi()
        const failed = runs.filter(r => r.status === 'failed')
        const pending = runs.filter(r => r.status === 'pending')
        const blocked = runs.filter(r => r.status === 'blocked')
        const labels = (list: LegacyRun[], from: Invocation[]): string =>
          list
            .map(r => {
              const at = runs.indexOf(r)
              const label = from[at]?.label ?? ''
              // One line each: a reason can carry a script's stderr.
              const what = (r.reason ?? `exit ${r.exit}`).replace(/\s+/g, ' ')
              return label === '' ? what : `${label}: ${what}`
            })
            .join('; ')
        if (failed.length > 0) {
          line = `failed\t${failed[0].exit}\t${file}\t${labels(failed, invocations)}`
        } else if (pending.length > 0) {
          line = `pending\t3\t${file}\t${labels(pending, invocations)}`
        } else if (blocked.length > 0) {
          line = `blocked\t2\t${file}\t${labels(blocked, invocations)}`
        } else {
          line = `passed\t0\t${file}\t${runs.length > 1 ? `${runs.length} runs` : ''}`
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        line = `error\t-\t${file}\t${message.replace(/\s+/g, ' ').slice(0, 400)}`
      }
      const seconds = Math.round((Date.now() - started) / 1000)
      appendFileSync(results, `${line}\t${seconds}s\n`)
      process.stdout.write(`${line}\t${seconds}s\n`)
    }
  } finally {
    await stack.stop()
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
