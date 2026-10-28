// Prints the origins the web app loads media from, space-separated, for a
// deployment's serverConfig.json. The deploy scripts hand the answer to
// `npm run build.web` as TS_MEDIA_ORIGINS, which `src/build.mjs` writes into
// the page's Content-Security-Policy.
//
//   node src/deploy/mediaOrigins.mjs /var/app/serverConfig.json
//
// The TypeScript is loaded the way scripts/game-socket-listen.mjs loads it,
// through sucrase. The config is parsed with the side-effect-free schema, so
// nothing is read from the working directory.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('sucrase/register')
const { mediaOriginsOfJson } = require('../server/media/mediaOrigins.ts')

const path = process.argv[2]
if (path == null) {
  console.error('usage: node src/deploy/mediaOrigins.mjs <serverConfig.json>')
  process.exit(2)
}
console.log(
  mediaOriginsOfJson(JSON.parse(readFileSync(path, 'utf8'))).join(' ')
)
