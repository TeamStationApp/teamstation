/**
 * The soak's timeline, as data. A seeded function makes it, so every run with the same
 * seed and length has the same events at the same seconds. Events sit in slots, one
 * event per slot: 30 s slots over the two-hour layout.
 *
 * Two layouts:
 *
 * - **Full** (7,200 s): the plan's table. Publishers start at 0, 60 and 120 s, the
 *   watchers join, warm-up runs to 15 min, then every 30 s slot from 15 to 115 min is a
 *   watcher action, a synthetic cut or an iPhone switch, and 115–120 min is quiet.
 * - **Compressed** (any shorter length, `SOAK_MINUTES` for the dry run): the same lead-in,
 *   then exactly one of every action kind on every surface, two synthetic cuts (one with a
 *   timestamp discontinuity) and the iPhone going app → Safari → app, spread evenly from
 *   minute 6 to a one-minute quiet end. Its slots are shorter than 30 s.
 */

export const ACTION_KINDS = [
  'scrubLeft',
  'scrubRight',
  'rapidScrub',
  'skip',
  'slowMotion',
  'cameraCut',
  'jumpToPresent',
  'exitAndReenter',
  'relaunch'
] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

/** The six watcher surfaces. The iPhone is two of them, one in front at a time. */
export const SURFACES = [
  'iphone-app',
  'iphone-safari',
  'android',
  'ipad',
  'tv',
  'chrome'
] as const
export type SoakSurface = (typeof SURFACES)[number]

/** The suite's surface name for each. */
export const SUITE_SURFACE: Record<SoakSurface, string> = {
  'iphone-app': 'ios-app',
  'iphone-safari': 'ios-safari',
  android: 'android-app',
  ipad: 'ipados-app',
  tv: 'tvos-app',
  chrome: 'web-chromium'
}

export const PUBLISHERS = ['publisherA', 'publisherB', 'publisherC'] as const
export type Publisher = (typeof PUBLISHERS)[number]

/** The angles a watcher sees, by the camera rows' labels. */
// One word each: the iPhone's keyboard can drop the space a phone types in a name.
export const ANGLES = ['PhoneA', 'PhoneB', 'Synthetic'] as const
export const SYNTHETIC_ANGLE = 'Synthetic'

export type ScheduleAction =
  | ActionKind
  | 'startPublisher'
  | 'join'
  | 'syntheticCut'
  | 'switchSurface'
  | 'stopPublishers'

export type ScheduleTarget = SoakSurface | Publisher | 'iphone' | 'publishers'

export interface SoakEvent {
  atSec: number
  target: ScheduleTarget
  action: ScheduleAction
  args: Record<string, unknown>
}

export interface SyntheticCut {
  atSec: number
  seconds: number
  discontinuity: boolean
}

export interface SurfaceSwitch {
  atSec: number
  to: 'app' | 'safari'
}

/** Seconds from the run's start; each range is [from, to). */
export interface SoakPhases {
  start: [number, number]
  warmup: [number, number]
  actions: [number, number]
  quiet: [number, number]
  /** The memory windows: the first after warm-up, the last before the end. */
  baselineWindow: [number, number]
  finalWindow: [number, number]
  /** Memory slope is taken over this range. */
  slopeRange: [number, number]
}

export interface SoakSchedule {
  seed: string
  lengthSec: number
  layout: 'full' | 'compressed'
  slotSec: number
  phases: SoakPhases
  cuts: SyntheticCut[]
  switches: SurfaceSwitch[]
  events: SoakEvent[]
}

export const FULL_LENGTH_SEC = 7200
const SLOT_SEC = 30
const MIN = 60

/** The eight synthetic cuts of the full layout: minute, seconds, discontinuity. */
export const FULL_CUTS: SyntheticCut[] = [
  { atSec: 25 * MIN, seconds: 30, discontinuity: false },
  { atSec: 35 * MIN, seconds: 10, discontinuity: false },
  { atSec: 45 * MIN, seconds: 60, discontinuity: false },
  { atSec: 55 * MIN, seconds: 5, discontinuity: false },
  { atSec: 70 * MIN, seconds: 120, discontinuity: false },
  { atSec: 82 * MIN, seconds: 30, discontinuity: true },
  { atSec: 95 * MIN, seconds: 30, discontinuity: false },
  { atSec: 105 * MIN, seconds: 15, discontinuity: false }
]

