import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const base = process.env.TS_UMPIRE_BASE
if (!base || !process.env.TS_UMPIRE_ARTIFACTS)
  throw new Error('Supply TS_UMPIRE_BASE and TS_UMPIRE_ARTIFACTS')
execFileSync(process.execPath, ['src/build.mjs'], {
  cwd: base,
  stdio: 'inherit'
})
execFileSync(
  process.execPath,
  ['-r', 'sucrase/register', resolve('src/app/umpireBefore.e2e.ts')],
  {
    stdio: 'inherit',
    env: { ...process.env, TS_UMPIRE_WEB: resolve(base, 'dist') }
  }
)
