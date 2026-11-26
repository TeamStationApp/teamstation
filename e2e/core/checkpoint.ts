import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { goldenKey, readGoldenManifest } from './goldens'
import {
  checkInvariants,
  failedInvariants,
  type InvariantReport,
  type ServerError
} from './invariants'
import type { Budget, Judge, MismatchNote } from './judge'
import { HarnessError } from './result'
import type { LocalSettings } from './settings'
import type { Surface } from './spec'
import {
  compareGolden,
  compareGoldenInDir,
  type GoldenOptions,
  type VisualVerdict
} from './visual'

/**
 * maestro-d's browser driver reports an element's bounds, which a mask needs, only for
 * a selector with a state filter. Without one every mask there fails as not found.
 */
export function goldenOn(
  surface: Surface,
  golden: GoldenOptions
): GoldenOptions {
  if (surface !== 'web-chromium' || golden.mask == null) return golden
  return {
    ...golden,
    mask: golden.mask.map(selector => ({ enabled: true, ...selector }))
  }
}

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
  /**
   * How the screen is judged: against its golden, or by maestro-d's
   * `assertWithAI` on `prompt`. Without it, a checkpoint naming `golden`
   * compares it and one that does not compares nothing.
   */
  compare?: 'golden' | 'ai'
  /** For `compare: 'ai'`: a plain-words statement that must be true of the screen. */
  prompt?: string
}

/** What maestro-d's `assertWithAI` answers, in its step's `data`. */
export interface AiCheckResult {
  verdict: 'pass' | 'fail' | 'unsure'
  confidence: number
  model: string
  escalations: unknown[]
  observed: string
  costUsd: number
}

/** What a harness run's AI checks may spend, and whether a `fail` may fail it. */
export interface AiRuntime {
  budget: Budget
  /** The waterfall has reached the bar (`judgeHasAuthority(root, 'waterfall')`). */
  authoritative: boolean
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
  /** The whole answer of a `compare: 'ai'` check, beside its verdict in `ask`. */
  ai?: AiCheckResult
  failure?: string
}

/** The judge a run may use. Absent when no key is configured. */
export interface JudgeRuntime {
  judge: Judge | undefined
  budget: Budget
  authoritative: boolean
}

/**
 * The indices, among a CSS selector's matches, of those drawn on the page,
 * as maestro-d must find each to mask it: with a size, inside the window,
 * visible, laid out (maestro-d's own rule turns down an element whose
 * offsetParent is null), and not in a scene kept behind the shown one, which
 * keeps its size and styles: `StackNavigator`'s SceneFrame names each
 * scene's role, and only the top or incoming one is shown. Neither a hit test
 * nor aria-hidden would do: an ActionRow draws its emblem with no pointer
 * events, and an open menu hides the whole page from assistive technology. maestro-d's page helper is not asked: a
 * reload clears it until its next lookup.
 */
async function drawnMatches(device: any, css: string): Promise<number[]> {
  const result = (await device.evalBrowserScript({
    script: `return JSON.stringify([...document.querySelectorAll(${JSON.stringify(css)})].map((n, i) => { const r = n.getBoundingClientRect(); const style = getComputedStyle(n); const laidOut = n.offsetParent !== null || style.position === 'fixed' || style.position === 'sticky'; const shown = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && laidOut && (typeof n.checkVisibility !== 'function' || n.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })); const scene = n.closest('[data-scene-role]'); const onTop = scene === null || ['top', 'incoming'].includes(String(scene.getAttribute('data-scene-role'))); return shown && onTop ? i : -1 }).filter(i => i >= 0))`
  })) as { data?: unknown }
  return typeof result.data === 'string'
    ? (JSON.parse(result.data) as number[])
    : []
}

