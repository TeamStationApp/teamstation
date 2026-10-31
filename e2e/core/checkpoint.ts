import { readFileSync } from 'node:fs'

import { goldenKey, readGoldenManifest } from './goldens'
import {
  checkInvariants,
  failedInvariants,
  type InvariantReport,
  type ServerError
} from './invariants'
import type { Budget, Judge, MismatchNote } from './judge'
import type { LocalSettings } from './settings'
import type { Surface } from './spec'
import { compareGolden, type GoldenOptions, type VisualVerdict } from './visual'

/** One thing that must be on the screen, by maestro-d selector. */
export interface ExpectItem {
  id?: string
  text?: string
  /** True when the element must not be on the screen. */
  absent?: boolean
  timeout?: number
}

export interface CheckpointSpec {
  expect?: ExpectItem[]
  /** Reads stored state back; throws when what was shown was not saved. */
  readBack?: () => Promise<void>
  golden?: GoldenOptions
  /** A plain-words statement about what no golden can pin, for the AI judge. */
  ask?: string
}

export type LayerVerdict = 'pass' | 'fail' | 'not-run'

/** What the judge said. Only a judge at the bar can fail a test. */
export interface AskRecord {
  question: string
  basis: 'INFERRED'
  verdict: 'pass' | 'fail' | 'needs-review'
  detail: string
  model?: string
  costUsd: number
}

/** What one checkpoint found. Measured layers say so; AI's judgement never does. */
export interface CheckpointRecord {
  id: string
  basis: 'MEASURED'
  invariants?: InvariantReport
  expect: LayerVerdict
  readBack: LayerVerdict
  visual?: VisualVerdict
  /** Advisory only: never changes the visual verdict. */
  annotation?: MismatchNote
  ask?: AskRecord
  failure?: string
}

/** The judge a run may use. Absent when no key is configured. */
export interface JudgeRuntime {
  judge: Judge | undefined
  budget: Budget
  authoritative: boolean
}

/** The device a checkpoint looks at, with what its checks need to know about it. */
export interface CheckpointTarget {
  device: any
  deviceClass: string
  appId?: string
  consoleSeen: number
}

export interface CheckpointEnvironment {
  scenarioId: string
  surface: Surface
  runDir: string
  root: string
  settings: LocalSettings
  serverErrors: () => Promise<ServerError[] | undefined>
  alone: boolean
  worldIds: () => string[]
  judges?: JudgeRuntime
}

export class Checkpoints {
  readonly records: CheckpointRecord[] = []
  readonly unattributed: ServerError[] = []

  constructor(private readonly env: CheckpointEnvironment) {}

  /** Starts a fresh attempt: a retry's verdicts replace the last one's. */
  reset(): void {
    this.records.length = 0
    this.unattributed.length = 0
  }

  /**
   * Runs the layers in order. Invariants, `expect` and read-back throw, because the
   * screens after them mean nothing. A golden mismatch is recorded and the scenario
   * goes on, so one run shows every screen that moved.
   */
  async check(
    id: string,
    spec: CheckpointSpec,
    target: CheckpointTarget
  ): Promise<void> {
    const { env } = this
    const record: CheckpointRecord = {
      id,
      basis: 'MEASURED',
      expect: 'not-run',
      readBack: 'not-run'
    }
    this.records.push(record)
    const fail = (message: string): Error => {
      record.failure = message
      return new Error(`Checkpoint "${id}": ${message}`)
    }

    const outcome = await checkInvariants({
      surface: env.surface,
      appId: target.appId,
      device: target.device,
      serverErrors: env.serverErrors,
      alone: env.alone,
      worldIds: env.worldIds(),
      consoleSeen: target.consoleSeen
    })
    target.consoleSeen = outcome.consoleSeen
    record.invariants = outcome.report
    for (const error of outcome.unattributed) {
      if (!this.unattributed.includes(error)) this.unattributed.push(error)
    }
    const broken = failedInvariants(outcome.report)
    if (broken.length > 0) throw fail(broken.join('; '))

    try {
      for (const item of spec.expect ?? []) {
        const { absent, ...selector } = item
        if (absent === true) await target.device.assertNotVisible(selector)
        else await target.device.assertVisible(selector)
      }
      if (spec.expect != null) record.expect = 'pass'
    } catch (error) {
      record.expect = 'fail'
      throw fail(error instanceof Error ? error.message : String(error))
    }

    if (spec.readBack != null) {
      try {
        await spec.readBack()
        record.readBack = 'pass'
      } catch (error) {
        record.readBack = 'fail'
        throw fail(error instanceof Error ? error.message : String(error))
      }
    }

    if (spec.golden != null) {
      record.visual = await compareGolden({
        device: target.device,
        runDir: env.runDir,
        checkpoint: id,
        key: goldenKey(env.scenarioId, id, env.surface, target.deviceClass),
        golden: spec.golden,
        manifest: readGoldenManifest(env.root),
        store: env.settings.goldenStore
      })
      if (record.visual.verdict === 'fail') {
        record.failure = record.visual.detail ?? 'the screen moved'
        await this.annotate(record)
      }
    }

    if (spec.ask != null) {
      record.ask = await this.askJudge(spec.ask, outcome.frame)
      if (record.ask.verdict === 'fail') {
        record.failure ??= record.ask.detail
      }
    }
  }

