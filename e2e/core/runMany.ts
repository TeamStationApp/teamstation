import { findScenario, ROOT } from './manifest'
import type { Status } from './result'
import type { RunOptions, RunOutcome } from './run'
import type { StackHandle, Surface } from './spec'

export interface RunManyRow {
  scenario: string
  stack: string
  status: Status
  minutes: number
  runDir: string
}

export interface RunManyOptions {
  /** Run in this order, each on the first stack free for it. */
  scenarios: string[]
  /** The stacks, by id, each running one scenario at a time. */
  stacks: Array<{ id: string; handle: StackHandle }>
  surface: Surface
  /** The bench devices by role, shared by every scenario. */
  devices: Record<string, string>
  settings: RunOptions['settings']
  retries?: number
  root?: string
  run: (options: RunOptions) => Promise<RunOutcome>
  /** Says each scenario as it starts and ends. */
  say?: (line: string) => void
  clock?: () => number
}

/** The device ids a scenario holds while it runs, by the roles its surface needs. */
export function devicesOf(
  scenario: string,
  surface: Surface,
  devices: Record<string, string>,
  root = ROOT
): string[] {
  const needs =
    findScenario(scenario, root).entry.surfaces[surface]?.devices ?? []
  return needs
    .map(need => devices[need.role])
    .filter((id): id is string => id != null)
}

/**
 * Runs scenarios across stacks at once: each stack runs one at a time, and
 * a scenario starts on the first stack free for it, unless another scenario
 * running holds a device it needs, when it waits for that one. Answers a row
 * per scenario, in the order given, and the exit code: the worst of theirs.
 */
export async function runMany(
  options: RunManyOptions
): Promise<{ rows: RunManyRow[]; exitCode: number }> {
  const clock = options.clock ?? Date.now
  const say = options.say ?? (() => {})
  const queue = options.scenarios.map((scenario, index) => ({
    scenario,
    index,
    devices: devicesOf(scenario, options.surface, options.devices, options.root)
  }))
  const rows: RunManyRow[] = []
  const free = [...options.stacks]
  const held = new Set<string>()
  let worst = 0
  let running = 0

  return await new Promise((resolve, reject) => {
    const pump = (): void => {
      for (;;) {
        if (free.length === 0) break
        const next = queue.findIndex(item =>
          item.devices.every(device => !held.has(device))
        )
        if (next < 0) break
        const [item] = queue.splice(next, 1)
        const stack = free.shift()
        if (stack == null) break
        for (const device of item.devices) held.add(device)
        running++
        const started = clock()
        say(`${item.scenario}: started on ${stack.id}`)
        options
          .run({
            id: item.scenario,
            surface: options.surface,
            devices: options.devices,
            stack: stack.handle,
            settings: options.settings,
            ...(options.retries == null ? {} : { retries: options.retries }),
            ...(options.root == null ? {} : { root: options.root })
          })
          .then(outcome => {
            const minutes = Math.round((clock() - started) / 6000) / 10
            rows[item.index] = {
              scenario: item.scenario,
              stack: stack.id,
              status: outcome.result.status,
              minutes,
              runDir: outcome.runDir
            }
            worst = Math.max(worst, outcome.exitCode)
            say(
              `${item.scenario}: ${outcome.result.status} on ${stack.id}, ${minutes} min`
            )
          })
          .then(() => {
            for (const device of item.devices) held.delete(device)
            free.push(stack)
            running--
            if (queue.length === 0 && running === 0) {
              resolve({ rows, exitCode: worst })
              return
            }
            pump()
          }, reject)
      }
      if (queue.length === 0 && running === 0)
        resolve({ rows, exitCode: worst })
    }
    if (options.stacks.length === 0) {
      reject(new Error('run-many wants --stacks with one stack or more'))
      return
    }
    pump()
  })
}
