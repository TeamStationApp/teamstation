import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { BlockedError } from './result'
import type { LocalSettings } from './settings'

/** The part of the maestro-d client the framework uses. */
export interface MaestroDevice {
  [command: string]: any
  screenshot: () => Promise<Uint8Array>
  hierarchy: () => Promise<unknown>
  state: () => Promise<Record<string, unknown>>
  detach: () => Promise<unknown>
}

export interface MaestroDaemon {
  readonly hub?: boolean
  close?: () => Promise<unknown>
  attach: (options: Record<string, unknown>) => Promise<MaestroDevice>
  shutdown: () => Promise<unknown>
}

function clientRoot(settings: LocalSettings): string {
  return resolve(
    settings.maestroClientRoot ??
      join(homedir(), 'git', 'maestro-d', 'npm', 'maestro-d')
  )
}

export function maestroBin(settings: LocalSettings): string {
  return (
    settings.maestroBin ?? join(homedir(), '.maestro-d', 'bin', 'maestro-d')
  )
}

/**
 * The client from its checkout, so TeamStation takes no dependency on it. A missing
 * build blocks the run and says how to make one.
 */
export function maestroClient(settings: LocalSettings): {
  MaestroD: {
    connect: (options: Record<string, unknown>) => Promise<MaestroDaemon>
  }
} {
  const root = clientRoot(settings)
  if (!existsSync(join(root, 'dist', 'cjs', 'index.js'))) {
    throw new BlockedError(
      `maestro-d client is not built at ${root}: run \`npm run build\` there`
    )
  }
  return createRequire(join(root, 'package.json'))('maestro-d')
}

/** The part of a hub client the framework uses (maestro-d `docs/daemon/js.md`). */
export interface MaestroHubClient {
  lease: (options: Record<string, unknown>) => Promise<MaestroDevice>
  close: () => Promise<unknown>
}

/** A device on a maestro-d hub: `<udid>@<hub>`. Always a real one. */
export function isHubDevice(device: string): boolean {
  return device.includes('@')
}

/**
 * How long each hub lease runs, and how often it is renewed while the run
 * holds the device: nothing renews a lease on its own, and a soak can run
 * for hours.
 */
export const HUB_LEASE_SEC = 3600
export const HUB_RENEW_MS = 20 * 60 * 1000

/**
 * A hub as the daemon a run attaches through. A hub leases its devices, and
 * reuses the first session on a device whatever a later attach asks, so the
 * lease carries the attach's whole configuration. It refuses `flowDir` and
 * `outputDir` from a remote caller: captures go to the absolute paths the
 * run names. Each lease is renewed until the run ends with `close()`, which
 * ends the leases this process took; a hub serves `shutdown` only on its own
 * socket.
 */
export function hubDaemon(
  hub: MaestroHubClient,
  defaults: Record<string, unknown> = {},
  renewEveryMs = HUB_RENEW_MS
): MaestroDaemon {
  const renewals: Array<ReturnType<typeof setInterval>> = []
  return {
    attach: async options => {
      const attach = {
        ...defaults,
        ...Object.fromEntries(
          Object.entries(options).filter(
            ([key]) =>
              key !== 'flowDir' && key !== 'outputDir' && key !== 'device'
          )
        )
      }
      const device = await hub.lease({
        device: options.device,
        ttlSec: HUB_LEASE_SEC,
        attach
      })
      const renewal = setInterval(() => {
        device.renew?.({ ttlSec: HUB_LEASE_SEC })?.catch?.(() => undefined)
      }, renewEveryMs)
      // A Node timer; the DOM's types, under which e2e/ is also checked,
      // make it a number.
      ;(renewal as unknown as { unref?: () => void }).unref?.()
      renewals.push(renewal)
      return device
    },
    shutdown: async () => {
      for (const renewal of renewals.splice(0)) clearInterval(renewal)
      await hub.close()
    }
  }
}

/**
 * Sends each device to the hub or to the local daemon by its id: a hub's
 * devices are `<udid>@<hub>`; anything else (a browser, a simulator, a
 * phone on this machine's USB) is local. Each is opened the first time a
 * device needs it, and both are shut down at the end.
 */
