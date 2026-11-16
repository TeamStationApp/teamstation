import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { PNG } from 'pngjs'

import {
  attachStack,
  baselineFile,
  forgetStack,
  listStacks,
  readStack,
  type StackEntry,
  stackHandleFor,
  STACKS,
  writeStackEntry
} from './attach'
import {
  addToCorpus,
  type CorpusItem,
  logItem,
  readCorpus,
  scoreJudge,
  screenItems
} from './corpus'
import { mergeCoverage } from './coverage'
import { detectFault } from './detect'
import { requireDropletHandle, seedOnStack } from './dropletStack'
import {
  acceptGolden,
  type GoldenManifest,
  requireStore,
  rotateStore,
  syncStore
} from './goldens'
import {
  Budget,
  createMessage,
  HAIKU,
  haikuJudge,
  type JudgeInput,
  readJudgeBar,
  writeJudgeBar
} from './judge'
import { type DetectRow, ledgerPath, readLedger } from './ledger'
import { readLegacy } from './legacy'
import { buildManifest, readManifest, ROOT, writeManifest } from './manifest'
import { type PlanResource, planScenarios } from './plan'
import { prepareApp } from './prepare'
import { BlockedError, HarnessError } from './result'
import { runScenario } from './run'
import { runMany } from './runMany'
import { buildScorecard } from './scorecard'
import { selectScenarios } from './select'
import { loadSettings, type LocalSettings, readSecret } from './settings'
import type { StackHandle, Surface } from './spec'
import { trackedFiles, validate } from './validate'
import { openWebSession } from './web'

/** `--retries`: a whole number, 0 or more. */
function retryCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`--retries wants a whole number, 0 or more, not ${value}`)
  }
  return Number(value)
}

/**
 * Runs the stack provider (`stackProvider` in the local settings) with
 * `args`, passing its progress through to stderr, and answers what it
 * printed. A provider that fails is a harness error carrying its last words.
 */
