import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BlockedError, HarnessError } from './result'

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

function installPackage(options: PrepareOptions, run: Run): void {
  const { app, device, packagePath } = options
  if (packagePath == null) throw new HarnessError('No package to install')
  if (app.endsWith('-ios')) {
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

/**
 * The Debug app `run-ios` just installed. Clearing state on a phone needs the
 * bundle, which the host cannot read back off the device.
 */
export function iosBuiltApp(
  root = join(homedir(), 'Library/Developer/Xcode/DerivedData')
): string {
  const found: Array<{ path: string; mtimeMs: number }> = []
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (!name.startsWith('TeamStation-')) continue
      const path = join(
        root,
        name,
        'Build/Products/Debug-iphoneos/TeamStation.app'
      )
      if (!existsSync(path)) continue
      found.push({ path, mtimeMs: statSync(path).mtimeMs })
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (found[0] == null) {
    throw new HarnessError('No Debug-iphoneos TeamStation.app has been built')
  }
  return found[0].path
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
 * Installs a Mason develop build already on disk. It talks to the server
 * its build named until `e2e/rigs/app/setServer.ts` points it at a stack for
 * its next fresh launch. A failed install blocks the run.
 */
export function prepareApp(options: PrepareOptions, run: Run = realRun): void {
  if (options.packagePath == null) {
    throw new HarnessError(
      'prepare installs a Mason develop build: --package <path>, then point it at a stack with e2e/rigs/app/setServer.ts'
    )
  }
  onDevice(() => {
    installPackage(options, run)
  })
}
