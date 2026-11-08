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
    run('adb', ['-s', device, 'install', '-r', packagePath])
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
  execFileSync('node', ['scripts/clientConfig.mjs', '.'], {
    stdio: 'ignore'
  })
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
  const listed = execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], {
    encoding: 'utf8'
  })
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
    run(
      'npx',
      [
        'react-native',
        'run-ios',
        simulator ? '--udid' : '--device',
        device,
        '--no-packager',
        ...iosSigningArgs(),
        ...port
      ],
      env
    )
  } else if (app.endsWith('-android')) {
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
      env
    )
  } else {
    throw new HarnessError(`Unknown app "${app}"`)
  }
}

/** Installs a package already on disk, or builds an app for a stack or seat. */
export function prepareApp(options: PrepareOptions, run: Run = realRun): void {
  try {
    if (options.packagePath != null) installPackage(options, run)
    else buildLocally(options, run)
  } catch (error) {
    if (error instanceof HarnessError) throw error
    throw new BlockedError(`Install failed: ${String(error)}`)
  }
}
