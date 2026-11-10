import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { PNG } from 'pngjs'

import { redact } from '../../scripts/deploy/redact'
import type { Budget, Judge, JudgeInput } from './judge'

/**
 * Labelled screens and logs a judge is scored against. It lives in the private golden
 * store, because captures and logs can show mailbox addresses and device details.
 */
export type CorpusClass =
  | 'clean'
  | 'blank'
  | 'clipped'
  | 'shifted'
  | 'wrong-text'
  | 'error-dialog'
  | 'failed-log'
  | 'clean-log'

export interface CorpusItem {
  file: string
  class: CorpusClass
  /** What a correct judge answers. */
  expected: 'pass' | 'fail'
  question: string
}

export interface Corpus {
  items: CorpusItem[]
}

function corpusPath(store: string): string {
  return join(store, 'corpus', 'manifest.json')
}

export function readCorpus(store: string): Corpus {
  const path = corpusPath(store)
  if (!existsSync(path)) return { items: [] }
  return JSON.parse(readFileSync(path, 'utf8')) as Corpus
}

function fill(image: PNG, from: number, value: number): void {
  for (let at = from * 4; at < image.data.length; at += 4) {
    image.data[at] = value
    image.data[at + 1] = value
    image.data[at + 2] = value
    image.data[at + 3] = 255
  }
}

/** A solid frame: what a white screen of death looks like. */
export function blankCopy(png: Uint8Array): Buffer {
  const image = PNG.sync.read(Buffer.from(png))
  fill(image, 0, 255)
  return PNG.sync.write(image)
}

/** The bottom half gone, as a screen clipped by its container. */
export function clippedCopy(png: Uint8Array): Buffer {
  const image = PNG.sync.read(Buffer.from(png))
  fill(image, Math.floor(image.height / 2) * image.width, 0)
  return PNG.sync.write(image)
}

/** Everything moved down by a tenth of the screen, leaving a band of white. */
export function shiftedCopy(png: Uint8Array): Buffer {
  const image = PNG.sync.read(Buffer.from(png))
  const rows = Math.floor(image.height / 10)
  const stride = image.width * 4
  image.data.copyWithin(rows * stride, 0, (image.height - rows) * stride)
  image.data.fill(255, 0, rows * stride)
  return PNG.sync.write(image)
}

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface NewCorpusFile {
  bytes: Uint8Array | string
  extension: 'png' | 'txt'
  class: CorpusClass
  expected: 'pass' | 'fail'
  question: string
}

/** The five image classes one clean screen yields. The dialog is rendered by the caller. */
export function screenItems(
  png: Uint8Array,
  question: string,
  falseQuestion: string,
  errorDialog: Uint8Array
): NewCorpusFile[] {
  const image = (
    bytes: Uint8Array,
    cls: CorpusClass,
    expected: 'pass' | 'fail',
    asked = question
  ): NewCorpusFile => ({
    bytes,
    extension: 'png',
    class: cls,
    expected,
    question: asked
  })
  return [
    image(png, 'clean', 'pass'),
    image(blankCopy(png), 'blank', 'fail'),
    image(clippedCopy(png), 'clipped', 'fail'),
    image(shiftedCopy(png), 'shifted', 'fail'),
    image(png, 'wrong-text', 'fail', falseQuestion),
    image(errorDialog, 'error-dialog', 'fail')
  ]
}

/** A log leaves this machine only through the deploy tools' redaction. */
export function logItem(
  text: string,
  expected: 'pass' | 'fail',
  question: string
): NewCorpusFile {
  return {
    bytes: redact(text),
    extension: 'txt',
    class: expected === 'fail' ? 'failed-log' : 'clean-log',
    expected,
    question
  }
}

function git(store: string, args: string[]): void {
  const env = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) {
    env[name] = undefined
  }
  execFileSync('git', args, {
    cwd: store,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/** Adds items to the store and pushes them. An item it already holds is left alone. */
export function addToCorpus(store: string, files: NewCorpusFile[]): number {
  const corpus = readCorpus(store)
  let added = 0
  for (const file of files) {
    const hash = sha(file.bytes)
    const relative = `corpus/${hash.slice(0, 2)}/${hash}.${file.extension}`
    const known = corpus.items.some(
      item => item.file === relative && item.question === file.question
    )
    if (known) continue
    const path = join(store, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.bytes)
    corpus.items.push({
      file: relative,
      class: file.class,
      expected: file.expected,
      question: file.question
    })
    added++
  }
  if (added === 0) return 0
  writeFileSync(corpusPath(store), JSON.stringify(corpus, null, 2) + '\n')
  git(store, ['add', 'corpus'])
  git(store, ['commit', '-q', '-m', `Add ${added} items to the judge corpus`])
  git(store, ['push', '-q', 'origin', 'master'])
  return added
}

export interface ClassScore {
  total: number
  correct: number
  unsure: number
}

export interface JudgeScore {
  judge: string
  classes: Record<string, ClassScore>
  /** Defects called `fail`, over all defects. */
  recall: number
  /** Of everything called `fail`, how much was truly a defect. */
  precision: number
  /** Clean items called `fail`, over all clean items. */
  falseFailures: number
  costUsd: number
  latencyMs: number
  /** Items the budget ran out before reaching. */
  notScored: number
  passed: boolean
}

export const BAR = { recall: 0.95, falseFailures: 0.02 }

/**
 * Scores a judge. `unsure` is neither a catch nor a false failure, so a judge cannot
 * reach the recall bar by doubting everything. Running out of budget never passes.
 */
export async function scoreJudge(
  judge: Judge,
  corpus: Corpus,
  read: (item: CorpusItem) => JudgeInput,
  budget: Budget
): Promise<JudgeScore> {
  const classes: Record<string, ClassScore> = {}
  let defects = 0
  let caught = 0
  let clean = 0
  let falseFailures = 0
  let costUsd = 0
  let latencyMs = 0
  let notScored = 0
  for (const item of corpus.items) {
    const answer = await judge.ask(item.question, read(item), budget)
    if (answer == null) {
      notScored++
      continue
    }
    costUsd += answer.costUsd
    latencyMs += answer.latencyMs
    const row = (classes[item.class] ??= { total: 0, correct: 0, unsure: 0 })
    row.total++
    if (answer.verdict === 'unsure') row.unsure++
    if (answer.verdict === item.expected) row.correct++
    if (item.expected === 'fail') {
      defects++
      if (answer.verdict === 'fail') caught++
    } else {
      clean++
      if (answer.verdict === 'fail') falseFailures++
    }
  }
  const recall = defects === 0 ? 0 : caught / defects
  const falseRate = clean === 0 ? 1 : falseFailures / clean
  const called = caught + falseFailures
  return {
    judge: judge.id,
    classes,
    recall,
    precision: called === 0 ? 0 : caught / called,
    falseFailures: falseRate,
    costUsd,
    latencyMs,
    notScored,
    passed:
      notScored === 0 &&
      defects > 0 &&
      clean > 0 &&
      recall >= BAR.recall &&
      falseRate <= BAR.falseFailures
  }
}