export function routingDaemon(
  openHub: () => Promise<MaestroDaemon>,
  openLocal: () => Promise<MaestroDaemon>
): MaestroDaemon {
  let hub: Promise<MaestroDaemon> | undefined
  let local: Promise<MaestroDaemon> | undefined
  return {
    attach: async options => {
      const id = typeof options.device === 'string' ? options.device : ''
      if (isHubDevice(id))
        return await (await (hub ??= openHub())).attach(options)
      return await (await (local ??= openLocal())).attach(options)
    },
    // Each closes on its own: a hub that never opened, or would not close,
    // neither keeps the local daemon open nor hides the run's own error.
    shutdown: async () => {
      const results = await Promise.allSettled(
        [hub, local]
          .filter(daemon => daemon != null)
          .map(async daemon => {
            await (await daemon).shutdown()
          })
      )
      for (const result of results)
        if (result.status === 'rejected')
          console.error(`maestro-d did not close: ${String(result.reason)}`)
    }
  }
}

/**
 * One daemon per run, with `maestro-d ps` logged first so a holder is
 * visible. With `maestroHub` set, a `<udid>@<hub>` device goes through the
 * hub instead, through which nothing is spawned here.
 */
export async function connectDaemon(
  settings: LocalSettings,
  name: string
): Promise<MaestroDaemon> {
  const local = async (): Promise<MaestroDaemon> =>
    await connectLocal(settings, name)
  const hubSettings = settings.maestroHub
  if (hubSettings == null) return await local()
  return routingDaemon(async () => {
    const { address, tokenFile, teamId } = hubSettings
    if (!existsSync(tokenFile)) {
      throw new BlockedError(`maestro-d hub token is not at ${tokenFile}`)
    }
    // The client still packs and uploads files with the local binary.
    const bin = maestroBin(settings)
    if (existsSync(bin)) process.env.MAESTRO_D_BIN = bin
    const { MaestroD } = maestroClient(settings)
    const hub = (await MaestroD.connect({
      hub: address,
      token: readFileSync(tokenFile, 'utf8').trim()
    })) as unknown as MaestroHubClient
    return hubDaemon(hub, teamId == null ? {} : { teamId })
  }, local)
}

async function connectLocal(
  settings: LocalSettings,
  name: string
): Promise<MaestroDaemon> {
  const bin = maestroBin(settings)
  if (!existsSync(bin)) {
    throw new BlockedError(`maestro-d binary is not at ${bin}`)
  }
  process.env.MAESTRO_D_BIN = bin
  if (settings.maestroHome != null) {
    process.env.MAESTRO_RUNNER_HOME = settings.maestroHome
  }
  // To stderr: `run` and `detect` print their result as JSON on stdout.
  console.error(execFileSync(bin, ['ps'], { encoding: 'utf8' }).trim())
  const { MaestroD } = maestroClient(settings)
  const daemon = await MaestroD.connect({ name, bin })
  if (process.env.MAESTRO_D_HUB == null) return daemon
  if (daemon.hub !== true || daemon.close == null) {
    throw new BlockedError(
      'The configured maestro-d client must support hub leases'
    )
  }
  // The caller already leased this device. Run directories belong to this
  // machine, and the shared hub outlives the scenario.
  const close = daemon.close.bind(daemon)
  return {
    attach: async ({ flowDir: _localDir, ...options }) =>
      await daemon.attach(options),
    shutdown: close
  }
}

/**
 * Attaches with `flowDir` at the run directory: that, and not a call's `cwd`, is what
 * maestro-d's workspace rule checks, so goldens and captures can live there.
 */
export async function attachDevice(
  daemon: MaestroDaemon,
  runDir: string,
  options: Record<string, unknown>
): Promise<MaestroDevice> {
  mkdirSync(runDir, { recursive: true })
  return await daemon.attach({
    artifacts: 'on-failure',
    ...options,
    flowDir: runDir
  })
}
