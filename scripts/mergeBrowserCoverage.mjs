// Merges istanbul coverage files, such as the browser coverage each puppeteer
// harness records (`TS_BROWSER_COVERAGE_OUT`), into one file for
// `npm run coverage.tess` (`TS_DIRECT_BROWSER_COVERAGE`). Counters are added
// file by file; nothing is averaged.
//
//   node scripts/mergeBrowserCoverage.mjs <out> <in> [<in> …]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const [output, ...inputs] = process.argv.slice(2)
if (output == null || inputs.length === 0) {
  console.error('usage: node scripts/mergeBrowserCoverage.mjs <out> <in>…')
  process.exit(2)
}
const { createCoverageMap } = createRequire(resolve('package.json'))(
  'istanbul-lib-coverage'
)
const merged = createCoverageMap({})
for (const input of inputs) {
  const map = createCoverageMap(JSON.parse(readFileSync(input, 'utf8')))
  console.log(`${input}: ${map.files().length} files`)
  merged.merge(map)
}
mkdirSync(dirname(resolve(output)), { recursive: true })
writeFileSync(output, JSON.stringify(merged.toJSON()))
console.log(`${output}: ${merged.files().length} files`)
