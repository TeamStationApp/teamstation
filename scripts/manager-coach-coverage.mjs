import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'

const base = process.argv.indexOf('--base')
const env = {
  ...process.env,
  TS_MANAGER_COACH_COVERAGE: '1',
  TS_COVERAGE_BASE: base < 0 ? 'origin/master' : process.argv[base + 1]
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
  if (existsSync(report)) copyFileSync(report, `coverage/manager/${mode}.json`)
  if (run.status !== 0) process.exitCode = 1
}
