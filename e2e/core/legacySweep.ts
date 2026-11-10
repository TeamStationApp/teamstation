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
  stackArtifacts,
  startLegacyStack
} from './legacyStack'
import { type LegacyRun, runLegacy } from './runLegacy'

/**
 * The device variables for a run that needs `needs`, or undefined when this
 * sweep has no such device. A simulator run gets the simulator as its iOS device.
 */
function deviceFor(needs: string | undefined): NodeJS.ProcessEnv | undefined {
  const env = process.env
  switch (needs) {
    case undefined:
    case 'web':
    case 'none':
      return {}
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
  'src/app/scoring/scoring.e2e.ts': 45 * 60 * 1000
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
  const files =
    given.length > 0
      ? given
      : Object.keys(
          (
            JSON.parse(readFileSync(join(cwd, 'e2e/legacy.json'), 'utf8')) as {
              modules: Record<string, string>
            }
          ).modules
        )
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
      TS_MEDIA_ORIGINS: 'http://127.0.0.1:* http://localhost:*'
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
        const run = async (
          path: string,
          invocation: Invocation
        ): Promise<LegacyRun> => {
          const device = deviceFor(invocation.needs)
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
                ...invocation.env
              },
              label: invocation.label
            }
          )
        }
        const source = readFileSync(join(cwd, file), 'utf8')
        if (needsChatSeed(source)) {
          chatReset(cwd, legacyArtifacts(file))
          stack.reseed()
        }
        const shared = needsPlayerFixture(source) ? playerFixtureEnv(cwd) : {}
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
        const runs: LegacyRun[] = []
        for (const invocation of invocations) {
          runs.push(await run(file, invocation))
        }
        const failed = runs.filter(r => r.status === 'failed')
        const pending = runs.filter(r => r.status === 'pending')
        const blocked = runs.filter(r => r.status === 'blocked')
        const labels = (list: LegacyRun[], from: Invocation[]): string =>
          list
            .map(r => {
              const at = runs.indexOf(r)
              const label = from[at]?.label ?? ''
              const what = r.reason ?? `exit ${r.exit}`
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
