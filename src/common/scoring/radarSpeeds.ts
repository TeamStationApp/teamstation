import type { RadarSettings } from '../nodeSettings'
import { isPitchSpeed } from '../pitchData'
import { radarActionCategory } from './actionTimes'
import { recordOf } from './gumbo'

export interface RadarReading {
  at: number
  version: number
  pitchSpeed?: number
  exitVelocity?: number
}

type ObjectValue = Record<string, any>
const object = (value: unknown): value is ObjectValue =>
  value != null && typeof value === 'object' && !Array.isArray(value)
export const positiveSpeed = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

/** Only explicit positive fields are measurements; a held snapshot is not. */
export function radarPacket(
  value: unknown
): Pick<RadarReading, 'pitchSpeed' | 'exitVelocity'> | undefined {
  if (!object(value)) return
  const packet = {
    ...(positiveSpeed(value.pitchSpeed)
      ? { pitchSpeed: value.pitchSpeed }
      : {}),
    ...(positiveSpeed(value.exitVelocity)
      ? { exitVelocity: value.exitVelocity }
      : {})
  }
  return Object.keys(packet).length === 0 ? undefined : packet
}

/** Associate canonical pitches with Gumbo pitches, never positional guesses. */
export function radarTargets(play: unknown): Array<{
  index: number
  at: number
  inPlay: boolean
  foul: boolean
  speed?: number
}> {
  const record = recordOf(play)
  if (
    record?.actionTimes == null ||
    !object(play) ||
    !Array.isArray(play.playEvents)
  )
    return []
  const pitches = play.playEvents
    .map((event: unknown, index: number) => ({ event, index }))
    .filter(({ event }) => object(event) && event.isPitch === true)
  let inPlay = false
  const moments: Array<{ at: number; inPlay: boolean; speed?: number }> = []
  record.actions.forEach((action, i) => {
    const category = radarActionCategory(action)
    const firstInPlay = action.type === 'ballInPlay' && !inPlay
    if (firstInPlay) inPlay = true
    const implicitHit =
      action.type === 'result' && !inPlay && category === 'inPlay'
    if (
      action.type === 'pitch' ||
      firstInPlay ||
      implicitHit ||
      (action.type === 'result' && ['plain', 'H'].includes(category ?? ''))
    ) {
      moments.push({
        at: Date.parse(record.actionTimes![i]),
        inPlay: action.type === 'ballInPlay' || implicitHit,
        ...((action.type === 'pitch' || action.type === 'ballInPlay') &&
        isPitchSpeed(action.speed)
          ? { speed: Math.round(action.speed * 10) / 10 }
          : {})
      })
      if (implicitHit) inPlay = true
    } else if (action.type === 'ballInPlay' && isPitchSpeed(action.speed))
      // Refinements update the same pitch without moving its first-tap time.
      moments[moments.length - 1].speed = Math.round(action.speed * 10) / 10
  })
  if (
    moments.length !== pitches.length ||
    moments.some(m => !Number.isFinite(m.at))
  )
    return []
  const caughtFoul =
    record.actions.some(a => a.type === 'result' && a.foulCaught === true) ||
    (object(record.detail) && record.detail.foulCaught === true)
  return pitches.map(({ event, index }, i) => ({
    index,
    ...moments[i],
    foul: moments[i].inPlay
      ? caughtFoul
      : object(event) && ['F', 'L', 'O', 'R', 'T'].includes(event.details?.code)
  }))
}

/** Recompute only server-owned speeds. For a history edit, prior is the ordered
 * old plays and context is the full ordered new history, including unchanged
 * plays. This keeps batched equal-time pitches paired across at-bat boundaries.
 */
