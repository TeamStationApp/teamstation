import { writeFileSync } from 'node:fs'

import { android } from './android'
import { bundleEnvironment, ios } from './apple'
import { loadSettings } from './config'
import { macos } from './macos'
import { Processes } from './process'
import { type Builders, type Options, run } from './runner'
import { target } from './targets'
import { appId, branchName, platform } from './validation'

export async function masonDeploy(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  builders: Builders = { ios, android, macos },
  dependencies = true
): Promise<number> {
  const required = (name: string): string => {
    const value = env[name]
    if (value == null || value === '')
      throw new Error('Missing Mason build environment')
    return value
  }
  const app = appId(required('MASON_APP'))
  const branch = branchName(required('MASON_BRANCH'))
  const config = required('DEPLOY_CONFIG_FILE')
  const counter = required('BUILD_NUMBER_FILE')
  const resultFile = required('MASON_RESULT_FILE')
  const selected = required('MASON_PLATFORMS').split(',').map(platform)
  if (new Set(selected).size !== selected.length)
    throw new Error('Duplicate platform')
  for (const os of selected) target(app, os)
  const settings = loadSettings(config, branch)
  const platforms = selected.filter(os => settings.apps[app]?.[os] != null)
  const skipped = selected.filter(os => !platforms.includes(os))
  const cancel = new AbortController()
  const stop = (): void => {
    cancel.abort()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  let code = 1
  const messages: string[] = []
  try {
    if (platforms.length > 0) {
      const prepared: Builders = { ...builders }
      let ruby: Promise<string> | undefined
      if (dependencies)
        for (const os of ['ios', 'macos'] as const) {
          const build = builders[os]
          if (build == null) continue
          prepared[os] = async context => {
            ruby ??= new Processes(cancel.signal).run({
              file: settings.tools.bundle,
              args: ['install', '--jobs', '4'],
              cwd,
              env: bundleEnvironment(),
              capture: false
            })
            await ruby
            return await build(context)
          }
        }
      const options: Options = {
        app,
        branch,
        config,
        buildNumberFile: counter,
        platforms,
        dryRun: false
      }
      code = await run(
        options,
        prepared,
        cancel.signal,
        message => {
          console.log(message)
          if (/^(ios|android|macos) /.test(message)) messages.push(message)
        },
        cwd,
        env
      )
    }
  } catch {
    console.error(
      'Mason deployment failed; check private configuration and required tools'
    )
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    writeFileSync(
      resultFile,
      JSON.stringify({
        app,
        branch,
        platforms,
        skipped,
        messages,
        status:
          code === 0 ? (skipped.length > 0 ? 'partial' : 'succeeded') : 'failed'
      }),
      { mode: 0o600 }
    )
  }
  return skipped.length === 0 ? code : 1
}
if (require.main === module) {
  masonDeploy()
    .then(code => {
      process.exitCode = code
    })
    .catch(() => {
      console.error(
        'Invalid Mason build environment or deployment configuration'
      )
      process.exitCode = 1
    })
}
