/**
 * The app link host a React Native build was given: `appOrigin` from the
 * gitignored clientConfig.json at the root, which Mason writes for its builds
 * and appLinks.mjs client writes for a local one. An explicit TS_APP_ORIGIN
 * wins; no file and no variable is the empty string, a build that asks for
 * ordinary web sign-in links.
 */
const { readFileSync } = require('node:fs')
const path = require('node:path')

function appOrigin(root = path.join(__dirname, '..')) {
  if (process.env.TS_APP_ORIGIN != null) return process.env.TS_APP_ORIGIN
  try {
    const config = JSON.parse(
      readFileSync(path.join(root, 'clientConfig.json'), 'utf8')
    )
    return typeof config.appOrigin === 'string' ? config.appOrigin : ''
  } catch {
    return ''
  }
}

module.exports = { appOrigin }
