import {
  analyseFrames,
  FRAME_DRAIN_SCRIPT,
  type FrameAnalysis,
  frameLogScript,
  parseFrames,
  type PresentedFrame,
  SETTLE_MS
} from './chromeFrames'
import {
  judgeMemory,
  type ProcessVerdict,
  samplerGaps,
  type SamplerOutcome
} from './soakMemory'
import type { MemorySample } from './soakRecords'
import { TILE_NOTICE } from './surfaces/surface'
import {
  type Look,
  medianMs,
  overall,
  spreadMs,
  type StepRecord,
  type Verdict,
  waitFor,
  type Watcher,
  type WatcherRole
} from './targeted'
import type { TargetedScenario } from './targetedScenarios'

/**
 * The basic streaming soak: four synthetic cameras publish steadily, with no
 * cuts and no network shaping, and one iOS app, one Android app, Chrome and
 * TeamStation TV watch the live multi-angle view while each is scrubbed on a
 * schedule. Every
 * look asks whether every angle is moving and how far apart their burned-in
 * clocks are; every scrub asks whether every angle plays again within 10 s
 * and lines up within a second; memory is sampled per process throughout.
 */

const MIN = 60_000
export const BASIC_ANGLES = ['SynthA', 'SynthB', 'SynthC', 'SynthD']
export const BASIC_ACTIONS = [
  'scrubLeft',
  'scrubRight',
  'rapidScrub',
  'jumpToPresent'
] as const
export type BasicAction = (typeof BASIC_ACTIONS)[number]

/** Angles within this of each other are aligned. */
export const ALIGNED_MS = 1000
/** A scrub recovers when every angle moves again within this. */
export const RECOVERY_MS = 10_000

export interface BasicOptions {
  minutes: number
  /** How often each watcher is scrubbed. */
  actionEveryMs?: number
  /** How often each watcher is looked at between scrubs. */
  lookEveryMs?: number
  /** Where a random scrub lands, for a repeatable run. */
  random?: () => number
  /** The watchers, of BASIC_WATCHERS; all of them unless a run leaves some out. */
  watchers?: WatcherRole[]
}

export const BASIC_WATCHERS: WatcherRole[] = [
  'iphone',
  'android',
  'chrome',
  'tv',
  'safari'
]

/**
 * Watchers that are only looked at, never scrubbed: Safari watches one angle
 * in the game page's own player, which has no full-screen transport.
 */
const WATCH_ONLY = new Set<WatcherRole>(['safari'])

/**
 * `BASIC_WATCHERS` in the environment: a comma list of the watchers a run
 * uses, for a bench missing one (the TV without its display), or none to
 * use them all.
 */
export function watchersFromEnv(
  env: Record<string, string | undefined>
): WatcherRole[] | undefined {
  const asked = env.BASIC_WATCHERS?.split(',')
    .map(role => role.trim())
    .filter(role => role !== '')
  if (asked == null || asked.length === 0) return undefined
  for (const role of asked) {
    if (!BASIC_WATCHERS.includes(role as WatcherRole))
      throw new Error(`BASIC_WATCHERS: no watcher "${role}"`)
  }
  return BASIC_WATCHERS.filter(role => asked.includes(role))
}

/** One scheduled scrub. */
export interface PlannedAction {
  atMs: number
  watcher: number
  action: BasicAction
}

/**
 * The scrubs: each watcher every `everyMs`, staggered so no two act at once,
 * cycling through the four kinds from a different one each.
 */
export function planActions(
  startMs: number,
  endMs: number,
  watchers: number,
  everyMs: number
): PlannedAction[] {
  const out: PlannedAction[] = []
  const stagger = everyMs / Math.max(1, watchers)
  for (let watcher = 0; watcher < watchers; watcher++) {
    for (let k = 0; ; k++) {
      const atMs = startMs + MIN + watcher * stagger + k * everyMs
      if (atMs > endMs - MIN) break
      out.push({
        atMs,
        watcher,
        action: BASIC_ACTIONS[(watcher + k) % BASIC_ACTIONS.length]
      })
    }
  }
  return out.sort((a, b) => a.atMs - b.atMs)
}

/**
 * Whether every angle plays: failed with no player, an angle under a notice
 * or an angle standing still; passed with every angle moving; blocked when
 * motion cannot be told (the TV without its picture).
 */