  /** What a mismatch looks like, for the reader. It cannot change the verdict. */
  private async annotate(record: CheckpointRecord): Promise<void> {
    const runtime = this.env.judges
    const diffPath = record.visual?.diffPath
    if (runtime?.judge == null || diffPath == null) return
    try {
      record.annotation = await runtime.judge.annotate(
        readFileSync(diffPath),
        runtime.budget
      )
    } catch (error) {
      console.error(`No annotation: ${String(error)}`)
    }
  }

  private async askJudge(
    question: string,
    frame: Uint8Array
  ): Promise<AskRecord> {
    const runtime = this.env.judges
    const review = (detail: string): AskRecord => ({
      question,
      basis: 'INFERRED',
      verdict: 'needs-review',
      detail,
      costUsd: 0
    })
    if (runtime?.judge == null) return review('no judge is configured')
    let answer
    try {
      answer = await runtime.judge.ask(
        question,
        { kind: 'image', png: frame },
        runtime.budget
      )
    } catch (error) {
      return review(`the judge failed: ${String(error)}`)
    }
    if (answer == null) return review('the AI budget is spent')
    const made = {
      question,
      basis: 'INFERRED' as const,
      detail: answer.observed,
      model: answer.model,
      costUsd: answer.costUsd
    }
    if (answer.verdict === 'unsure') {
      return { ...made, verdict: 'needs-review' }
    }
    if (answer.verdict === 'fail' && !runtime.authoritative) {
      return {
        ...made,
        verdict: 'needs-review',
        detail: `${answer.observed} (this judge has not reached the bar)`
      }
    }
    return { ...made, verdict: answer.verdict }
  }
}

/** A run's status from its checkpoints, once its scenario finished without throwing. */
export function statusFromCheckpoints(records: CheckpointRecord[]): {
  status: 'passed' | 'failed' | 'unbaselined' | 'needs-review'
  reason?: string
} {
  const moved = records.filter(
    row => row.visual?.verdict === 'fail' || row.ask?.verdict === 'fail'
  )
  if (moved.length > 0) {
    return {
      status: 'failed',
      reason: moved
        .map(
          row => `Checkpoint "${row.id}": ${row.failure ?? 'golden mismatch'}`
        )
        .join('; ')
    }
  }
  const unsure = records.filter(row => row.ask?.verdict === 'needs-review')
  if (unsure.length > 0) {
    return {
      status: 'needs-review',
      reason: unsure
        .map(row => `Checkpoint "${row.id}": ${row.ask?.detail ?? ''}`)
        .join('; ')
    }
  }
  const missing = records.filter(row => row.visual?.verdict === 'unbaselined')
  if (missing.length > 0) {
    return {
      status: 'unbaselined',
      reason: `No golden for ${missing.map(row => row.id).join(', ')}`
    }
  }
  return { status: 'passed' }
}
