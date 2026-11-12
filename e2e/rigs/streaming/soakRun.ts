import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { windowsFromPhases } from './soakMemory'
import type { MemorySample, RecordedEvent, RecordedProbe } from './soakRecords'
import { reduceRunDir, type SoakReport } from './soakReport'
import type {
  Publisher,
  SoakEvent,
  SoakSchedule,
  SoakSurface
} from './soakSchedule'
import { performAction, type SoakSurfaceDriver } from './surfaces/surface'

/** A camera the run starts and stops; the synthetic one can also be cut. */
export interface SoakPublisher {
  start: () => Promise<void>
  stop: () => Promise<void>
  cut?: (seconds: number, options: { discontinuity: boolean }) => Promise<void>
}

/** The iPhone: one of its two surfaces is in front at a time. */
export interface SoakIphone {
  readonly surface: 'iphone-app' | 'iphone-safari'
  switchTo: (to: 'app' | 'safari') => Promise<{ newTab: boolean }>
}

/** Reads one device's memory. `stop` returns what it gathered over the whole run, if anything. */
export interface SoakSampler {
  name: string
  start?: () => Promise<void>
  sample?: (now: number) => Promise<MemorySample[]>
  stop?: () => Promise<MemorySample[] | undefined>
}

export interface SoakParts {
  schedule: SoakSchedule
  runDir: string
  surfaces: Record<SoakSurface, SoakSurfaceDriver>
  iphone: SoakIphone
  publishers: Record<Publisher, SoakPublisher>
  samplers: SoakSampler[]
  provenance: Record<string, unknown>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Seconds of schedule per real second; tests run a schedule faster. */
  speed?: number
  probeEveryMs?: number
  sampleEveryMs?: number
}

const WATCHERS: SoakSurface[] = ['android', 'ipad', 'tv', 'chrome']

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs a soak schedule against its parts and writes what happened to the run
 * directory, then reduces it to the report. Each surface does one thing at a
 * time, in schedule order; different surfaces act at once. Every surface is
 * probed every `probeEveryMs` and right after each action; the iPhone is
 * probed on whichever surface is in front. Publishers and samplers stop
 * whatever happens, before the report is written.
 */
