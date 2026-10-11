import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import { dependencyInputs } from './dependencyInputs'
import type { BuildContext } from './runner'
import { nativeNumber } from './runner'
import { sentryBuildEnvironment } from './sentry'
import { noSymlinks } from './state'
import { httpsOrigin } from './validation'

export function buildEnvironment(context: BuildContext): NodeJS.ProcessEnv {
  const { target, settings } = context
  const origin = settings.apps[target.app].apiOrigin
  return {
    NODE_BINARY: settings.tools.node,
    ...sentryBuildEnvironment(settings.apps[target.app].sentry),
    TS_BUILD_INFO: JSON.stringify({
      app: target.app,
      version: context.version,
      buildNumber: nativeNumber(target.platform, context.buildNumber),
      branch: context.branch,
      commit: context.commit,
      builtAt: context.buildTime
    }),
    ...(origin == null
      ? {}
      : {
          TS_API_BASE_URL: `${origin}/api/v1`,
          TS_PRIMARY_HOST: new URL(origin).host
        })
  }
}
export function appDirectory(context: BuildContext): string {
  const directory = path.resolve(context.source, context.target.path)
  noSymlinks(directory)
  if (!existsSync(directory))
    throw new Error('Selected app is absent from this branch')
  return directory
}
/**
 * The app's `clientConfig.json`: what this deployment decides about the app and
 * the repository does not name.
 *
 * `appOrigin`, the app's link host, comes from the file Mason injects and names
 * in `TS_CLIENT_CONFIG_FILE`; it is a file of its own rather than a deploy
 * setting so that the commits that do not read it build exactly as they did.
 * `appleTeamId` is the team the deploy settings already sign this platform
 * with. A build with neither has no file, and a stale one is removed.
 */
export function writeClientConfig(
  context: BuildContext,
  directory: string,
  injected: string | undefined = process.env.TS_CLIENT_CONFIG_FILE
): void {
  const file = path.join(directory, 'clientConfig.json')
  noSymlinks(file)
  const out: { appOrigin?: string; appleTeamId?: string } = {}
  if (injected != null && injected !== '') {
    const raw: unknown = JSON.parse(
      readFileSync(path.resolve(injected), 'utf8')
    )
    const appOrigin =
      raw != null && typeof raw === 'object' && 'appOrigin' in raw
        ? raw.appOrigin
        : undefined
    out.appOrigin = httpsOrigin(appOrigin)
  }
  const apple =
    context.settings.apps[context.target.app][context.target.platform]?.apple
  if (apple != null) out.appleTeamId = apple.teamId
  if (Object.keys(out).length === 0) {
    rmSync(file, { force: true })
    return
  }
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 })
}

export async function prepare(context: BuildContext): Promise<string> {
  const directory = appDirectory(context)
  const { processes, settings, target } = context
  const env = buildEnvironment(context)
  writeClientConfig(context, directory)
  if (target.kind === 'react-native') {
    const packages =
      target.dependencies == null
        ? directory
        : path.resolve(context.source, target.dependencies)
    noSymlinks(packages)
    if (!existsSync(path.join(packages, 'package-lock.json')))
      throw new Error('A locked JavaScript dependency graph is required')
    const marker = path.join(packages, '.deploy-dependencies')
    const fingerprint = dependencyInputs(packages)
    noSymlinks(marker)
    if (
      !existsSync(path.join(packages, 'node_modules')) ||
      !existsSync(marker) ||
      readFileSync(marker, 'utf8') !== fingerprint
    ) {
      await processes.run({
        file: settings.tools.socket,
        args: ['npm', 'ci'],
        cwd: packages,
        env,
        capture: false
      })
      writeFileSync(marker, fingerprint, { mode: 0o600 })
    }
    if (target.harvester === true)
      await processes.run({
        file: settings.tools.npm,
        args: ['run', 'build.harvester'],
        cwd: directory,
        env,
        capture: false
      })
  } else if (target.kind === 'swift') {
    if (target.app === 'app.teamstation.director')
      await processes.run({
        file: 'bash',
        args: ['scripts/bootstrapNdi.sh'],
        cwd: directory,
        env,
        capture: false
      })
    await processes.run({
      file: settings.tools.xcodegen,
      args: ['generate', '--quiet'],
      cwd: directory,
      env,
      capture: false
    })
  }
  mkdirSync(path.join(directory, '.deploy'), { recursive: true, mode: 0o700 })
  return directory
}
