import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { PNG } from 'pngjs'

import {
  addToCorpus,
  type CorpusItem,
  logItem,
  readCorpus,
  scoreJudge,
  screenItems
} from './corpus'
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
import { buildManifest, readManifest, ROOT, writeManifest } from './manifest'
import { type PlanResource, planScenarios } from './plan'
import { prepareApp } from './prepare'
import { BlockedError } from './result'
import { runScenario } from './run'
import { buildScorecard } from './scorecard'
import { selectScenarios } from './select'
import { loadSettings, type LocalSettings, readSecret } from './settings'
import type { StackHandle } from './spec'
import { startStack } from './stack'
import { trackedFiles, validate } from './validate'
import { openWebSession } from './web'

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
          adopt: async origin => origin,
          serverErrors: async () => undefined
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
        concurrent: values.concurrent,
        budgetUsd:
          values['budget-usd'] == null
            ? settings.judgeBudgetUsd
            : Number(values['budget-usd']),
        settings
      })
      print({ ...outcome.result, runDir: outcome.runDir })
      return outcome.exitCode
    }

    case 'detect': {
      const id = subcommand
      if (id == null || values.surface == null || values.fault == null) {
        throw new Error(
          'detect wants <scenario-id> --fault <fault> --surface <s>'
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
