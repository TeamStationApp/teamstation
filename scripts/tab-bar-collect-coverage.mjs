// Measure a supplementary workload before passing its printed receipt to
// coverage.tabBar -- --supplement FILE. Every run writes into a fresh directory.
// See e2e/README.md for browser, integration and simulator examples.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'

import { coverageBase } from './ios-app-banner-source.cjs'
import { mergeCounts } from './observability-line-gate.cjs'
import {
  jsCounts,
  jsIncludes,
  measured,
  readJson,
  sourceStamp,
  verifyNodeSources
} from './tab-bar-line-gates.mjs'
import {
  measureNative,
  measureSimulatorJourney
} from './tab-bar-native-coverage.mjs'

const [mode, ...args] = process.argv.slice(2)
if (
  mode !== 'browser-build' &&
  (!['node', 'browser', 'xctest', 'ios'].includes(mode) || !args.length)
)
  throw new Error(
    'Supply browser-build, node COMMAND, browser SCENARIO [options], xctest TEST-ID…, or ios COMMAND'
  )
const source = sourceStamp()
const reports = resolve('coverage/tabBar')
mkdirSync(reports, { recursive: true })
const dir = mkdtempSync(join(reports, mode + '-'))
let counts
if (mode === 'node') {
  execFileSync(
    resolve('node_modules/.bin/c8'),
    [
      '--reporter=json',
      '--reports-dir',
      dir,
      '--temp-directory',
      join(dir, 'v8'),
      '--exclude-after-remap',
      ...jsIncludes.flatMap(scope => ['--include', scope]),
      ...args
    ],
    { stdio: 'inherit' }
  )
  counts = jsCounts(readJson(join(dir, 'coverage-final.json')))
  const raw = join(dir, 'v8')
  verifyNodeSources(
    counts,
    readdirSync(raw)
      .filter(name => /^coverage-.*\.json$/.test(name))
      .map(name => readJson(join(raw, name)))
  )
} else if (mode === 'browser-build') {
  const webDir = join(dir, 'web')
  execFileSync(process.execPath, ['src/build.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, TS_WEB_OUT_DIR: webDir }
  })
  const assets = Object.fromEntries(
    readdirSync(webDir)
      .filter(name => /^app-.*\.js(?:\.map)?$/.test(name))
      .map(name => [
        name,
        createHash('sha256')
          .update(readFileSync(join(webDir, name)))
          .digest('hex')
      ])
  )
  if (sourceStamp() !== source)
    throw new Error('Source changed during the web build')
  writeFileSync(join(dir, 'source.json'), JSON.stringify({ source, assets }), {
    flag: 'wx'
  })
  console.log(webDir)
  process.exit(0)
} else if (mode === 'browser') {
  const directory = process.env.TS_TAB_COVERAGE_WEB_DIR
  if (!directory)
    throw new Error(
      'Set TS_TAB_COVERAGE_WEB_DIR to the browser-build directory served by the attached stack'
    )
  const webDir = resolve(directory)
  const { source: builtSource, assets } = readJson(
    join(webDir, '..', 'source.json')
  )
  if (builtSource !== source)
    throw new Error('Browser build belongs to a different source revision')
  const maps = join(dir, 'browser')
  execFileSync(
    process.execPath,
    [
      '-r',
      'sucrase/register',
      'e2e/core/cli.ts',
      'run',
      ...args,
      '--surface',
      'web-chromium',
      '--browser-coverage',
      maps
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        TS_TAB_COVERAGE_WEB_DIR: webDir,
        TS_TAB_COVERAGE_ASSETS: JSON.stringify(assets)
      }
    }
  )
  counts = mergeCounts(
    ...readdirSync(maps)
      .filter(name => name.endsWith('.json'))
      .map(name => jsCounts(readJson(join(maps, name))))
  )
} else if (mode === 'xctest') {
  counts = measureNative(coverageBase(), dir, args)
} else {
  counts = await measureSimulatorJourney(coverageBase(), dir, args)
}
if (sourceStamp() !== source)
  throw new Error('Source changed during coverage collection')
const kind = mode === 'xctest' || mode === 'ios' ? 'native' : 'js'
const receipt = join(dir, 'measured.json')
writeFileSync(receipt, JSON.stringify(measured(kind, source, counts)), {
  flag: 'wx'
})
console.log(receipt)
