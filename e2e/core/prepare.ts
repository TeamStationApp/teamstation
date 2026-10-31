import { execFileSync } from 'node:child_process'

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

function buildLocally(options: PrepareOptions, run: Run): void {
  const { app, device, origin } = options
  if (origin == null)
    throw new HarnessError('No stack or seat to build against')
  // The React Native CLI runs `pod install`, which wants a UTF-8 locale.
  const env = { TS_API_BASE_URL: apiBaseFor(origin), LANG: 'en_US.UTF-8' }
  const port =
    options.metroPort == null ? [] : ['--port', String(options.metroPort)]
  if (app.endsWith('-ios')) {
    run(
      'npx',
      ['react-native', 'run-ios', '--udid', device, '--no-packager', ...port],
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