export function withRadarSpeeds<T>(
  play: T,
  readings: readonly RadarReading[],
  settings: RadarSettings,
  prior?: unknown,
  context: readonly unknown[] = [play]
): T {
  const targets = radarTargets(play)
  if (targets.length === 0) return play
  const copy = structuredClone(play) as ObjectValue
  // Persist provenance so log retention cannot make an out-of-window value
  // indistinguishable from a still-valid measurement after settings change.
  const measurements: Record<number, Record<string, number>> = {}
  delete copy.teamStation.radarMeasurements
  const oldTargets = (Array.isArray(prior) ? prior : [prior]).flatMap(source =>
    radarTargets(source).map(target => ({ ...target, source }))
  )
  const identity = (target: (typeof targets)[number]): string =>
    `${target.at}/${target.inPlay}/${target.foul}`
  const occurrences = new Map<string, number>()
  const totals = new Map<string, number>()
  let preceding = true
  for (const source of context) {
    if (source === play) preceding = false
    for (const target of radarTargets(source)) {
      const key = identity(target)
      totals.set(key, (totals.get(key) ?? 0) + 1)
      if (preceding) occurrences.set(key, (occurrences.get(key) ?? 0) + 1)
    }
  }
  const sorted = [...readings].sort((a, b) =>
    a.at === b.at ? b.version - a.version : b.at - a.at
  )
  for (const target of targets) {
    const event = copy.playEvents[target.index]
    const low =
      target.at -
      (target.inPlay ? settings.inPlayWindowSec : settings.pitchWindowSec) *
        1000
    const high =
      target.at + (target.inPlay ? 0 : settings.pitchWindowSec * 1000)
    const candidates = sorted.filter(r => r.at >= low && r.at <= high)
    const key = identity(target)
    const occurrence = occurrences.get(key) ?? 0
    occurrences.set(key, occurrence + 1)
    const matches = oldTargets.filter(t => identity(t) === key)
    // Batched actions can share a time. Pair their occurrences, so a manual
    // edit cannot borrow a different pitch's retained radar measurement.
    // When a pitch was inserted/removed, prefer unchanged manual metadata.
    const old =
      matches.length === totals.get(key)
        ? matches[occurrence]
        : (matches.find(t => t.speed === target.speed) ?? matches[occurrence])
    // A corrected non-pitch event can shift the surviving pitch's index.
    // Its original tap time and category, not its array slot, identify it.
    const source = old?.source
    const previous =
      old != null && object(source) ? source.playEvents[old.index] : undefined
    for (const [field, section, key, allowed] of [
      ['pitchSpeed', 'pitchData', 'startSpeed', true],
      ['exitVelocity', 'hitData', 'launchSpeed', target.inPlay && !target.foul]
    ] as const) {
      // A changed canonical manual speed must not inherit its previous value.
      // Unchanged input may retain a durable radar speed after log retention.
      const retainedAt =
        object(source) && old != null
          ? source.teamStation?.radarMeasurements?.[old.index]?.[field]
          : undefined
      const retained =
        field === 'pitchSpeed' && old?.speed !== target.speed
          ? undefined
          : typeof retainedAt === 'number' &&
              Number.isFinite(retainedAt) &&
              retainedAt >= low &&
              retainedAt <= high
            ? previous?.[section]?.[key]
            : undefined
      const candidate = candidates.find(r => positiveSpeed(r[field]))
      const speed = allowed
        ? (candidate?.[field] ??
          retained ??
          (field === 'pitchSpeed' ? target.speed : undefined))
        : undefined
      if (object(event[section])) Reflect.deleteProperty(event[section], key)
      if (positiveSpeed(speed)) {
        event[section] = { ...event[section], [key]: speed }
        if (candidate != null || positiveSpeed(retained))
          (measurements[target.index] ??= {})[field] =
            candidate?.at ?? retainedAt
      } else if (
        object(event[section]) &&
        Object.keys(event[section]).length === 0
      )
        Reflect.deleteProperty(event, section)
    }
  }
  if (Object.keys(measurements).length > 0)
    copy.teamStation.radarMeasurements = measurements
  return copy as T
}