export function playState(look: Look): Verdict {
  if (look.tiles == null || look.tiles.length === 0) return 'failed'
  if (look.tiles.some(t => t.notice != null && TILE_NOTICE.test(t.notice)))
    return 'failed'
  if (look.tiles.some(t => t.advancing === false)) return 'failed'
  return look.tiles.every(t => t.advancing === true) ? 'passed' : 'blocked'
}

function spreadOf(look: Look): number | null {
  return spreadMs(
    (look.tiles ?? [])
      .map(tile => tile.wallMs)
      .filter((at): at is number => at != null)
  )
}

function describe(look: Look): string {
  if (look.tiles == null) return `no tiles (${look.reason ?? 'no answer'})`
  if (look.tiles.length === 0) return 'no angles on screen'
  const spread = spreadOf(look)
  return `${look.tiles
    .map(
      t =>
        `${t.angle} ${t.advancing === true ? 'moving' : t.advancing === false ? 'still' : '?'}${t.notice == null ? '' : ` "${t.notice}"`}`
    )
    .join(', ')}${spread == null ? '' : `; spread ${spread} ms`}`
}

async function act(
  watcher: Watcher,
  action: BasicAction,
  random: () => number
): Promise<string> {
  const surface = watcher.surface
  if (action === 'scrubLeft') {
    const fraction = 0.2 + random() * 0.6
    await surface.scrub(fraction)
    return `scrub to ${fraction.toFixed(2)}`
  }
  if (action === 'scrubRight') {
    await surface.scrub(1)
    return 'scrub to the live edge'
  }
  if (action === 'rapidScrub') {
    const fractions = Array.from({ length: 5 }, () => 0.1 + random() * 0.85)
    await surface.rapidScrub(fractions, 1000)
    return `rapid scrub ${fractions.map(f => f.toFixed(2)).join(' ')}`
  }
  await surface.jumpToPresent()
  return 'Jump to present'
}

/** The 30-minute windows the memory verdicts use: after joining, and the end. */
export function basicWindows(minutes: number): {
  baseline: [number, number]
  final: [number, number]
  slope: [number, number]
} {
  const end = minutes * MIN
  return {
    baseline: [3 * MIN, 6 * MIN],
    final: [Math.max(6 * MIN, end - 5 * MIN), end + MIN],
    slope: [3 * MIN, end + MIN]
  }
}

