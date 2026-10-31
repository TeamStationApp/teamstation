import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { buildManifest, readManifest, ROOT, writeManifest } from './manifest'
import { type PlanResource, planScenarios } from './plan'
import { prepareApp } from './prepare'
import { runScenario } from './run'
import { selectScenarios } from './select'
import { loadSettings, type LocalSettings } from './settings'
import type { StackHandle } from './spec'
import { startStack } from './stack'
import { trackedFiles, validate } from './validate'

const STACKS = join(tmpdir(), 'teamstation-e2e-stacks')

function stackState(id: string): {
  id: string
  origin: string
  webDir?: string
  pid: number
} {
  const file = join(STACKS, `${id}.json`)
  if (!existsSync(file)) throw new Error(`No stack "${id}"`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function roleMap(values: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const value of values ?? []) {
    const at = value.indexOf('=')
    if (at < 1) throw new Error(`--device wants role=id, got "${value}"`)
    out[value.slice(0, at)] = value.slice(at + 1)
  }
  return out
}

function targetFor(
  values: { seat?: string; stack?: string },
  settings: LocalSettings
): string | undefined {
  if (values.seat != null) return settings.seats?.[values.seat]?.origin
  if (values.stack != null) return stackState(values.stack).origin
  return undefined
}

const OPTIONS = {
  category: { type: 'string' },
  surface: { type: 'string' },
  json: { type: 'boolean' },
  strict: { type: 'boolean' },
  changed: { type: 'string', multiple: true },
  base: { type: 'string' },
  resources: { type: 'string' },
  seat: { type: 'string' },
  stack: { type: 'string' },
  ledger: { type: 'string' },
  lan: { type: 'boolean' },
  native: { type: 'boolean' },
  id: { type: 'string' },
  services: { type: 'string', multiple: true },
  app: { type: 'string' },
  device: { type: 'string', multiple: true },
  package: { type: 'string' },
  'run-dir': { type: 'string' },
  retries: { type: 'string' },
  'budget-usd': { type: 'string' }
} as const

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true
  })
  const [command, subcommand] = positionals
  const settings = loadSettings()
  const print = (value: unknown): void => {
    console.log(JSON.stringify(value, null, 2))
  }

  switch (command) {
    case 'manifest':
      print({ scenarios: writeManifest().scenarios.length })
      return 0

    case 'list': {
      const rows = buildManifest().scenarios.filter(
        row =>
          (values.category == null ||
            row.spec.startsWith(`${values.category}/`)) &&
          (values.surface == null || values.surface in row.surfaces)
      )
      if (values.json === true) {
        print(rows)
      } else {
        for (const row of rows) {
          console.log(`${row.id}  ${row.title}`)
        }
      }
      return 0
    }

    case 'validate': {
      const report = validate(ROOT, { strict: values.strict })
      print(report)
      return report.problems.length === 0 ? 0 : 1
    }

    case 'select': {
      let changed = values.changed ?? []
      if (values.base != null) {
        const { execFileSync } = await import('node:child_process')
        changed = execFileSync(
          'git',
          ['diff', '--name-only', `${values.base}...HEAD`],
          { cwd: ROOT, encoding: 'utf8' }
        )
          .trim()
          .split('\n')
          .filter(Boolean)
      }
      print(selectScenarios(readManifest(), changed))
      return 0
    }

    case 'plan': {
      const resources = (
        values.resources == null
          ? {}
          : (JSON.parse(readFileSync(values.resources, 'utf8')).resources ?? {})
      ) as Record<string, PlanResource>
      const ledger =
        values.ledger == null
          ? undefined
          : JSON.parse(readFileSync(values.ledger, 'utf8'))
      print(
        planScenarios(buildManifest(), {
          resources,
          seat: values.seat,
          settings,
          ledger
        })
      )
      return 0
    }

    case 'stack': {
      if (subcommand === 'up') {
        mkdirSync(STACKS, { recursive: true })
        const id = values.id ?? Math.random().toString(36).slice(2, 10)
        const args = [
          '-r',
          require.resolve('sucrase/register'),
          __filename,
          'stack',
          'serve',
          '--id',
          id,
          ...(values.lan === true ? ['--lan'] : []),
          ...(values.native === true ? ['--native'] : []),
          ...(values.services ?? ['web', 'api']).flatMap(s => ['--services', s])
        ]
        const child = spawn(process.execPath, args, {
          cwd: ROOT,
          detached: true,
          stdio: 'ignore'
        })
        child.unref()
        const end = Date.now() + 300000
        const file = join(STACKS, `${id}.json`)
        while (!existsSync(file)) {
          if (Date.now() > end) throw new Error('The stack did not start')
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        print(stackState(id))
        return 0
      }
      if (subcommand === 'serve') {
        const stack = await startStack({
          id: values.id,
          lan: values.lan,
          native: values.native,
          services: values.services ?? ['web', 'api']
        })
        writeFileSync(
          join(STACKS, `${stack.id}.json`),
          JSON.stringify({
            id: stack.id,
            origin: stack.origin,
            webDir: stack.webDir,
            pid: process.pid
          })
        )
        await new Promise<void>(resolve => {
          process.once('SIGTERM', () => {
            resolve()
          })
        })
        await stack.stop()
        return 0
      }
      if (subcommand === 'down') {
        const id = positionals[2]
        const state = stackState(id)
        process.kill(state.pid, 'SIGTERM')
        const { rmSync } = await import('node:fs')
        rmSync(join(STACKS, `${id}.json`))
        print({ id, stopped: true })
        return 0
      }
      throw new Error('stack wants up, down or serve')
    }

    case 'prepare': {
      if (values.app == null || values.device == null) {
        throw new Error('prepare wants --app and --device')
      }
      const origin = targetFor(values, settings)
      if (values.package == null && origin == null) {
        throw new Error('prepare wants --stack, --seat or --package')
      }
      prepareApp({
        app: values.app,
        device: values.device[0],
        packagePath: values.package,
        origin
      })
      print({ prepared: values.app })
      return 0
    }

    case 'run': {
      const id = subcommand
      if (id == null || values.surface == null) {
        throw new Error('run wants <scenario-id> --surface <s>')
      }
      let stack: StackHandle | undefined
      if (values.stack != null) {
        const state = stackState(values.stack)
        stack = {
          kind: 'isolated',
          origin: state.origin,
          webDir: state.webDir,
          adopt: origin => origin
        }
      }
      const outcome = await runScenario({
        id,
        surface: values.surface,
        devices: roleMap(values.device),
        seat: values.seat,
        stack,
        runDir: values['run-dir'],
        retries: values.retries == null ? 0 : Number(values.retries),
        budgetUsd:
          values['budget-usd'] == null
            ? settings.judgeBudgetUsd
            : Number(values['budget-usd']),
        settings
      })
      print({ ...outcome.result, runDir: outcome.runDir })
      return outcome.exitCode
    }

    default:
      throw new Error(`Unknown command "${command}"`)
  }
}

export const trackedForTests = trackedFiles

if (require.main === module) {
  main(process.argv.slice(2))
    .then(code => {
      process.exit(code)
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(3)
    })
}