export const FULL_SWITCHES: SurfaceSwitch[] = [
  { atSec: 20 * MIN, to: 'safari' },
  { atSec: 40 * MIN, to: 'app' },
  { atSec: 60 * MIN, to: 'safari' },
  { atSec: 80 * MIN, to: 'app' },
  { atSec: 100 * MIN, to: 'safari' }
]

/** How long C is protected from a rejoin after a cut is restored. */
export const OUTAGE_RECOVERY_SEC = 60

/**
 * The fixed rotation of actors, one per action slot. The iPhone has two places, 90 s
 * apart, and acts on whichever of its surfaces is in front, so each of the six surfaces
 * acts about as often as the others.
 */
const ROTATION = [
  'iphone',
  'android',
  'ipad',
  'iphone',
  'tv',
  'chrome'
] as const

const REJOIN_KINDS: ReadonlySet<ActionKind> = new Set([
  'exitAndReenter',
  'relaunch'
])

/** mulberry32 over a hash of the seed: small, fast and the same everywhere. */
export function seededRandom(seed: string): () => number {
  let hash = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 3432918353)
    hash = (hash << 13) | (hash >>> 19)
  }
  let state = hash >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Which iPhone surface is in front at a second, given the switches. */
export function iphoneFrontAt(
  switches: SurfaceSwitch[],
  atSec: number
): 'app' | 'safari' {
  let front: 'app' | 'safari' = 'app'
  for (const change of switches) {
    if (change.atSec <= atSec) front = change.to
  }
  return front
}

