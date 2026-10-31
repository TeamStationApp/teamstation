import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findScenario, ROOT } from './manifest'
import {
  BlockedError,
  exitCodeFor,
  HarnessError,
  type RunResult,
  type Status,
  writeResult
} from './result'
import { type LocalSettings, readSecret } from './settings'
import {
  type E2eContext,
  SEAT_ONLY_SERVICES,
  type StackHandle,
  type Surface,
  type WebSession
} from './spec'
import { type RunningStack, startStack } from './stack'
import { openWebSession } from './web'

export interface RunOptions {
  id: string
  surface: string
  devices?: Record<string, string>
  seat?: string
  stack?: StackHandle
  runDir?: string
  retries?: number
  budgetUsd?: number
  settings: LocalSettings
  root?: string
}

export interface RunOutcome {
  result: RunResult
  exitCode: number
  runDir: string
}

function headRef(root: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim()
  } catch {
    return 'unknown'
  }
}

/** What a failed scenario's browser showed, for whoever reads the failure. */
async function keepEvidence(
  sessions: WebSession[],
  runDir: string
): Promise<void> {
  for (const [index, session] of sessions.entries()) {
    try {
      writeFileSync(
        join(runDir, `failure-${index}.png`),
        await session.m.screenshot()
      )
      writeFileSync(
        join(runDir, `failure-${index}.txt`),
        await session.page.evaluate(() => document.body.innerText)
      )
    } catch (error) {
      console.error(`No failure evidence: ${String(error)}`)
    }
  }
}

/** Runs one scenario on one surface, and always writes a truthful `result.json`. */
export async function runScenario(options: RunOptions): Promise<RunOutcome> {
  const root = options.root ?? ROOT
  const runDir =
    options.runDir ?? mkdtempSync(join(tmpdir(), 'teamstation-e2e-run-'))
  mkdirSync(runDir, { recursive: true })
  const started = Date.now()
  const degradations: string[] = []
  const finish = (status: Status, reason?: string): RunOutcome => {
    const result: RunResult = {
      scenario: options.id,
      surface: options.surface,
      ref: headRef(root),
      deviceClass: options.surface,
      status,
      ...(reason == null ? {} : { reason }),
      durationMs: Date.now() - started,
      costUsd: 0,
      degradations,
      checkpoints: []
    }
    writeResult(runDir, result)
    return { result, exitCode: exitCodeFor(status), runDir }
  }

  let stack: RunningStack | undefined
  try {
    const { entry, spec } = findScenario(options.id, root)
    const surface = options.surface as Surface
    const needs = spec.surfaces[surface]
    if (needs == null) {
      throw new BlockedError(`${spec.id} does not run on ${options.surface}`)
    }
    if (spec.manual) throw new BlockedError('manual: a person must act')
    for (const secret of spec.secrets) readSecret(options.settings, secret)
    const devices = options.devices ?? {}
    for (const need of needs.devices) {
      if (devices[need.role] == null) {
        throw new BlockedError(
          `no device passed for "${need.role}": use --device ${need.role}=<id>`
        )
      }
    }

    const scenarioName = entry.id.slice(entry.id.indexOf('#') + 1)
    const scenario = spec.scenarios[scenarioName]

    let handle: StackHandle
    if (options.stack != null) {
      handle = options.stack
    } else if (spec.stack === 'none') {
      handle = {
        kind: 'none',
        origin: '',
        webDir: undefined,
        adopt: origin => origin
      }
    } else if (spec.stack === 'seat' && options.seat != null) {
      const seat = options.settings.seats?.[options.seat]
      if (seat == null) {
        throw new BlockedError(
          `no seat "${options.seat}" in the local settings`
        )
      }
      handle = {
        kind: 'seat',
        origin: seat.origin,
        webDir: undefined,
        adopt: origin => origin
      }
    } else {
      for (const service of spec.services) {
        if (SEAT_ONLY_SERVICES.includes(service)) {
          throw new BlockedError(`${service} needs a seat: use --seat <name>`)
        }
      }
      stack = await startStack({
        lan: surface !== 'web-chromium',
        native: surface === 'ios-app' || surface === 'android-app',
        services: spec.services,
        root
      })
      handle = stack
    }

    const sessions: WebSession[] = []
    const ctx: E2eContext = {
      scenarioId: options.id,
      surface,
      runDir,
      stack: handle,
      device: role => {
        const id = devices[role]
        if (id == null) throw new BlockedError(`no device for "${role}"`)
        return id
      },
      secret: name => readSecret(options.settings, name),
      artifact: name => join(runDir, name),
      degrade: reason => {
        degradations.push(reason)
      },
      browser: async (size, emulation) => {
        const session = await openWebSession(
          options.settings,
          runDir,
          size,
          emulation
        )
        sessions.push(session)
        return session
      }
    }

    const attempts = 1 + (options.retries ?? 0)
    let failure: Error | undefined
    for (let attempt = 0; attempt < attempts; attempt++) {
      failure = undefined
      try {
        await scenario(ctx)
        break
      } catch (error) {
        failure = error instanceof Error ? error : new Error(error as string)
      }
    }
    if (failure != null) await keepEvidence(sessions, runDir)
    for (const session of sessions) await session.close().catch(() => undefined)
    if (failure != null) throw failure
    return finish(degradations.length > 0 ? 'passed-degraded' : 'passed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof BlockedError) return finish('blocked', message)
    if (error instanceof HarnessError) return finish('harness-error', message)
    let quarantined = false
    try {
      const { quarantine } = findScenario(options.id, root).spec
      const name = options.id.slice(options.id.indexOf('#') + 1)
      quarantined =
        quarantine != null &&
        (quarantine.scenarios == null || quarantine.scenarios.includes(name))
    } catch {
      return finish('harness-error', message)
    }
    return finish(quarantined ? 'quarantined' : 'failed', message)
  } finally {
    await stack?.stop()
  }
}