export async function runSoak(parts: SoakParts): Promise<SoakReport> {
  const now = parts.now ?? Date.now
  const sleep =
    parts.sleep ??
    (async (ms: number) => {
      await new Promise(resolve => setTimeout(resolve, ms))
    })
  const speed = parts.speed ?? 1
  const probeEveryMs = parts.probeEveryMs ?? 30_000
  const sampleEveryMs = parts.sampleEveryMs ?? 60_000
  mkdirSync(parts.runDir, { recursive: true })
  const write = (file: string, value: unknown): void => {
    appendFileSync(join(parts.runDir, file), `${JSON.stringify(value)}\n`)
  }
  const event = (value: RecordedEvent): void => {
    write('events.jsonl', value)
  }

  // One queue per surface, and one for the publishers and the iPhone's switch.
  const queues = new Map<string, Promise<void>>()
  const enqueue = (key: string, task: () => Promise<void>): void => {
    // A queue's tail never rejects: a task's failure is recorded by `act`.
    const settled = (queues.get(key) ?? Promise.resolve())
      .then(task)
      .catch(() => undefined)
    queues.set(key, settled)
  }
  const queueFor = (surface: SoakSurface): string =>
    surface.startsWith('iphone') ? 'iphone' : surface

  const probe = async (surface: SoakSurface): Promise<void> => {
    const atMs = now()
    try {
      const seen = await parts.surfaces[surface].probe()
      write('probes.jsonl', { atMs, surface, ...seen } satisfies RecordedProbe)
    } catch (error) {
      write('probes.jsonl', {
        atMs,
        surface,
        tiles: null,
        bar: null,
        foreground: null,
        reason: `probe threw: ${message(error)}`
      } satisfies RecordedProbe)
    }
  }
  const probeAll = (): void => {
    // The iPhone's probe looks at whichever surface is in front when it runs.
    enqueue('iphone', async () => {
      await probe(parts.iphone.surface)
    })
    for (const surface of WATCHERS) {
      enqueue(surface, async () => {
        await probe(surface)
      })
    }
  }

  const act = async (
    target: string,
    action: string,
    args: Record<string, unknown>,
    run: () => Promise<RecordedEvent['outcome'] | undefined>,
    driver?: SoakSurfaceDriver
  ): Promise<void> => {
    const atMs = now()
    const withNotes = (): Pick<RecordedEvent, 'notes'> => {
      const notes = driver?.takeNotes?.() ?? []
      return notes.length === 0 ? {} : { notes }
    }
    try {
      const outcome = await run()
      event({
        atMs,
        doneMs: now(),
        target,
        action,
        args,
        ...(outcome == null ? {} : { outcome }),
        ...withNotes()
      })
    } catch (error) {
      event({
        atMs,
        doneMs: now(),
        target,
        action,
        args,
        error: message(error),
        ...withNotes()
      })
    }
  }

  const dispatch = (step: SoakEvent): void => {
    const { target, action, args } = step
    if (action === 'startPublisher') {
      enqueue(target, async () => {
        await act(target, action, args, async () => {
          await parts.publishers[target as Publisher].start()
          return undefined
        })
      })
      return
    }
    if (action === 'syntheticCut') {
      enqueue(target, async () => {
        const publisher = parts.publishers[target as Publisher]
        await act(target, action, args, async () => {
          if (publisher.cut == null) throw new Error(`${target} cannot be cut`)
          await publisher.cut(Number(args.seconds), {
            discontinuity: args.discontinuity === true
          })
          return undefined
        })
      })
      return
    }
    if (action === 'stopPublishers') return
    if (action === 'switchSurface') {
      enqueue('iphone', async () => {
        await act(target, action, args, async () => {
          const to = args.to === 'app' ? 'app' : 'safari'
          await parts.iphone.switchTo(to)
          return undefined
        })
        await probe(parts.iphone.surface)
      })
      return
    }
    const surface = target as SoakSurface
    enqueue(queueFor(surface), async () => {
      await act(
        target,
        action,
        args,
        async () => {
          await performAction(parts.surfaces[surface], action, args)
          return undefined
        },
        parts.surfaces[surface]
      )
      await probe(surface)
    })
    if (action === 'cameraCut' && args.backAfterSec != null) {
      const back = Number(args.backAfterSec) * 1000
      enqueue(queueFor(surface), async () => {
        await sleep(back / speed)
        // Tapping the filling angle again gives the view back to every angle.
        const backArgs = { angle: args.angle }
        await act(
          target,
          'cameraCutBack',
          backArgs,
          async () => {
            await performAction(
              parts.surfaces[surface],
              'cameraCutBack',
              backArgs
            )
            return undefined
          },
          parts.surfaces[surface]
        )
        await probe(surface)
      })
    }
  }

  const startMs = now()
  event({
    atMs: startMs,
    target: 'run',
    action: 'runStart',
    args: { phases: parts.schedule.phases, provenance: parts.provenance }
  })
  for (const sampler of parts.samplers) {
    try {
      await sampler.start?.()
    } catch (error) {
      event({
        atMs: now(),
        target: sampler.name,
        action: 'samplerStart',
        error: message(error)
      })
    }
  }

  // Samplers run beside the schedule, never in its way: one still busy (a
  // recording being read) is skipped until it is done.
  const busy = new Map<SoakSampler, Promise<void>>()
  const sample = (): void => {
    for (const sampler of parts.samplers) {
      if (busy.has(sampler) || sampler.sample == null) continue
      const take = async (): Promise<void> => {
        try {
          for (const row of (await sampler.sample?.(now())) ?? [])
            write('memory.jsonl', row)
        } catch (error) {
          event({
            atMs: now(),
            target: sampler.name,
            action: 'sample',
            error: message(error)
          })
        }
      }
      busy.set(
        sampler,
        take().finally(() => {
          busy.delete(sampler)
        })
      )
    }
  }

  const elapsed = (): number => (now() - startMs) * speed
  const events = [...parts.schedule.events].sort((a, b) => a.atSec - b.atSec)
  const endMs = parts.schedule.lengthSec * 1000
  let nextProbe = parts.schedule.phases.start[1] * 1000
  let nextSample = 0
  let at = 0
  try {
    while (elapsed() < endMs) {
      const t = elapsed()
      while (at < events.length && events[at].atSec * 1000 <= t) {
        dispatch(events[at])
        at++
      }
      if (t >= nextProbe) {
        probeAll()
        nextProbe += probeEveryMs
      }
      if (t >= nextSample) {
        sample()
        nextSample += sampleEveryMs
      }
      const due = Math.min(
        at < events.length ? events[at].atSec * 1000 : endMs,
        nextProbe,
        nextSample,
        endMs
      )
      await sleep(Math.max(1, (due - elapsed()) / speed))
    }
    await Promise.all([...queues.values()])
  } finally {
    // Whatever happened, the cameras stop and the samplers hand in what they hold.
    for (const name of Object.keys(parts.publishers) as Publisher[]) {
      await act(name, 'stopPublisher', {}, async () => {
        await parts.publishers[name].stop()
        return undefined
      })
    }
    await Promise.all([...busy.values()])
    for (const sampler of parts.samplers) {
      try {
        for (const row of (await sampler.stop?.()) ?? [])
          write('memory.jsonl', row)
      } catch (error) {
        event({
          atMs: now(),
          target: sampler.name,
          action: 'samplerStop',
          error: message(error)
        })
      }
    }
  }
  return reduceRunDir(parts.runDir, windowsFromPhases(parts.schedule.phases))
}