export function basicScrub(options: BasicOptions): TargetedScenario {
  const random = options.random ?? Math.random
  return {
    setup: {
      synthetic: BASIC_ANGLES,
      watchers: options.watchers ?? BASIC_WATCHERS,
      safariAngle: BASIC_ANGLES[0],
      leadMs: MIN,
      memory: true
    },
    run: async session => {
      const startMs = session.now()
      const endMs = startMs + options.minutes * MIN
      const lookEvery = options.lookEveryMs ?? 30_000
      const scrubbed = session.watchers.filter(w => !WATCH_ONLY.has(w.role))
      const actions = planActions(
        startMs,
        endMs,
        scrubbed.length,
        options.actionEveryMs ?? 2 * MIN
      )
      const samples: MemorySample[] = []
      const samplers = session.memory ?? []
      // Each sampler's samples and errors, so one that gave nothing is judged blocked.
      const outcomes = new Map<(typeof samplers)[number], SamplerOutcome>(
        samplers.map(sampler => [
          sampler,
          {
            name: sampler.name,
            ...(sampler.informational === true ? { informational: true } : {}),
            samples: 0,
            errors: []
          }
        ])
      )
      const gather = async (
        sampler: (typeof samplers)[number],
        what: string,
        take: () => Promise<MemorySample[] | undefined>
      ): Promise<void> => {
        const outcome = outcomes.get(sampler)!
        try {
          const rows = (await take()) ?? []
          outcome.samples += rows.length
          samples.push(...rows)
        } catch (error) {
          outcome.errors.push(`${what}: ${(error as Error).message}`)
        }
      }
      for (const sampler of samplers) {
        await gather(sampler, 'start', async () => {
          await sampler.start?.()
          return []
        })
      }
      // Chrome logs every frame it presents, with the clock each one shows.
      const chrome = session.watchers.find(w => w.evaluate != null)
      const frames: PresentedFrame[] = []
      const quiet: Array<[number, number]> = []
      // The logger is put in again before each drain: a rejoin that loads
      // the page afresh loses it, and what it missed shows as a stall.
      const drain = async (): Promise<void> => {
        if (chrome?.evaluate == null) return
        try {
          frames.push(...parseFrames(await chrome.evaluate(FRAME_DRAIN_SCRIPT)))
          await chrome.evaluate(frameLogScript())
        } catch {
          // A drain that fails loses nothing: the page keeps the frames for the next.
        }
      }
      if (chrome?.evaluate != null) {
        await chrome.evaluate(frameLogScript()).catch(() => undefined)
      }
      const nextLook = new Map(session.watchers.map(w => [w, startMs]))
      let nextSample = startMs
      while (session.now() < endMs) {
        const due = actions[0]
        if (due != null && due.atMs <= session.now()) {
          actions.shift()
          const watcher = scrubbed[due.watcher]
          let did: string
          try {
            did = await act(watcher, due.action, random)
          } catch (error) {
            // A control the driver could not find may be missing or merely
            // unfound, so the scrub's recovery is blocked, not failed; under
            // the recovery's own name, a watcher none of whose scrubs could be
            // done is blocked rather than passed on its looks.
            await session.record.step(
              watcher,
              `recover-${due.action}`,
              `after a ${due.action} every angle moves again within ${RECOVERY_MS / 1000} s`,
              `the ${due.action} could not be done: ${(error as Error).message}`,
              'blocked'
            )
            continue
          }
          const actedAt = session.now()
          quiet.push([actedAt - 2000, actedAt + SETTLE_MS])
          const back = await waitFor(
            async () => {
              const look = await session.look(watcher)
              return { ok: playState(look) !== 'failed', value: look }
            },
            {
              timeoutMs: RECOVERY_MS,
              everyMs: 2000,
              sleep: session.sleep,
              now: session.now
            }
          )
          const tookMs = session.now() - actedAt
          const recovered = playState(back.value)
          await session.record.step(
            watcher,
            `recover-${due.action}`,
            `after a ${due.action} every angle moves again within ${RECOVERY_MS / 1000} s`,
            `${did}; ${recovered === 'passed' ? `moving after ${Math.round(tookMs / 100) / 10} s` : recovered === 'blocked' ? 'motion unknown' : 'not all moving'}: ${describe(back.value)}`,
            recovered
          )
          if (recovered === 'passed') {
            const spread = spreadOf(back.value)
            if (spread != null) {
              await session.record.check(
                watcher,
                `aligned-after-${due.action}`,
                `after a ${due.action} the angles are within ${ALIGNED_MS} ms of each other`,
                describe(back.value),
                spread <= ALIGNED_MS
              )
            }
          }
          nextLook.set(watcher, session.now() + lookEvery)
          continue
        }
        for (const watcher of session.watchers) {
          if (nextLook.get(watcher)! > session.now()) continue
          nextLook.set(watcher, session.now() + lookEvery)
          if (watcher === chrome) await drain()
          const look = await session.look(watcher)
          await session.record.step(
            watcher,
            'playing',
            'every angle is moving',
            describe(look),
            playState(look)
          )
          const spread = spreadOf(look)
          if (spread != null) {
            await session.record.check(
              watcher,
              'aligned',
              `the angles are within ${ALIGNED_MS} ms of each other`,
              describe(look),
              spread <= ALIGNED_MS
            )
          }
        }
        if (session.now() >= nextSample) {
          nextSample = session.now() + MIN
          for (const sampler of samplers) {
            await gather(
              sampler,
              'sample',
              async () => await sampler.sample?.(session.now())
            )
          }
        }
        await session.sleep(1000)
      }
      for (const sampler of samplers) {
        await gather(sampler, 'stop', async () => await sampler.stop?.())
      }
      await drain()
      const analysis =
        chrome == null
          ? null
          : analyseFrames(frames, quiet, {
              startMs,
              endMs: session.now(),
              expected: BASIC_ANGLES,
              clockBase: session.clockBase
            })
      if (analysis != null && chrome != null) {
        for (const angle of analysis.angles) {
          await session.record.check(
            chrome,
            `frames-${angle.angle}`,
            'no stretch of a second or more without a new frame, or with a frozen picture, away from a scrub',
            `${angle.frames} frames, ${Math.round(angle.readable * 100)} % readable, ${angle.stalls} stalls, ${angle.frozen} frozen, longest ${(angle.longestMs / 1000).toFixed(1)} s`,
            angle.stalls === 0 && angle.frozen === 0
          )
        }
        session.writeArtifact(
          'chrome-frames.jsonl',
          frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'
        )
      }
      const memory = [
        ...judgeMemory(samples, {
          runStartMs: startMs,
          windows: basicWindows(options.minutes)
        }),
        ...samplerGaps([...outcomes.values()])
      ]
      // The stack's memory is informational: it is in the report, never a step.
      for (const verdict of memory) {
        if (verdict.verdict === 'informational') continue
        await session.record.step(
          { role: verdict.device },
          `memory-${verdict.process}`,
          'memory grows no more than 15 % and under 30 MB/h (60 for a browser tab)',
          memoryLine(verdict),
          verdict.verdict
        )
      }
      session.writeArtifact(
        'basic-report.md',
        basicReport(session.record.steps, memory, options.minutes, analysis)
      )
    }
  }
}