/** The device a checkpoint looks at, with what its checks need to know about it. */
export interface CheckpointTarget {
  device: any
  deviceClass: string
  appId?: string
  udid?: string
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
  /** Under `runScenario`: what `compare: 'ai'` checkpoints may spend. */
  ai?: AiRuntime
  /**
   * Under `runScenario`: the goldens the runner fetched, as
   * `<goldensDir>/<goldenKey>.png`, in place of the golden store.
   */
  goldensDir?: string
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
    // Each check reads the log afresh, so the same request comes back as a new
    // object: it is the same error when it names the same request.
    const same = (a: ServerError, b: ServerError): boolean =>
      a.at === b.at &&
      a.method === b.method &&
      a.path === b.path &&
      a.status === b.status
    for (const error of outcome.unattributed) {
      if (!this.unattributed.some(seen => same(seen, error)))
        this.unattributed.push(error)
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

    const comparesGolden =
      spec.compare === 'golden' || (spec.compare == null && spec.golden != null)
    if (comparesGolden && env.goldensDir != null) {
      record.visual = await compareGoldenInDir({
        device: target.device,
        runDir: env.runDir,
        key: goldenKey(env.scenarioId, id, env.surface, target.deviceClass),
        golden: goldenOn(env.surface, spec.golden ?? {}),
        goldensDir: env.goldensDir,
        ...(typeof target.device.evalBrowserScript === 'function'
          ? {
              drawn: async (css: string) =>
                await drawnMatches(target.device, css)
            }
          : {})
      })
      if (record.visual.verdict === 'fail') {
        record.failure = record.visual.detail ?? 'the screen moved'
      }
    } else if (comparesGolden) {
      record.visual = await compareGolden({
        device: target.device,
        runDir: env.runDir,
        checkpoint: id,
        key: goldenKey(env.scenarioId, id, env.surface, target.deviceClass),
        golden: goldenOn(env.surface, spec.golden ?? {}),
        manifest: readGoldenManifest(env.root),
        store: env.settings.goldenStore,
        ...(typeof target.device.evalBrowserScript === 'function'
          ? {
              drawn: async (css: string) =>
                await drawnMatches(target.device, css)
            }
          : {})
      })
      if (record.visual.verdict === 'fail') {
        record.failure = record.visual.detail ?? 'the screen moved'
        await this.annotate(record)
      }
    }

    if (spec.compare === 'ai') {
      record.ask = await this.askWaterfall(id, spec.prompt, target, record)
      if (record.ask.verdict === 'fail') {
        record.failure ??= record.ask.detail
      }
      if (record.ask.verdict === 'needs-review' && record.visual == null) {
        const captures = join(env.runDir, 'captures')
        mkdirSync(captures, { recursive: true })
        writeFileSync(join(captures, `${id}.png`), outcome.frame)
      }
    }

    if (spec.ask != null) {
      record.ask = await this.askJudge(spec.ask, outcome.frame)
      if (record.ask.verdict === 'fail') {
        record.failure ??= record.ask.detail
      }
      // Whoever reviews this needs the screen the judge could not settle.
      if (record.ask.verdict === 'needs-review' && record.visual == null) {
        const captures = join(env.runDir, 'captures')
        mkdirSync(captures, { recursive: true })
        writeFileSync(join(captures, `${id}.png`), outcome.frame)
      }
    }
  }

  /**
   * maestro-d's AI check on the screen, with what is left of the run's
   * budget. Every verdict comes back as an answer; only a failure to ask is
   * thrown. A `fail` fails the run only once the waterfall reached the bar.
   */
  private async askWaterfall(
    id: string,
    prompt: string | undefined,
    target: CheckpointTarget,
    record: CheckpointRecord
  ): Promise<AskRecord> {
    if (prompt == null || prompt.trim() === '') {
      throw new HarnessError(`Checkpoint "${id}": compare: 'ai' needs a prompt`)
    }
    const runtime = this.env.ai
    const made = (
      verdict: AskRecord['verdict'],
      detail: string,
      extra: Partial<AskRecord> = {}
    ): AskRecord => ({
      question: prompt,
      basis: 'INFERRED',
      verdict,
      detail,
      costUsd: 0,
      ...extra
    })
    if (runtime == null) return made('needs-review', 'no AI checks in this run')
    if (typeof target.device.assertWithAI !== 'function') {
      throw new HarnessError(
        `Checkpoint "${id}": the device's maestro-d has no assertWithAI`
      )
    }
    const remaining = Math.max(
      0,
      runtime.budget.limitUsd - runtime.budget.spentUsd
    )
    let reply: unknown
    try {
      reply = await target.device.assertWithAI({
        assertion: prompt,
        budgetUsd: remaining
      })
    } catch (error) {
      throw new HarnessError(
        `Checkpoint "${id}": assertWithAI: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const result = aiResultOf(reply)
    if (result == null) {
      throw new HarnessError(
        `Checkpoint "${id}": assertWithAI answered no verdict`
      )
    }
    runtime.budget.add(result.costUsd)
    record.ai = result
    const extra = {
      ...(result.model === '' ? {} : { model: result.model }),
      costUsd: result.costUsd
    }
    if (result.verdict === 'pass') return made('pass', result.observed, extra)
    if (result.verdict === 'fail' && runtime.authoritative) {
      return made('fail', result.observed, extra)
    }
    if (result.verdict === 'fail') {
      return made(
        'needs-review',
        `${result.observed} (the AI checks have not reached the bar)`,
        extra
      )
    }
    return made('needs-review', result.observed, extra)
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

/** The check's answer, from the step result the client resolves with or the bare answer. */
export function aiResultOf(reply: unknown): AiCheckResult | undefined {
  const value = reply as { data?: unknown; verdict?: unknown } | undefined
  const result = (value?.verdict == null ? value?.data : value) as
    Partial<AiCheckResult> | undefined
  if (
    result?.verdict !== 'pass' &&
    result?.verdict !== 'fail' &&
    result?.verdict !== 'unsure'
  ) {
    return undefined
  }
  return {
    verdict: result.verdict,
    confidence: Number(result.confidence ?? 0),
    model: String(result.model ?? ''),
    escalations: Array.isArray(result.escalations) ? result.escalations : [],
    observed: String(result.observed ?? ''),
    costUsd: Number(result.costUsd ?? 0)
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