export async function runProvider(
  settings: LocalSettings,
  args: string[],
  spawnFn: typeof spawn = spawn
): Promise<string[]> {
  const command = settings.stackProvider?.command
  if (command == null || command.length === 0) {
    throw new BlockedError(
      'no stack provider: set stackProvider.command in the local settings'
    )
  }
  const child = spawnFn(command[0], [...command.slice(1), ...args], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  let err = ''
  child.stdout?.on('data', (bytes: Buffer) => {
    out += String(bytes)
    process.stderr.write(bytes)
  })
  child.stderr?.on('data', (bytes: Buffer) => {
    err += String(bytes)
    process.stderr.write(bytes)
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const lines = out.split('\n').filter(Boolean)
  if (code !== 0) {
    throw new HarnessError(
      `the stack provider failed (${args[0]}): ${[...lines, ...err.split('\n')].filter(Boolean).slice(-5).join(' | ')}`
    )
  }
  return lines
}

/** The handle path `up` prints on its last `handle: <path>` line. */
export function handleOf(lines: string[]): string {
  const line = [...lines].reverse().find(row => row.startsWith('handle: '))
  if (line == null) {
    throw new HarnessError('the stack provider printed no handle')
  }
  return line.slice('handle: '.length).trim()
}

function stackState(id: string): StackEntry {
  return readStack(STACKS, id)
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

/** A capture with the app's failure screen over it, drawn by a real browser. */
async function renderErrorDialog(
  settings: LocalSettings,
  runDir: string,
  capture: Buffer
): Promise<Buffer> {
  const { width, height } = PNG.sync.read(capture)
  const page = join(runDir, 'error-dialog.html')
  writeFileSync(
    page,
    `<!doctype html><body style="margin:0;font-family:sans-serif">
<img src="data:image/png;base64,${capture.toString('base64')}" style="display:block">
<div style="position:fixed;inset:20% 10%;background:#fff;border:1px solid #888;padding:24px;text-align:center">
<h2>Something went wrong</h2><p>The app hit a problem drawing this screen.</p><button>Reload</button>
</div></body>`
  )
  const session = await openWebSession(settings, runDir, { width, height })
  try {
    await session.m.openLink({ link: `file://${page}` })
    await session.m.assertVisible({ text: 'Something went wrong' })
    return Buffer.from(await session.m.screenshot())
  } finally {
    await session.close()
  }
}

function gitOutput(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
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
  stacks: { type: 'string' },
  ledger: { type: 'string' },
  lan: { type: 'boolean' },
  native: { type: 'boolean' },
  id: { type: 'string' },
  ref: { type: 'string' },
  name: { type: 'string' },
  services: { type: 'string', multiple: true },
  app: { type: 'string' },
  device: { type: 'string', multiple: true },
  package: { type: 'string' },
  'run-dir': { type: 'string' },
  checkpoint: { type: 'string' },
  judge: { type: 'string' },
  'browser-coverage': { type: 'string' },
  out: { type: 'string' },
  fault: { type: 'string' },
  question: { type: 'string' },
  'false-question': { type: 'string' },
  expected: { type: 'string' },
  'manifest-ref': { type: 'string' },
  concurrent: { type: 'boolean' },
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
        const modules = readLegacy(ROOT).modules ?? {}
        for (const file of Object.keys(modules).sort()) {
          if (values.category == null || modules[file] === values.category) {
            console.log(`legacy ${file}`)
          }
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
        // A droplet of its own, from the provider's pool, attached once it is up.
        const ref = values.ref ?? 'develop'
        const lines = await runProvider(settings, [
          'up',
          '--ref',
          ref,
          ...(values.name == null ? [] : ['--name', values.name])
        ])
        const entry = attachStack(STACKS, handleOf(lines))
        if (settings.mailbox != null) {
          const handle = requireDropletHandle(
            entry.handle ?? { version: 0, id: entry.id, origin: entry.origin }
          )
          const baseline = await seedOnStack(
            handle,
            'baseline',
            settings.mailbox
          )
          const file = baselineFile(STACKS, entry.id)
          writeFileSync(file, JSON.stringify(baseline), { mode: 0o600 })
          entry.baselineManifest = file
          writeStackEntry(
            STACKS,
            join(STACKS, `${entry.id}.json`),
            JSON.stringify(entry, null, 2)
          )
        }
        print(entry)
        return 0
      }
      if (subcommand === 'down') {
        const id = positionals[2]
        if (id == null) throw new Error('stack down wants <id>')
        readStack(STACKS, id)
        await runProvider(settings, ['down', id])
        forgetStack(STACKS, id)
        print({ id, down: true })
        return 0
      }
      if (subcommand === 'prune') {
        // The provider removes what runs left; the registry forgets stacks whose handle went with them.
        await runProvider(settings, ['reap'])
        const forgotten = listStacks(STACKS)
          .filter(
            entry => entry.handleFile == null || !existsSync(entry.handleFile)
          )
          .map(entry => entry.id)
        for (const id of forgotten) forgetStack(STACKS, id)
        print({ forgotten })
        return 0
      }
      if (subcommand === 'attach') {
        const file = positionals[2]
        if (file == null) throw new Error('stack attach wants <handle.json>')
        print(attachStack(STACKS, file))
        return 0
      }
      if (subcommand === 'list') {
        print(listStacks(STACKS))
        return 0
      }
      throw new Error('stack wants up, down, prune, attach or list')
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

    case 'run-many': {
      const scenarios = positionals.slice(1)
      if (
        scenarios.length === 0 ||
        values.surface == null ||
        values.stacks == null
      ) {
        throw new Error(
          'run-many wants <scenario-id>… --stacks <id,id,…> --surface <s> [--device role=id]…'
        )
      }
      const { rows, exitCode } = await runMany({
        scenarios,
        stacks: values.stacks.split(',').map(id => ({
          id,
          handle: stackHandleFor(stackState(id), settings.mailbox)
        })),
        surface: values.surface as Surface,
        devices: roleMap(values.device),
        settings,
        ...(values.retries == null
          ? {}
          : { retries: retryCount(values.retries) }),
        run: runScenario,
        say: line => {
          console.error(line)
        }
      })
      print({ rows, exitCode })
      return exitCode
    }

    case 'run': {
      const id = subcommand
      if (id == null || values.surface == null) {
        throw new Error('run wants <scenario-id> --surface <s>')
      }
      const stack: StackHandle | undefined =
        values.stack == null
          ? undefined
          : stackHandleFor(stackState(values.stack), settings.mailbox)
      const outcome = await runScenario({
        id,
        surface: values.surface,
        devices: roleMap(values.device),
        seat: values.seat,
        stack,
        runDir: values['run-dir'],
        retries: values.retries == null ? 0 : retryCount(values.retries),
        concurrent: values.concurrent,
        browserCoverage: values['browser-coverage'],
        budgetUsd:
          values['budget-usd'] == null
            ? settings.judgeBudgetUsd
            : Number(values['budget-usd']),
        settings
      })
      print({ ...outcome.result, runDir: outcome.runDir })
      return outcome.exitCode
    }

    case 'coverage-merge': {
      const dir = subcommand
      if (dir == null || values.out == null) {
        throw new Error('coverage-merge wants <dir> --out <file>')
      }
      print({ merged: mergeCoverage(dir, values.out), out: values.out })
      return 0
    }

    case 'detect': {
      const id = subcommand
      if (id == null || values.surface == null || values.fault == null) {
        throw new Error(
          'detect wants <scenario-id> --fault <fault> --surface <s> [--stack <id>]'
        )
      }
      // A proxy fault is set on the named stack's fault server, and cleared after.
      const outcome = await detectFault(
        {
          id,
          surface: values.surface,
          fault: values.fault,
          ...(values.stack == null
            ? {}
            : {
                stack: stackHandleFor(
                  stackState(values.stack),
                  settings.mailbox
                )
              }),
          devices: roleMap(values.device),
          runDir: values['run-dir'],
          settings
        },
        ledgerPath(settings, values.ledger)
      )
      print({ ...outcome.row, runDir: outcome.runDir })
      return outcome.exitCode
    }

    case 'scorecard': {
      const rows = readLedger(ledgerPath(settings, values.ledger)).filter(
        (row): row is DetectRow => row.kind === 'detect'
      )
      print(buildScorecard(rows))
      return 0
    }

    case 'golden': {
      if (subcommand === 'accept') {
        const runDir = positionals[2]
        if (runDir == null || values.checkpoint == null) {
          throw new Error('golden accept wants <run-dir> --checkpoint <id>')
        }
        print(
          acceptGolden({
            root: ROOT,
            store: settings.goldenStore,
            runDir,
            checkpoint: values.checkpoint,
            headRef: gitOutput(['rev-parse', '--short', 'HEAD'])
          })
        )
        return 0
      }
      if (subcommand === 'sync') {
        print({ refs: syncStore(requireStore(settings.goldenStore)) })
        return 0
      }
      if (subcommand === 'rotate') {
        const ref = values['manifest-ref'] ?? 'origin/master'
        const keep = JSON.parse(
          gitOutput(['show', `${ref}:e2e/goldens/manifest.json`])
        ) as GoldenManifest
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
        print(
          rotateStore({
            store: requireStore(settings.goldenStore),
            keep,
            date
          })
        )
        return 0
      }
      throw new Error('golden wants accept, sync or rotate')
    }

    case 'judge-eval': {
      if (values.judge !== 'haiku') {
        throw new Error('judge-eval wants --judge haiku')
      }
      const store = requireStore(settings.goldenStore)
      const corpus = readCorpus(store)
      if (corpus.items.length === 0) {
        throw new BlockedError(
          'the corpus is empty: run `e2e judge-corpus add`'
        )
      }
      const apiKey = readSecret(settings, 'anthropic')
      const judge = haikuJudge({
        messages: { create: async body => await createMessage(apiKey, body) }
      })
      const read = (item: CorpusItem): JudgeInput =>
        item.file.endsWith('.txt')
          ? { kind: 'text', text: readFileSync(join(store, item.file), 'utf8') }
          : { kind: 'image', png: readFileSync(join(store, item.file)) }
      const score = await scoreJudge(
        judge,
        corpus,
        read,
        new Budget(
          values['budget-usd'] == null ? 2 : Number(values['budget-usd'])
        )
      )
      const bar = readJudgeBar(ROOT)
      bar.judges[judge.id] = {
        passed: score.passed,
        recall: score.recall,
        falseFailures: score.falseFailures,
        model: HAIKU.model,
        date: new Date().toISOString().slice(0, 10)
      }
      writeJudgeBar(ROOT, bar)
      print(score)
      return score.passed ? 0 : 1
    }

    case 'judge-corpus': {
      const store = requireStore(settings.goldenStore)
      if (subcommand === 'add') {
        const runDir = positionals[2]
        if (
          runDir == null ||
          values.checkpoint == null ||
          values.question == null ||
          values['false-question'] == null
        ) {
          throw new Error(
            'judge-corpus add wants <run-dir> --checkpoint --question --false-question'
          )
        }
        const capture = readFileSync(
          join(runDir, 'captures', `${values.checkpoint}.png`)
        )
        const dialog = await renderErrorDialog(settings, runDir, capture)
        print({
          added: addToCorpus(
            store,
            screenItems(
              capture,
              values.question,
              values['false-question'],
              dialog
            )
          )
        })
        return 0
      }
      if (subcommand === 'add-log') {
        const file = positionals[2]
        const expected = values.expected
        if (
          file == null ||
          values.question == null ||
          (expected !== 'pass' && expected !== 'fail')
        ) {
          throw new Error(
            'judge-corpus add-log wants <file> --question --expected pass|fail'
          )
        }
        print({
          added: addToCorpus(store, [
            logItem(readFileSync(file, 'utf8'), expected, values.question)
          ])
        })
        return 0
      }
      throw new Error('judge-corpus wants add or add-log')
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
      process.exit(error instanceof BlockedError ? 2 : 3)
    })
}
