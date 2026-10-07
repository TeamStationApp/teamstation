const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { asObject, asString } = require('cleaners')

const clean = asObject({
  app: asString,
  version: asString,
  buildNumber: asString,
  branch: asString,
  commit: asString,
  builtAt: asString
})

/** Only these public provenance fields enter web and native bundles. */
function bundleBuildInfo(
  root = path.resolve(__dirname, '..'),
  env = process.env
) {
  if (env.TS_BUILD_INFO != null && env.TS_BUILD_INFO !== '')
    return JSON.stringify(clean(JSON.parse(env.TS_BUILD_INFO)))
  const run = (...args) => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch {
      return 'development'
    }
  }
  // An archived release supplies its metadata explicitly; a checkout can
  // still build without the private deployment configuration.
  return JSON.stringify(
    clean({
      app: 'TeamStation',
      version: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
        .version,
      buildNumber: env.TS_BUILD_NUMBER ?? 'development',
      branch: run('branch', '--show-current') || 'detached',
      commit: run('rev-parse', 'HEAD'),
      builtAt: new Date().toISOString()
    })
  )
}
module.exports = { bundleBuildInfo }
