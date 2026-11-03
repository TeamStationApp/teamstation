import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'

import { coverageSource } from './coverage-source.mjs'

const base = process.argv.indexOf('--base')
const env = {
  ...process.env,
  TS_MANAGER_COACH_COVERAGE: '1',
  TS_MANAGER_SOURCE: coverageSource(),
  TS_COVERAGE_BASE:
    base < 0
      ? execFileSync('git', ['merge-base', 'HEAD', 'origin/master'], {
          encoding: 'utf8'
        }).trim()
      : process.argv[base + 1]
}
mkdirSync('coverage/manager', { recursive: true })
// The unit and browser counters must come from the same checkout.
rmSync('coverage/manager/server', { recursive: true, force: true })
rmSync('coverage/manager/browser.json', { force: true })
for (const args of [
  ['src/build.mjs'],
  ['-r', 'sucrase/register', 'src/app/headCoach.e2e.ts']
]) {
  const run = spawnSync(process.execPath, args, {
    env: {
      ...env,
      TS_MANAGER_ARTIFACTS:
        process.env.TS_MANAGER_ARTIFACTS ?? 'coverage/manager/proof',
      ...(args[0] === '-r'
        ? {
            NODE_V8_COVERAGE: 'coverage/manager/server',
            TS_MANAGER_BROWSER_COVERAGE: 'coverage/manager/browser.json'
          }
        : {})
    },
    stdio: 'inherit'
  })
  if (run.status !== 0) process.exit(run.status ?? 1)
}
for (const mode of ['unit', 'combined']) {
  const args = ['scripts/auto-scheduler-coverage.mjs']
  if (mode === 'unit') args.push('--unit')
  else {
    args.push('--reuse-unit')
    env.TS_AUTO_SCHEDULER_BROWSER_COVERAGE = 'coverage/manager/browser.json'
    env.TS_AUTO_SCHEDULER_SERVER_COVERAGE = 'coverage/manager/server'
  }
  const run = spawnSync(process.execPath, args, { env, stdio: 'inherit' })
  const report = 'coverage/manager/coverage-final.json'
  if (run.status !== 0) process.exit(run.status ?? 1)
  if (mode === 'combined') copyFileSync(report, `coverage/manager/${mode}.json`)
  const check = spawnSync(
    process.execPath,
    [
      'scripts/changed-line-check.cjs',
      '--base',
      env.TS_COVERAGE_BASE,
      '--coverage',
      `coverage/manager/${mode}.json`,
      '--ext',
      '.ts',
      '--ext',
      '.tsx',
      '--min',
      mode === 'unit' ? '90' : '95',
      // Only interfaces changed in these two files.
      '--exclude',
      'src/common/autoScheduler/types.ts',
      '--exclude',
      'src/server/db/database.ts',
      '--exclude',
      'src/test',
      '--exclude',
      '**/*.test.*',
      '--exclude',
      '**/*.e2e.*',
      'src'
    ],
    { stdio: 'inherit' }
  )
  if (check.status !== 0) process.exitCode = 1
}
