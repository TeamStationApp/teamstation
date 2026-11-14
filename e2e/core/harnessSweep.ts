import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** A scenario as `e2e/manifest.json` lists it: what the sweep needs of it. */
export interface ManifestScenario {
  id: string
  file: string
  stack: string
  minutes: number
  surfaces: Record<string, unknown>
}

/** One scenario on one surface, or why the sweep leaves it out. */
export interface HarnessRun {
  id: string
  surface: string
  minutes: number
  skip?: string
}

/** The surfaces a droplet sweep drives: a browser of its own. */
const SWEEP_SURFACES = new Set(['web-chromium'])

/**
 * The runs the sweep makes of a harness file (`e2e/tests/…`): each of its
 * scenarios on each surface it names. A phone's, a simulator's or iOS
 * Safari's surface waits for the device pass, and a scenario that runs
 * against a deployed seat for a seat; each is listed with why.
 */
export function harnessRuns(
  file: string,
  scenarios: readonly ManifestScenario[]
): HarnessRun[] {
  return scenarios
    .filter(scenario => scenario.file === file)
    .flatMap(scenario =>
      Object.keys(scenario.surfaces).map(surface => ({
        id: scenario.id,
        surface,
        minutes: scenario.minutes,
        ...(!SWEEP_SURFACES.has(surface)
          ? {
              skip: `${surface} needs its device, which this sweep has none of`
            }
          : scenario.stack === 'seat'
            ? {
                skip: 'runs against a deployed seat, which this sweep has none of'
              }
            : {})
      }))
    )
}

/** The scenarios `e2e/manifest.json` lists. */
export function manifestScenarios(cwd: string): ManifestScenario[] {
  return (
    JSON.parse(readFileSync(join(cwd, 'e2e/manifest.json'), 'utf8')) as {
      scenarios: ManifestScenario[]
    }
  ).scenarios
}

/** A run's outcome as the sweep counts it, from the status `result.json` holds. */
export function sweepStatus(
  status: string | undefined
): 'passed' | 'failed' | 'blocked' {
  if (status === 'passed' || status === 'passed-degraded') return 'passed'
  if (status === 'blocked') return 'blocked'
  // Failed, quarantined, needs-review, unbaselined, or no result at all: a
  // run that did not pass is not passed over.
  return 'failed'
}

/**
 * Runs one scenario on one surface through `e2e run`, in a run directory
 * of its own under `artifacts`, and answers how it ended and why. A run
 * past `timeoutMs` is stopped and failed.
 */
export async function runHarness(
  cwd: string,
  run: HarnessRun,
  artifacts: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ status: 'passed' | 'failed' | 'blocked'; reason?: string }> {
  const runDir = join(
    artifacts,
    `${run.id.replace(/[^a-zA-Z0-9-]+/g, '_')}-${run.surface}`
  )
  mkdirSync(runDir, { recursive: true })
  const code = await new Promise<number | null>(resolve => {
    const child = spawn(
      process.execPath,
      [
        '-r',
        'sucrase/register',
        'e2e/core/cli.ts',
        'run',
        run.id,
        '--surface',
        run.surface,
        '--run-dir',
        runDir
      ],
      { cwd, env, stdio: 'ignore' }
    )
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('close', exit => {
      clearTimeout(timer)
      resolve(exit)
    })
  })
  const file = join(runDir, 'result.json')
  if (!existsSync(file))
    return {
      status: 'failed',
      reason:
        code == null
          ? `stopped after ${Math.round(timeoutMs / 60000)} min`
          : `exit ${code}, no result.json`
    }
  const result = JSON.parse(readFileSync(file, 'utf8')) as {
    status?: string
    reason?: string
  }
  const status = sweepStatus(result.status)
  return status === 'passed'
    ? { status }
    : {
        status,
        reason: `${result.status ?? 'no status'}${result.reason == null ? '' : `: ${result.reason}`}`
      }
}
