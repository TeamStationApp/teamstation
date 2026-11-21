import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { isHubDevice, type MaestroDaemon } from './maestro'
import { BlockedError, HarnessError } from './result'
import type { LocalSettings } from './settings'

export interface PrepareOptions {
  app: string
  device: string
  packagePath?: string
}

type Run = (command: string, args: string[], env?: NodeJS.ProcessEnv) => void

const realRun: Run = (command, args, env) => {
  execFileSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
}

/**
 * Runs an install or device step. One that fails is this machine's or the
 * device's problem, never the app's, so the run is blocked.
 */
function onDevice(step: () => void): void {
  try {
    step()
  } catch (error) {
    if (error instanceof HarnessError || error instanceof BlockedError)
      throw error
    throw new BlockedError(`Install failed: ${String(error)}`)
  }
}

/** An SDK whose platform-tools are missing cannot install or see a device. */
function androidSdkEnv(): NodeJS.ProcessEnv {
  const home = process.env.ANDROID_HOME
  if (home != null && existsSync(join(home, 'platform-tools', 'adb'))) return {}
  const sdk = join(homedir(), 'Library', 'Android', 'sdk')
  if (!existsSync(join(sdk, 'platform-tools', 'adb'))) return {}
  return { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }
}

function installPackage(
  options: PrepareOptions,
  run: Run,
  simulator: (device: string) => boolean
): void {
  const { app, device, packagePath } = options
  if (packagePath == null) throw new HarnessError('No package to install')
  if (app.endsWith('-ios') && simulator(device)) {
    // A simulator takes a simulator build's .app, which devicectl cannot see.
    run('xcrun', ['simctl', 'install', device, packagePath])
  } else if (app.endsWith('-ios')) {
    run('xcrun', [
      'devicectl',
      'device',
      'install',
      'app',
      '--device',
      device,
      packagePath
    ])
  } else if (app.endsWith('-android')) {
    const env = androidSdkEnv()
    run('adb', ['-s', device, 'install', '-r', packagePath], env)
  } else {
    throw new HarnessError(`Unknown app "${app}"`)
  }
}

/** Where `prepare` notes the package it put on each device. */
export const INSTALLED_DIR = join(
  homedir(),
  '.config',
  'teamstation-e2e',
  'installed'
)

/**
 * The package `prepare` last installed on `device`, or undefined. A phone's
 * attach names it so that clearing state, which reinstalls on a real iPhone,
 * puts back that same build and no other.
 */
export function installedPackage(
  device: string,
  dir = INSTALLED_DIR
): string | undefined {
  const file = join(dir, `${device}.json`)
  if (!existsSync(file)) return undefined
  const { packagePath } = JSON.parse(readFileSync(file, 'utf8')) as {
    packagePath?: unknown
  }
  return typeof packagePath === 'string' && existsSync(packagePath)
    ? packagePath
    : undefined
}

/**
 * Whether `device` is a real iOS device rather than a simulator. A hub's
 * device is real, and asks nothing of this machine's Xcode.
 */
export function iosIsPhysical(
  device: string,
  simulator: (device: string) => boolean = iosIsSimulator
): boolean {
  return isHubDevice(device) || !simulator(device)
}

/** Whether `device` is a simulator UDID. A phone's UDID is not in this list. */
export function iosIsSimulator(device: string): boolean {
  let listed: string
  try {
    listed = execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], {
      encoding: 'utf8'
    })
  } catch (error) {
    throw new BlockedError(`simctl cannot list devices: ${String(error)}`)
  }
  return listed.includes(`"${device}"`)
}

/**
 * Installs a Mason develop build already on disk, or on a simulator a
 * simulator build of the same develop app. It talks to the server
 * its build named until `e2e/rigs/app/setServer.ts` points it at a stack for
 * its next fresh launch. A failed install blocks the run.
 */
export function prepareApp(
  options: PrepareOptions,
  run: Run = realRun,
  dir = INSTALLED_DIR,
  simulator: (device: string) => boolean = iosIsSimulator
): void {
  if (options.packagePath == null) {
    throw new HarnessError(
      'prepare installs a Mason develop build: --package <path>, then point it at a stack with e2e/rigs/app/setServer.ts'
    )
  }
  onDevice(() => {
    installPackage(options, run, simulator)
  })
  noteInstalled(options, dir)
}

function noteInstalled(options: PrepareOptions, dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${options.device}.json`),
    `${JSON.stringify({ app: options.app, packagePath: resolve(options.packagePath!) })}\n`
  )
}

/**
 * Whether `prepare` installs through the hub: only for a hub's own
 * `<udid>@<hub>` device. A simulator or a USB phone installs locally even
 * when a hub is configured.
 */
export function preparesOnHub(
  settings: LocalSettings,
  device: string
): boolean {
  return settings.maestroHub != null && isHubDevice(device)
}

/**
 * `prepareApp` for a device on a maestro-d hub (`maestroHub`): the package
 * travels with the install call, under a lease that ends once it is in, so
 * the run that follows can take its own. The note is kept under the hub's
 * `<udid>@<hub>` id, which that run's attach names.
 */
export async function prepareAppOnHub(
  options: PrepareOptions,
  hub: MaestroDaemon,
  dir = INSTALLED_DIR
): Promise<void> {
  const { app, device, packagePath } = options
  try {
    if (packagePath == null) {
      throw new HarnessError(
        'prepare installs a Mason develop build: --package <path>, then point it at a stack with e2e/rigs/app/setServer.ts'
      )
    }
    if (!app.endsWith('-ios') && !app.endsWith('-android'))
      throw new HarnessError(`Unknown app "${app}"`)
    const leased = await hub.attach({ device })
    await leased.installApp(resolve(packagePath))
  } catch (error) {
    if (error instanceof HarnessError || error instanceof BlockedError)
      throw error
    throw new BlockedError(`Install failed: ${String(error)}`)
  } finally {
    // Its lease ends whatever happened; a failure to close never hides why
    // the install failed.
    await hub.shutdown().catch(() => undefined)
  }
  noteInstalled(options, dir)
}
