import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
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

/** One daemon per run, with `maestro-d ps` logged first so a holder is visible. */
export async function connectDaemon(
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
  console.log(execFileSync(bin, ['ps'], { encoding: 'utf8' }).trim())
  const { MaestroD } = maestroClient(settings)
  return await MaestroD.connect({ name, bin })
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
