import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BlockedError, HarnessError } from './result'

/** Where a local build must point. A device cannot reach this machine's loopback. */
export function apiBaseFor(origin: string): string {
  const { hostname } = new URL(origin)
  if (hostname === '127.0.0.1' || hostname === 'localhost') {
    throw new HarnessError(
      `A native app cannot use a loopback origin: ${origin}`
    )
  }
  return `${origin.replace(/\/$/, '')}/api/v1`
}

export interface PrepareOptions {
  app: string
  device: string
  packagePath?: string
  origin?: string
  metroPort?: number
  /** A simulator takes `--udid`. A phone takes `--device`. */
  simulator?: boolean
}

type Run = (command: string, args: string[], env?: NodeJS.ProcessEnv) => void

const realRun: Run = (command, args, env) => {
  execFileSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env }
  })
}

/** A tool this machine does not have: the run cannot go here. */
function missingTool(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
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

/**
 * Runs the build of the app under test. A missing tool blocks the run; a build
 * that fails is the branch's failure, so it is a plain error and the run fails.
 */
function building(step: () => void): void {
  try {
    step()
  } catch (error) {
    if (missingTool(error)) {
      throw new BlockedError(`The build needs a tool: ${String(error)}`)
    }
    throw new Error(`The app did not build: ${String(error)}`)
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

/** The phone loads the packager from its own localhost. Forward that to this machine. */
function forwardPackager(
  device: string,
  port: number,
  run: Run,
  env: NodeJS.ProcessEnv
): void {
  const adb =
    env.ANDROID_HOME == null
      ? 'adb'
      : join(env.ANDROID_HOME, 'platform-tools', 'adb')
  run(adb, ['-s', device, 'reverse', `tcp:${port}`, `tcp:${port}`])
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
    forwardPackager(device, options.metroPort ?? 8081, run, env)
  } else {
    throw new HarnessError(`Unknown app "${app}"`)
  }
}

/**
 * The gitignored signing file, written into an xcconfig when it is present.
 * A phone build has no team without it. A simulator build can go without it.
 */
function iosSigningArgs(): string[] {
  const config = join(process.cwd(), 'clientConfig.json')
  if (!existsSync(config)) return []
  try {
    execFileSync('node', ['scripts/clientConfig.mjs', '.'], {
      stdio: 'ignore'
    })
  } catch (error) {
    throw new HarnessError(
      `clientConfig.json did not convert: ${String(error)}`
    )
  }
  // xcodebuild runs in ios/, so a relative path would miss the root file.
  return [
    '--xcconfig',
    join(process.cwd(), 'clientConfig.xcconfig'),
    '--extra-params',
    '-allowProvisioningUpdates'
  ]
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

function buildLocally(options: PrepareOptions, run: Run): void {
  const { app, device, origin } = options
  if (origin == null)
    throw new HarnessError('No stack or seat to build against')
  // The React Native CLI runs `pod install`, which wants a UTF-8 locale.
  const env = { TS_API_BASE_URL: apiBaseFor(origin), LANG: 'en_US.UTF-8' }
  const port =
    options.metroPort == null ? [] : ['--port', String(options.metroPort)]
  if (app.endsWith('-ios')) {
    const simulator = options.simulator ?? iosIsSimulator(device)
    const signing = iosSigningArgs()
    building(() => {
      run(
        'npx',
        [
          'react-native',
          'run-ios',
          simulator ? '--udid' : '--device',
          device,
          '--no-packager',
          ...signing,
          ...port
        ],
        env
      )
    })
  } else if (app.endsWith('-android')) {
    const androidEnv = { ...env, ...androidSdkEnv() }
    building(() => {
      run(
        'npx',
        [
          'react-native',
          'run-android',
          '--deviceId',
          device,
          '--no-packager',
          ...port
        ],
        androidEnv
      )
    })
    onDevice(() => {
      forwardPackager(device, options.metroPort ?? 8081, run, androidEnv)
    })
  } else {
    throw new HarnessError(`Unknown app "${app}"`)
  }
}

/**
 * Installs a package already on disk, or builds an app for a stack or seat. A
 * failed install blocks the run; a failed build of the app fails it.
 */
export function prepareApp(options: PrepareOptions, run: Run = realRun): void {
  if (options.packagePath != null) {
    onDevice(() => {
      installPackage(options, run)
    })
  } else buildLocally(options, run)
}
