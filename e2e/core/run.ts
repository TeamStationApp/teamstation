import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { killApp, refuseUnreachable, styleScript } from '../faults/apply'
import {
  Checkpoints,
  type CheckpointTarget,
  type JudgeRuntime,
  statusFromCheckpoints
} from './checkpoint'
import {
  baselineManifestPath,
  findAccount,
  type FixtureManifest,
  readBaselineManifest,
  requireMailbox,
  runSeatFixture,
  signInWithPassword,
  worldIdsOf
} from './fixtures'
import { deviceClassOf } from './goldens'
import type { ServerError } from './invariants'
import { Budget, createMessage, haikuJudge, judgeHasAuthority } from './judge'
import { attachDevice, connectDaemon } from './maestro'
import { gogRunner, readMail, testAddressFor, waitForMail } from './mail'
import { findScenario, ROOT } from './manifest'
import { prepareApp } from './prepare'
import {
  BlockedError,
  exitCodeFor,
  HarnessError,
  type RunResult,
  type Status,
  writeResult
} from './result'
import { seatServerErrors } from './seatLog'
import { hasSecret, type LocalSettings, readSecret } from './settings'
import {
  type E2eContext,
  SEAT_ONLY_SERVICES,
  type StackHandle,
  type Surface,
  type WatchedDevice,
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
  /** Other scenarios share this seat, so a 5xx must name this one's world to count. */
  concurrent?: boolean
  /** The fault this run proves. Only an isolated stack can carry one. */
  fault?: string
  /** Stands in for building and installing an app, in tests. */
  prepare?: typeof prepareApp
  /** Stands in for the configured judge, in tests. */
  judges?: JudgeRuntime
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

/** What a failed scenario's devices showed, for whoever reads the failure. */
async function keepEvidence(
  targets: CheckpointTarget[],
  runDir: string
): Promise<void> {
  for (const [index, target] of targets.entries()) {
    try {
      writeFileSync(
        join(runDir, `failure-${index}.png`),
        await target.device.screenshot()
      )
      writeFileSync(
        join(runDir, `failure-${index}.json`),
        JSON.stringify(await target.device.hierarchy(), null, 2)
      )
    } catch (error) {
      console.error(`No failure evidence: ${String(error)}`)
    }
  }
}

/**
 * A check that failed, as opposed to the test itself breaking. A crash under a fault
 * goes red without proving any layer saw it.
 */
function isAssertion(error: Error): boolean {
  return (
    error.name === 'AssertionError' ||
    error.name === 'MaestroError' ||
    error.message.startsWith('Checkpoint "')
  )
}

/** Breaks the screen just before a checkpoint looks at it. */
async function applyFault(
  fault: string | undefined,
  target: CheckpointTarget,
  surface: Surface,
  devices: Record<string, string>
): Promise<void> {
  if (fault == null) return
  const script = styleScript(fault)
  if (script != null) {
    await target.device.evalBrowserScript({ script })
    return
  }
  if (fault === 'app-crash' && target.appId != null) {
    const [udid] = Object.values(devices)
    killApp(surface, udid, target.appId)
  }
}

/** A simulator's status bar reads the same every run, so a golden can include it. */
function pinStatusBar(udid: string): void {
  execFileSync('xcrun', [
    'simctl',
    'status_bar',
    udid,
    'override',
    '--time',
    '9:41',
    '--batteryState',
    'charged',
    '--batteryLevel',
    '100',
    '--wifiBars',
    '3',
    '--cellularBars',
    '4'
  ])
}

/** The judge this machine has a key for, if any. A spent or absent budget stops it. */
function configuredJudges(options: RunOptions, root: string): JudgeRuntime {
  const budget = new Budget(
    options.budgetUsd ?? options.settings.judgeBudgetUsd ?? 0
  )
  if (!hasSecret(options.settings, 'anthropic')) {
    return { judge: undefined, budget, authoritative: false }
  }
  const client = {
    messages: {
      create: async (body: Record<string, unknown>) =>
        await createMessage(readSecret(options.settings, 'anthropic'), body)
    }
  }
  return {
    judge: haikuJudge(client),
    budget,
    authoritative: judgeHasAuthority(root, 'haiku')
  }
}

function spentOn(checkpoints: Checkpoints | undefined): number {
  let total = 0
  for (const record of checkpoints?.records ?? []) {
    total += record.ask?.costUsd ?? 0
    total += record.annotation?.costUsd ?? 0
  }
  return total
}

/** Runs one scenario on one surface, and always writes a truthful `result.json`. */
export async function runScenario(options: RunOptions): Promise<RunOutcome> {
  const root = options.root ?? ROOT
  const runDir =
    options.runDir ?? mkdtempSync(join(tmpdir(), 'teamstation-e2e-run-'))
  mkdirSync(runDir, { recursive: true })
  const started = Date.now()
  const degradations: string[] = []
  let checkpoints: Checkpoints | undefined
  let targetKind: RunResult['target']
  let deviceClass: string | undefined
  let failureKind: RunResult['failureKind']
  let serverErrors: ServerError[] = []
  const finish = (status: Status, reason?: string): RunOutcome => {
    const result: RunResult = {
      scenario: options.id,
      surface: options.surface,
      ref: headRef(root),
      deviceClass: deviceClass ?? options.surface,
      status,
      ...(reason == null ? {} : { reason }),
      durationMs: Date.now() - started,
      costUsd: spentOn(checkpoints),
      degradations,
      ...(targetKind == null ? {} : { target: targetKind }),
      ...(options.fault == null ? {} : { fault: options.fault }),
      ...(failureKind == null ? {} : { failureKind }),
      ...(serverErrors.length === 0 ? {} : { serverErrors }),
      checkpoints: checkpoints?.records ?? [],
      ...(checkpoints == null || checkpoints.unattributed.length === 0
        ? {}
        : { unattributedServerErrors: checkpoints.unattributed })
    }
    writeResult(runDir, result)
    return { result, exitCode: exitCodeFor(status), runDir }
  }

  let stack: RunningStack | undefined
  try {
    const { entry, spec } = findScenario(options.id, root)
    const surface = options.surface as Surface
    if (options.fault != null) refuseUnreachable(options.fault, surface)
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
        adopt: async origin => origin,
        serverErrors: async () => undefined
      }
    } else if (
      spec.stack === 'seat' &&
      options.seat != null &&
      options.fault == null
    ) {
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
        adopt: async origin => origin,
        baselineManifest: baselineManifestPath(options.settings, {
          kind: 'seat',
          seat: options.seat
        }),
        seedWorld: async name =>
          runSeatFixture(options.settings, options.seat ?? '', name),
        serverErrors: async since => seatServerErrors(options.settings, since)
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
        root,
        fault: options.fault,
        mailbox: options.settings.mailbox
      })
      handle = stack
      if (surface === 'ios-app' || surface === 'android-app') {
        // A native app's server is fixed when its bundle is made, so it is built here,
        // for this stack.
        const [device] = needs.devices
        ;(options.prepare ?? prepareApp)({
          app:
            surface === 'ios-app' ? 'teamstation-ios' : 'teamstation-android',
          device: devices[device.role],
          origin: stack.origin,
          metroPort: stack.metroPort
        })
      }
    }

    targetKind =
      handle.kind === 'seat'
        ? { kind: 'seat', seat: options.seat }
        : { kind: handle.kind }
    checkpoints = new Checkpoints({
      scenarioId: options.id,
      surface,
      runDir,
      root,
      settings: options.settings,
      serverErrors: async () => await handle.serverErrors(started),
      alone: options.concurrent !== true,
      worldIds: () => worldIdsOf(worlds),
      judges: options.judges ?? configuredJudges(options, root)
    })
    const running = checkpoints

    const worlds: FixtureManifest[] = []
    const sessions: WebSession[] = []
    const attached: Array<() => Promise<void>> = []
    const targets: CheckpointTarget[] = []
    const watch = (device: any, info: WatchedDevice): CheckpointTarget => {
      const target = { device, consoleSeen: 0, ...info }
      targets.push(target)
      deviceClass ??= info.deviceClass
      return target
    }
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
      fault: options.fault,
      browser: async (size, emulation) => {
        const session = await openWebSession(
          options.settings,
          runDir,
          size,
          emulation
        )
        sessions.push(session)
        watch(session.m, { deviceClass: session.deviceClass })
        return session
      },
      lastDevice: () => {
        const target = targets[targets.length - 1]
        if (target == null) throw new HarnessError('No device is attached yet')
        return target.device
      },
      fixture: async name => {
        if (handle.seedWorld == null) {
          throw new BlockedError('this target has no database to seed')
        }
        const manifest = await handle.seedWorld(name)
        worlds.push(manifest)
        return manifest
      },
      signIn: async (role, on) => {
        const account = findAccount(
          role,
          worlds,
          readBaselineManifest(handle.baselineManifest)
        )
        const target =
          on == null
            ? targets[targets.length - 1]
            : targets.find(row => row.device === on)
        if (target == null) {
          throw new HarnessError(`Signing in "${role}" has no device to use`)
        }
        await signInWithPassword(target.device, account)
        return account
      },
      address: label => testAddressFor(requireMailbox(options.settings), label),
      mail: async (address, from) => {
        const mailbox = requireMailbox(options.settings)
        const run = gogRunner(options.settings)
        const message = await waitForMail({
          run,
          mailbox,
          to: address,
          from,
          since: started
        })
        return {
          subject: message.subject,
          body: () => readMail(run, mailbox, message.id)
        }
      },
      attach: async (role, attachOptions) => {
        const id = ctx.device(role)
        const daemon = await connectDaemon(
          options.settings,
          `e2e-${role}-${process.pid}`
        )
        const device = await attachDevice(daemon, runDir, {
          device: id,
          ...attachOptions
        })
        attached.push(async () => {
          await device.detach()
          await daemon.shutdown()
        })
        const info = await device.platformInfo()
        if (info.platform === 'ios' && info.isSimulator === true) {
          pinStatusBar(id)
        }
        watch(device, {
          deviceClass: deviceClassOf(info),
          ...(typeof attachOptions.appId === 'string'
            ? { appId: attachOptions.appId }
            : {})
        })
        return device
      },
      watch: (device, info) => {
        watch(device, info)
      },
      checkpoint: async (id, checkpoint, on) => {
        const target =
          on == null
            ? targets[targets.length - 1]
            : targets.find(row => row.device === on)
        if (target == null) {
          throw new HarnessError(`Checkpoint "${id}" has no device to look at`)
        }
        await applyFault(options.fault, target, surface, devices)
        await running.check(id, checkpoint, target)
      }
    }

    const attempts = 1 + (options.retries ?? 0)
    let failure: Error | undefined
    for (let attempt = 0; attempt < attempts; attempt++) {
      failure = undefined
      running.reset()
      try {
        await scenario(ctx)
        break
      } catch (error) {
        failure = error instanceof Error ? error : new Error(error as string)
      }
    }
    if (failure != null) {
      await keepEvidence(targets, runDir)
      failureKind = isAssertion(failure) ? 'assertion' : 'crash'
      serverErrors = (await handle.serverErrors(started)) ?? []
    }
    for (const session of sessions) await session.close().catch(() => undefined)
    for (const close of attached) await close().catch(() => undefined)
    if (failure != null) throw failure
    const verdict = statusFromCheckpoints(running.records)
    if (verdict.status === 'failed') {
      failureKind = 'assertion'
      throw new Error(verdict.reason)
    }
    if (verdict.status !== 'passed')
      return finish(verdict.status, verdict.reason)
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
