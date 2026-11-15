import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { PNG } from 'pngjs'

import {
  attachStack,
  checkStackId,
  listStacks,
  readStack,
  refuseAttachedForFaults,
  removeStack,
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
import { buildScorecard } from './scorecard'
import { selectScenarios } from './select'
import { loadSettings, type LocalSettings, readSecret } from './settings'
import type { StackHandle } from './spec'
import { type RunningStack, startStack } from './stack'
import { trackedFiles, validate } from './validate'
import { openWebSession } from './web'

/** `--retries`: a whole number, 0 or more. */
function retryCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`--retries wants a whole number, 0 or more, not ${value}`)
  }
  return Number(value)
}

/** Whether a process's command line is `stack serve` for exactly `id`. */
export function servesStack(command: string, id: string): boolean {
  // An id is a-z, 0-9 and - (`checkStackId`), so it needs no escaping.
  return new RegExp(`\\bstack serve\\b.*--id ${id}(\\s|$)`).test(command.trim())
}

/**
 * Stops the `stack serve` for `id`, if that is still what `pid` is: after a
 * crash or a reboot the number can be gone, or another process's.
 */
function stopServe(pid: number, id: string): boolean {
  if (!isServing(pid, id)) return false
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

/** Whether `pid` is still the `stack serve` for `id`. */
function isServing(pid: number, id: string): boolean {
  const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8'
  }).stdout
  return servesStack(command, id)
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
  ledger: { type: 'string' },
  lan: { type: 'boolean' },
  native: { type: 'boolean' },
  id: { type: 'string' },
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
        mkdirSync(STACKS, { recursive: true, mode: 0o700 })
        const id = checkStackId(
          values.id ?? Math.random().toString(36).slice(2, 10)
        )
        const file = join(STACKS, `${id}.json`)
        // An entry is a stack only while its serve runs: one whose serve was
        // killed, or lost to a reboot, is forgotten, not taken for this one.
        if (existsSync(file)) {
          const old = readStack(STACKS, id)
          if (old.handle != null) {
            throw new HarnessError(
              `Stack "${id}" is attached; stack down it first`
            )
          }
          if (old.pid != null && isServing(old.pid, id)) {
            throw new HarnessError(`Stack "${id}" is already up`)
          }
          rmSync(file, { force: true })
        }
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
        // The server's stderr, so a stack that did not start says why.
        const log = join(STACKS, `${id}.log`)
        const err = openSync(log, 'w')
        const child = spawn(process.execPath, args, {
          cwd: ROOT,
          detached: true,
          stdio: ['ignore', 'ignore', err]
        })
        closeSync(err)
        let exited: string | undefined
        child.once('exit', (code, signal) => {
          exited = signal ?? String(code)
        })
        child.once('error', error => {
          exited = error.message
        })
        child.unref()
        const end = Date.now() + 300000
        const why = (): string => readFileSync(log, 'utf8').trim().slice(-2000)
        // Its own entry: the one this child writes once its stack is up.
        const started = (): boolean =>
          existsSync(file) && readStack(STACKS, id).pid === child.pid
        while (!started()) {
          if (exited != null) {
            throw new Error(`The stack exited (${exited}): ${why()}`)
          }
          if (Date.now() > end) {
            // Left running, it would go on to make a database, an API and a
            // Metro that nothing will stop.
            if (child.pid != null) process.kill(child.pid, 'SIGTERM')
            throw new Error(`The stack did not start in 5 minutes: ${why()}`)
          }
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        print(stackState(id))
        return 0
      }
      if (subcommand === 'serve') {
        const id = checkStackId(
          values.id ?? Math.random().toString(36).slice(2, 10)
        )
        const errorLog = join(STACKS, `${id}.errors.jsonl`)
        // Ctrl-C, a closed terminal and a crash take the stack down too, so
        // its database, directory and Metro do not outlive it. One that
        // arrives while the stack is starting (`stack up` giving up on it)
        // abandons the start, which stops whatever had started.
        const abandon = new AbortController()
        const ended = new Promise<unknown>(resolve => {
          const end = (failure?: unknown): void => {
            abandon.abort()
            resolve(failure)
          }
          for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
            process.once(signal, () => {
              end()
            })
          }
          process.once('uncaughtException', end)
          process.once('unhandledRejection', end)
        })
        const asError = (failure: unknown): Error =>
          failure instanceof Error
            ? failure
            : new Error(`stack serve failed: ${JSON.stringify(failure)}`)
        let stack: RunningStack
        try {
          stack = await startStack({
            id,
            lan: values.lan,
            native: values.native,
            services: values.services ?? ['web', 'api'],
            mailbox: settings.mailbox,
            errorLog,
            signal: abandon.signal
          })
        } catch (error) {
          if (!abandon.signal.aborted) throw error
          const failure = await ended
          if (failure != null) throw asError(failure)
          return 0
        }
        const entry: StackEntry = {
          id: stack.id,
          origin: stack.origin,
          webDir: stack.webDir,
          pid: process.pid,
          dir: stack.dir,
          root: ROOT,
          baselineManifest: stack.baselineManifest,
          errorLog
        }
        writeStackEntry(
          STACKS,
          join(STACKS, `${stack.id}.json`),
          JSON.stringify(entry)
        )
        const failure = await ended
        await stack.stop()
        rmSync(join(STACKS, `${stack.id}.json`), { force: true })
        if (failure != null) throw asError(failure)
        rmSync(errorLog, { force: true })
        return 0
      }
      if (subcommand === 'down') {
        const id = positionals[2]
        if (id == null) throw new Error('stack down wants <id>')
        print(removeStack(STACKS, id, pid => stopServe(pid, id)))
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
      throw new Error('stack wants up, down, serve, attach or list')
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
          'detect wants <scenario-id> --fault <fault> --surface <s>'
        )
      }
      // A fault runs on a stack of its own, never one named here.
      if (values.stack != null) {
        refuseAttachedForFaults(stackState(values.stack))
        throw new HarnessError(
          'detect runs on its own isolated stack; leave out --stack'
        )
      }
      const outcome = await detectFault(
        {
          id,
          surface: values.surface,
          fault: values.fault,
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