function memoryLine(verdict: ProcessVerdict): string {
  const mb = (bytes?: number): string =>
    bytes == null ? '–' : `${(bytes / 1e6).toFixed(1)} MB`
  return `${verdict.verdict}: ${mb(verdict.baselineMedian)} → ${mb(verdict.finalMedian)}${verdict.growth == null ? '' : `, ${(verdict.growth * 100).toFixed(1)} %`}${verdict.slopeMBh == null ? '' : `, ${verdict.slopeMBh.toFixed(1)} MB/h`}${verdict.reason == null ? '' : ` (${verdict.reason})`}`
}

/** The run's report: per watcher, how often every angle played, recovered and lined up; then memory. */
export function basicReport(
  steps: StepRecord[],
  memory: ProcessVerdict[],
  minutes: number,
  frames: FrameAnalysis | null = null
): string {
  const surfaces = [...new Set(steps.map(step => step.surface))]
  const count = (surface: string, prefix: string): string => {
    const mine = steps.filter(
      s =>
        s.surface === surface &&
        s.step.startsWith(prefix) &&
        s.verdict !== 'blocked'
    )
    const passed = mine.filter(s => s.verdict === 'passed').length
    return mine.length === 0 ? '–' : `${passed}/${mine.length}`
  }
  const recoveries = (surface: string): string => {
    const times = steps
      .filter(
        s =>
          s.surface === surface &&
          s.step.startsWith('recover-') &&
          s.verdict === 'passed'
      )
      .map(s => Number(/moving after ([\d.]+) s/.exec(s.observed)?.[1]))
      .filter(n => Number.isFinite(n))
    const median = medianMs(times)
    return median == null ? '–' : `${median.toFixed(1)} s`
  }
  const lines = [
    `# Basic streaming soak (${minutes} minutes)`,
    '',
    `Verdict: **${overall(steps)}**`,
    '',
    '| Watcher | Every angle moving | Aligned within 1 s | Recovered after a scrub | Median recovery |',
    '| --- | --- | --- | --- | --- |',
    ...surfaces
      .filter(surface =>
        steps.some(s => s.surface === surface && s.step === 'playing')
      )
      .map(
        surface =>
          `| ${surface} | ${count(surface, 'playing')} | ${count(surface, 'aligned')} | ${count(surface, 'recover-')} | ${recoveries(surface)} |`
      ),
    '',
    ...(frames == null
      ? []
      : [
          '## Chrome, every presented frame',
          '',
          '| Angle | Frames | Clock read | Stalls | Frozen | Longest |',
          '| --- | --- | --- | --- | --- | --- |',
          ...frames.angles.map(
            a =>
              `| ${a.angle} | ${a.frames} | ${Math.round(a.readable * 100)} % | ${a.stalls} | ${a.frozen} | ${(a.longestMs / 1000).toFixed(1)} s |`
          ),
          '',
          `Spread between angles, per second away from scrubs: median ${medianMs(frames.spreads.map(s => s.spreadMs)) ?? '–'} ms, worst ${frames.spreads.length === 0 ? '–' : Math.max(...frames.spreads.map(s => s.spreadMs))} ms.`,
          '',
          ...frames.gaps
            .slice(0, 50)
            .map(
              g =>
                `- ${new Date(g.fromMs).toISOString().slice(11, 19)} ${g.angle} ${g.kind} for ${((g.toMs - g.fromMs) / 1000).toFixed(1)} s`
            ),
          ''
        ]),
    '## Memory',
    '',
    '| Device | Process | Verdict |',
    '| --- | --- | --- |',
    ...memory.map(v => `| ${v.device} | ${v.process} | ${memoryLine(v)} |`),
    '',
    '## Failed steps',
    '',
    ...steps
      .filter(s => s.verdict === 'failed')
      .map(
        s =>
          `- ${new Date(s.atMs).toISOString().slice(11, 19)} **${s.surface}** ${s.step}: ${s.observed}${s.screenshot == null ? '' : ` — [${s.screenshot}](../${s.screenshot})`}`
      )
  ]
  return `${lines.join('\n')}\n`
}