function inOutage(cuts: SyntheticCut[], atSec: number): boolean {
  return cuts.some(
    cut =>
      atSec >= cut.atSec &&
      atSec < cut.atSec + cut.seconds + OUTAGE_RECOVERY_SEC
  )
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function argsFor(
  kind: ActionKind,
  random: () => number
): Record<string, unknown> {
  switch (kind) {
    case 'scrubLeft':
      return { fraction: round2(0.2 + random() * 0.4) }
    case 'scrubRight':
      return { fraction: 1 }
    case 'rapidScrub':
      return {
        fractions: Array.from({ length: 5 }, () =>
          round2(0.1 + random() * 0.8)
        ),
        intervalMs: 1000
      }
    case 'skip':
      return { steps: [-10, -10, -10, 10, 10] }
    case 'slowMotion':
      return { holdMs: 8000 }
    case 'cameraCut':
      return {
        angle: ANGLES[Math.floor(random() * ANGLES.length)],
        backAfterSec: 20
      }
    case 'exitAndReenter':
      return { waitSec: 10 }
    case 'jumpToPresent':
    case 'relaunch':
      return {}
  }
}

interface Slot {
  atSec: number
  fill:
    | { kind: 'cut'; cut: SyntheticCut }
    | { kind: 'switch'; change: SurfaceSwitch }
    | { kind: 'action'; surface: SoakSurface }
}

/** One permutation of the kinds per round, so every kind comes round before any repeats. */
function kindQueue(
  surface: SoakSurface,
  rounds: number,
  random: () => number
): ActionKind[] {
  const queue: ActionKind[] = []
  for (let i = 0; i < rounds; i++) queue.push(...shuffled(ACTION_KINDS, random))
  return queue
}

/**
 * Gives each action slot its surface's next kind. A rejoin inside a cut's protected
 * window would hide whether C came back on its own, so the next kind that is not a
 * rejoin is taken first and the rejoin waits.
 */
function assignKinds(
  slots: Slot[],
  cuts: SyntheticCut[],
  rounds: number,
  random: () => number
): SoakEvent[] {
  const queues = new Map<SoakSurface, ActionKind[]>()
  for (const surface of SURFACES) {
    queues.set(surface, kindQueue(surface, rounds, random))
  }
  const events: SoakEvent[] = []
  for (const slot of slots) {
    const { fill } = slot
    if (fill.kind === 'cut') {
      events.push({
        atSec: slot.atSec,
        target: 'publisherC',
        action: 'syntheticCut',
        args: {
          seconds: fill.cut.seconds,
          discontinuity: fill.cut.discontinuity
        }
      })
      continue
    }
    if (fill.kind === 'switch') {
      const firstSafari =
        fill.change.to === 'safari' &&
        !events.some(
          event =>
            event.action === 'switchSurface' && event.args.to === 'safari'
        )
      events.push({
        atSec: slot.atSec,
        target: 'iphone',
        action: 'switchSurface',
        args: { to: fill.change.to, newTab: firstSafari }
      })
      continue
    }
    const queue = queues.get(fill.surface)!
    let pick = 0
    const protectedSlot = inOutage(cuts, slot.atSec)
    if (protectedSlot) {
      const free = queue.findIndex(kind => !REJOIN_KINDS.has(kind))
      if (free >= 0) pick = free
    }
    let [kind] = queue.splice(pick, 1)
    if (protectedSlot && REJOIN_KINDS.has(kind)) {
      // Only rejoins left: an earlier, unprotected turn of this surface takes the
      // rejoin and gives its kind here, so the counts stay as planned.
      const earlier = events.findLast(
        event =>
          event.target === fill.surface &&
          !REJOIN_KINDS.has(event.action as ActionKind) &&
          !inOutage(cuts, event.atSec)
      )
      if (earlier != null) {
        const given = earlier.action as ActionKind
        earlier.action = kind
        earlier.args = argsFor(kind, random)
        kind = given
      }
    }
    // Past the planned rounds a surface keeps cycling, seeded as before.
    if (queue.length === 0) queue.push(...shuffled(ACTION_KINDS, random))
    events.push({
      atSec: slot.atSec,
      target: fill.surface,
      action: kind,
      args: argsFor(kind, random)
    })
  }
  return events
}

function leadIn(): SoakEvent[] {
  const events: SoakEvent[] = PUBLISHERS.map((publisher, index) => ({
    atSec: index * MIN,
    target: publisher,
    action: 'startPublisher',
    args: {}
  }))
  const joiners: SoakSurface[] = [
    'iphone-app',
    'android',
    'ipad',
    'tv',
    'chrome'
  ]
  joiners.forEach((surface, index) => {
    events.push({
      atSec: 150 + index * SLOT_SEC,
      target: surface,
      action: 'join',
      args: { angles: [...ANGLES] }
    })
  })
  return events
}

function fullSchedule(seed: string): SoakSchedule {
  const random = seededRandom(seed)
  const phases: SoakPhases = {
    start: [0, 5 * MIN],
    warmup: [5 * MIN, 15 * MIN],
    actions: [15 * MIN, 115 * MIN],
    quiet: [115 * MIN, 120 * MIN],
    baselineWindow: [10 * MIN, 15 * MIN],
    finalWindow: [110 * MIN, 120 * MIN],
    slopeRange: [15 * MIN, 120 * MIN]
  }
  const slots: Slot[] = []
  let turn = 0
  for (let at = phases.actions[0]; at < phases.actions[1]; at += SLOT_SEC) {
    const cut = FULL_CUTS.find(row => row.atSec === at)
    const change = FULL_SWITCHES.find(row => row.atSec === at)
    if (cut != null) slots.push({ atSec: at, fill: { kind: 'cut', cut } })
    else if (change != null) {
      slots.push({ atSec: at, fill: { kind: 'switch', change } })
    } else {
      const actor = ROTATION[turn++ % ROTATION.length]
      const surface: SoakSurface =
        actor === 'iphone'
          ? `iphone-${iphoneFrontAt(FULL_SWITCHES, at)}`
          : actor
      slots.push({ atSec: at, fill: { kind: 'action', surface } })
    }
  }
  const events = [
    ...leadIn(),
    ...assignKinds(slots, FULL_CUTS, 3, random),
    {
      atSec: FULL_LENGTH_SEC,
      target: 'publishers' as const,
      action: 'stopPublishers' as const,
      args: {}
    }
  ]
  return {
    seed,
    lengthSec: FULL_LENGTH_SEC,
    layout: 'full',
    slotSec: SLOT_SEC,
    phases,
    cuts: FULL_CUTS,
    switches: FULL_SWITCHES,
    events
  }
}

/** The shortest compressed run: lead-in, a warm-up minute, 58 slots of 5 s, a quiet minute. */
export const MIN_COMPRESSED_SEC = 6 * MIN + 58 * 5 + MIN

function compressedSchedule(seed: string, lengthSec: number): SoakSchedule {
  const random = seededRandom(seed)
  const actionsFrom = 6 * MIN
  const actionsTo = lengthSec - MIN
  // The rotation, nine rounds: 18 iPhone turns, nine for every other surface. The
  // iPhone's turns 0–4 and 14–17 are the app's, 5–13 Safari's: nine each.
  type Item = Slot['fill']
  const items: Item[] = []
  let iphoneTurn = 0
  for (let i = 0; i < ROTATION.length * ACTION_KINDS.length; i++) {
    const actor = ROTATION[i % ROTATION.length]
    if (actor !== 'iphone') {
      items.push({ kind: 'action', surface: actor })
      continue
    }
    if (iphoneTurn === 5) {
      items.push({ kind: 'switch', change: { atSec: 0, to: 'safari' } })
    }
    if (iphoneTurn === 14) {
      items.push({ kind: 'switch', change: { atSec: 0, to: 'app' } })
    }
    const front = iphoneTurn >= 5 && iphoneTurn < 14 ? 'safari' : 'app'
    items.push({ kind: 'action', surface: `iphone-${front}` })
    iphoneTurn++
  }
  // A plain cut a third of the way in and the discontinuity at two thirds.
  const plain = FULL_CUTS[0]
  const jump = FULL_CUTS.find(cut => cut.discontinuity)!
  items.splice(Math.round(items.length / 3), 0, { kind: 'cut', cut: plain })
  items.splice(Math.round((items.length * 2) / 3), 0, {
    kind: 'cut',
    cut: jump
  })
  const slotSec = Math.floor((actionsTo - actionsFrom) / items.length)
  const slots: Slot[] = items.map((fill, index) => ({
    atSec: actionsFrom + index * slotSec,
    fill
  }))
  const cuts: SyntheticCut[] = []
  const switches: SurfaceSwitch[] = []
  for (const slot of slots) {
    if (slot.fill.kind === 'cut') {
      slot.fill = { kind: 'cut', cut: { ...slot.fill.cut, atSec: slot.atSec } }
      cuts.push(slot.fill.cut)
    } else if (slot.fill.kind === 'switch') {
      slot.fill = {
        kind: 'switch',
        change: { ...slot.fill.change, atSec: slot.atSec }
      }
      switches.push(slot.fill.change)
    }
  }
  const events = [
    ...leadIn(),
    ...assignKinds(slots, cuts, 1, random),
    {
      atSec: lengthSec,
      target: 'publishers' as const,
      action: 'stopPublishers' as const,
      args: {}
    }
  ]
  return {
    seed,
    lengthSec,
    layout: 'compressed',
    slotSec,
    phases: {
      start: [0, 5 * MIN],
      warmup: [5 * MIN, actionsFrom],
      actions: [actionsFrom, actionsTo],
      quiet: [actionsTo, lengthSec],
      baselineWindow: [5 * MIN, actionsFrom],
      finalWindow: [actionsTo, lengthSec],
      slopeRange: [actionsFrom, lengthSec]
    },
    cuts,
    switches,
    events
  }
}

export interface ScheduleOptions {
  seed?: string
  /** The run's length, 7,200 s unless `minutes` says otherwise. */
  lengthSec?: number
  /** `SOAK_MINUTES`: a shorter run, in the compressed layout. */
  minutes?: number
}

export const DEFAULT_SEED = 'streaming-soak'

export function soakSchedule(options: ScheduleOptions = {}): SoakSchedule {
  const seed = options.seed ?? DEFAULT_SEED
  const lengthSec =
    options.minutes != null
      ? Math.round(options.minutes * MIN)
      : (options.lengthSec ?? FULL_LENGTH_SEC)
  if (!Number.isFinite(lengthSec) || lengthSec > FULL_LENGTH_SEC) {
    throw new Error(
      `A soak runs at most ${FULL_LENGTH_SEC} s, not ${lengthSec}`
    )
  }
  if (lengthSec === FULL_LENGTH_SEC) return fullSchedule(seed)
  if (lengthSec < MIN_COMPRESSED_SEC) {
    throw new Error(
      `A compressed soak needs at least ${MIN_COMPRESSED_SEC} s, not ${lengthSec}`
    )
  }
  return compressedSchedule(seed, lengthSec)
}

/** `SOAK_MINUTES` from the environment, if it is set to a number. */
export function minutesFromEnv(
  env: Record<string, string | undefined>
): number | undefined {
  const raw = env.SOAK_MINUTES
  if (raw == null || raw.trim() === '') return undefined
  const minutes = Number(raw)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`SOAK_MINUTES must be a number of minutes, not "${raw}"`)
  }
  return minutes
}
