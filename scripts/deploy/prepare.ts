import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { dependencyInputs } from './dependencyInputs'
import type { BuildContext } from './runner'
import { nativeNumber } from './runner'
import { noSymlinks } from './state'

export function buildEnvironment(context: BuildContext): NodeJS.ProcessEnv {
  const { target, settings } = context
  const origin = settings.apps[target.app].apiOrigin
  return {
    NODE_BINARY: settings.tools.node,
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
export async function prepare(context: BuildContext): Promise<string> {
  const directory = appDirectory(context)
  const { processes, settings, target } = context
  const env = buildEnvironment(context)
  if (target.kind === 'react-native') {
    if (!existsSync(path.join(directory, 'package-lock.json')))
      throw new Error('A locked JavaScript dependency graph is required')
    const marker = path.join(directory, '.deploy-dependencies')
    const fingerprint = dependencyInputs(directory)
    noSymlinks(marker)
    if (
      !existsSync(path.join(directory, 'node_modules')) ||
      !existsSync(marker) ||
      readFileSync(marker, 'utf8') !== fingerprint
    ) {
      await processes.run({
        file: settings.tools.socket,
        args: ['npm', 'ci'],
        cwd: directory,
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
