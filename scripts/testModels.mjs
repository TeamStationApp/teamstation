// The integration tests that ask a real model, which cost money and need an
// Anthropic key:
//
//   npm run test.models
//
// runs the dictation interpreter files and Tess's cases with the commands
// their headers give. The key comes from TS_DICTATION_CONFIG (a file holding
// `{ "dictation": { "anthropic": { "apiKey": … } } }`), or from the
// `anthropic` secret of the end-to-end settings (`readSecret`), written into
// such a file, mode 0600, for the run and removed after. With neither, each
// file is reported skipped, never passed, and the run exits 2.
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const MOCHA = [
  'node_modules/mocha/bin/mocha.js',
  '--exit',
  '-r',
  'sucrase/register'
]
const DOM = ['-r', './src/test/scoringDomSetup.cjs', '--extension', 'ts']

/** Each model-backed file and the command its header names. */
export const MODEL_TESTS = [
  {
    file: 'src/app/scoring/dictatedDefense.integration.ts',
    args: [...MOCHA, '--timeout', '180000']
  },
  {
    file: 'src/app/scoring/dictatedDistance.integration.ts',
    args: [...MOCHA, '--timeout', '180000', ...DOM]
  },
  {
    file: 'src/app/scoring/dictatedFieldersChoice.integration.ts',
    args: [...MOCHA, '--timeout', '180000', ...DOM]
  },
  {
    file: 'src/app/scoring/dictatedForcePlays.integration.ts',
    args: [...MOCHA, '--timeout', '180000', ...DOM]
  },
  {
    file: 'src/server/dictation/promptCases.integration.ts',
    args: [...MOCHA, '--extension', 'ts', '--timeout', '180000']
  },
  {
    file: 'src/server/tess/tess.integration.ts',
    args: ['-r', 'sucrase/register'],
    config: 'TS_TESS_CONFIG'
  }
]

/**
 * Where the key is: the config file the environment names, or one written
 * from `secret` (null when there is no key). `cleanup` removes a written one.
 */
export function modelConfig(env, secret) {
  if (env.TS_DICTATION_CONFIG != null && env.TS_DICTATION_CONFIG !== '')
    return { file: env.TS_DICTATION_CONFIG, cleanup: () => {} }
  const key = secret()
  if (key == null || key === '') return null
  const dir = mkdtempSync(join(tmpdir(), 'teamstation-models-'))
  const file = join(dir, 'dictation.json')
  writeFileSync(
    file,
    JSON.stringify({ dictation: { anthropic: { apiKey: key } } }),
    { mode: 0o600 }
  )
  return {
    file,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Runs every model test and answers a line per file and the exit code. */
export function runModels(env, secret, run = spawnSync) {
  const config = modelConfig(env, secret)
  if (config == null) {
    return {
      code: 2,
      lines: MODEL_TESTS.map(
        test =>
          `skipped\t${test.file}\tno Anthropic key: set TS_DICTATION_CONFIG or the anthropic secret`
      )
    }
  }
  try {
    const lines = []
    let failed = false
    for (const test of MODEL_TESTS) {
      const result = run(process.execPath, [...test.args, test.file], {
        stdio: 'inherit',
        env: {
          ...env,
          TS_DICTATION_CONFIG: config.file,
          [test.config ?? 'TS_DICTATION_CONFIG']: config.file
        }
      })
      const passed = result.status === 0
      if (!passed) failed = true
      lines.push(
        `${passed ? 'passed' : 'failed'}\t${test.file}\texit ${String(result.status)}`
      )
    }
    return { code: failed ? 1 : 0, lines }
  } finally {
    config.cleanup()
  }
}

/**
 * The `anthropic` secret of the end-to-end settings (`e2e/core/settings.ts`:
 * E2E_LOCAL_SETTINGS or ~/.config/teamstation-e2e/local.json, whose
 * `secretsFile` holds it), or null.
 */
export function settingsSecret(env = process.env) {
  const settings =
    env.E2E_LOCAL_SETTINGS ??
    join(homedir(), '.config', 'teamstation-e2e', 'local.json')
  if (!existsSync(settings)) return null
  const { secretsFile } = JSON.parse(readFileSync(settings, 'utf8'))
  if (secretsFile == null || !existsSync(secretsFile)) return null
  const value = JSON.parse(readFileSync(secretsFile, 'utf8')).anthropic
  return typeof value === 'string' && value !== '' ? value : null
}

if (process.argv[1] != null && process.argv[1].endsWith('testModels.mjs')) {
  const { code, lines } = runModels(process.env, () => settingsSecret())
  process.stdout.write(`\n${lines.join('\n')}\n`)
  process.exit(code)
}
