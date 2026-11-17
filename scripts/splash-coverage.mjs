// The launch splash's changed-line coverage gates, at 90%:
//
//   TS_COVERAGE_BASE=origin/develop node scripts/splash-coverage.mjs --js
//
// --js     scripts/splash/** through c8 over the unit test and the macOS-only
//          generator test (scripts/splash/splashAssets.mac-test.ts).
// Every command is printed on a `$` line before it runs.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const base = process.env.TS_COVERAGE_BASE
if (base == null)
  throw new Error(
    'Supply TS_COVERAGE_BASE, the base the branch is measured from'
  )
const modes = process.argv.slice(2)
const known = ['--js', '--all']
if (modes.length === 0 || modes.some(mode => !known.includes(mode)))
  throw new Error(`Specify one of ${known.join(', ')}`)
const all = modes.includes('--all')

const run = (file, args, options = {}) => {
  console.log('$ ' + [file, ...args].join(' '))
  execFileSync(file, args, { stdio: 'inherit', ...options })
}
const gate = args =>
  run('node', [
    'scripts/changed-line-check.cjs',
    '--base',
    base,
    '--min',
    '90',
    ...args
  ])

if (all || modes.includes('--js')) {
  const dir = resolve('coverage/splash/js')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  run('npx', [
    'c8',
    '--reporter=json',
    '--reporter=text-summary',
    '--report-dir',
    dir,
    '--include',
    'scripts/splash/*.mjs',
    'mocha',
    '-r',
    'sucrase/register',
    '--extension',
    'ts',
    'src/test/splashAssets.test.ts',
    'scripts/splash/splashAssets.mac-test.ts'
  ])
  gate([
    '--coverage',
    'coverage/splash/js/coverage-final.json',
    '--ext',
    '.mjs',
    'scripts/splash'
  ])
}
