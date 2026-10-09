import { conflict } from './errors'
import { GAME_POSITIONS } from './gumbo/reference'
import { eventTypeName } from './gumboEventTypes'

/** Labels have one canonical spelling across assignments and account history. */
export function normalizeTag(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Enter a tag')
  const tag = value.trim().replace(/\s+/gu, ' ').toLowerCase()
  if (Array.from(tag).length < 1 || Array.from(tag).length > 64)
    throw new TypeError('Use between 1 and 64 characters for a tag')
  return tag
}

export interface TagChoices {
  recent: string[]
  popular: Array<{ tag: string; count: number }>
}

interface Identity {
  id: string
  signature: string
  tag: string | null
}
export interface TagMetadata {
  version: 1
  play: Identity | null
  events: Array<Identity & { index: number }>
}
export interface TagDocument {
  about: { atBatIndex: number }
  result?: Record<string, unknown>
  matchup?: unknown
  playEvents?: unknown
  tagTargets?: unknown
}
export interface TagTarget {
  id: string
  atBatIndex: number
  eventIndex: number | null
  title: string
  description: string
  tag: string | null
  completed?: boolean
}

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function person(value: unknown): unknown {
  return object(value).id ?? null
}
/** JSON object key order is formatting, not event identity. */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value != null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map(key => [key, canonicalValue(record[key])])
    )
  }
  return value
}
function positionIdentity(value: unknown): unknown {
  const position = object(value)
  if (typeof value === 'number') return String(value)
  if (
    (typeof position.code === 'string' && position.code !== '') ||
    typeof position.code === 'number'
  )
    return String(position.code)
  const abbreviation = typeof value === 'string' ? value : position.abbreviation
  if (typeof abbreviation === 'string')
    return GAME_POSITIONS.get(abbreviation.toUpperCase())?.code ?? abbreviation
  return value ?? null
}
function canonicalSignature(value: unknown[]): string {
  return JSON.stringify(canonicalValue(value))
}
function storedSignature(signature: string): string {
  try {
    const parsed: unknown = JSON.parse(signature)
    if (!Array.isArray(parsed)) return signature
    if (parsed.length === 8) {
      parsed[6] = positionIdentity(parsed[6])
      parsed[1] = parsed[0] === 'pitch' || parsed[1] === true
    }
    return canonicalSignature(parsed)
  } catch {
    return signature
  }
}

/** Names, sentences and the changing score are deliberately not identity. */
export function eventSignature(value: unknown): string {
  const event = object(value)
  const details = object(event.details)
  return canonicalSignature([
    event.type ?? null,
    isPitch(value),
    details.isInPlay === true
      ? 'in_play'
      : (details.code ?? object(details.call).code ?? null),
    details.eventType ?? null,
    person(event.player),
    person(event.pitcher),
    positionIdentity(event.position),
    person(event.replacedPlayer)
  ])
}
function playSignature(play: TagDocument): string {
  return canonicalSignature([
    play.result?.eventType ?? null,
    person(object(play.matchup).batter)
  ])
}
function identity(value: unknown): Identity | null {
  const raw = object(value)
  if (
    typeof raw.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,80}$/.test(raw.id) ||
    typeof raw.signature !== 'string'
  )
    return null
  return {
    id: raw.id,
    signature: storedSignature(raw.signature),
    tag: typeof raw.tag === 'string' ? raw.tag : null
  }
}
export function tagMetadata(play: TagDocument): TagMetadata {
  const raw = object(play.tagTargets)
  const events: TagMetadata['events'] = []
  if (raw.version === 1 && Array.isArray(raw.events))
    for (const value of raw.events) {
      const kept = identity(value)
      const index = object(value).index
      if (kept != null && Number.isInteger(index) && Number(index) >= 0)
        events.push({ ...kept, index: Number(index) })
    }
  return {
    version: 1,
    play: raw.version === 1 ? identity(raw.play) : null,
    events
  }
}

const SUBSTITUTION_TYPES = new Set([
  'pitching_substitution',
  'defensive_substitution',
  'defensive_switch',
  'offensive_substitution'
])
function isPitch(value: unknown): boolean {
  const event = object(value)
  return event.isPitch === true || event.type === 'pitch'
}
function isSubstitution(value: unknown): boolean {
  const event = object(value)
  const details = object(event.details)
  return (
    event.isSubstitution === true ||
    SUBSTITUTION_TYPES.has(String(details.eventType ?? details.code))
  )
}
function eventsOf(play: TagDocument): unknown[] {
  return Array.isArray(play.playEvents) ? play.playEvents : []
}

/** Pitch slots are independent of inserted non-pitch announcements. */
function eventSlots(play: TagDocument): string[] {
  let pitch = 0
  let action = 0
  const fallback: string[] = []
  const substitutions = new Map<string, number>()
  const slots = (Array.isArray(play.playEvents) ? play.playEvents : []).map(
    value => {
      const event = object(value)
      const pitchEvent = isPitch(value)
      if (!pitchEvent && isSubstitution(value)) {
        const signature = eventSignature(value)
        const occurrence = (substitutions.get(signature) ?? 0) + 1
        substitutions.set(signature, occurrence)
        const key = `substitution:${signature}:${occurrence}`
        fallback.push(key)
        return key
      }
      const ordinal = pitchEvent ? ++pitch : ++action
      const key = `${pitchEvent ? 'pitch' : 'action'}:${ordinal}`
      fallback.push(key)
      return pitchEvent &&
        Number.isSafeInteger(event.pitchNumber) &&
        Number(event.pitchNumber) > 0
        ? `pitch:${String(event.pitchNumber)}`
        : key
    }
  )
  // Invalid duplicate numbering cannot make two events share an identity.
  return new Set(slots).size === slots.length ? slots : fallback
}

function identitySlots(
  play: TagDocument,
  metadata: TagMetadata
): Map<string, string> {
  const slots = eventSlots(play)
  return new Map(
    metadata.events.flatMap(event =>
      slots[event.index] == null ? [] : [[event.id, slots[event.index]]]
    )
  )
}

let serial = 0
/** Opaque identity, not a credential; also works in the native JS runtime. */
export function newTagTargetId(): string {
  return `tag_${Date.now().toString(36)}_${(++serial).toString(36)}_${Math.random().toString(36).slice(2)}`
}

/** Keeps the identity of surviving events and forgets every removed target. */
export class TagIdentityRegistry {
  private readonly entries = new Map<number, TagMetadata>()
  private readonly slots = new Map<number, Map<string, string>>()
  private readonly decorated = new WeakMap<
    object,
    { complete: boolean; entry: TagMetadata; document: TagDocument }
  >()

  restore(play: TagDocument): void {
    const metadata = tagMetadata(play)
    this.entries.set(play.about.atBatIndex, metadata)
    this.slots.set(play.about.atBatIndex, identitySlots(play, metadata))
  }

  decorate<T extends TagDocument>(
    play: T,
    complete: boolean,
    createId = newTagTargetId
  ): T {
    const previous =
      this.entries.get(play.about.atBatIndex) ?? tagMetadata(play)
    const cached = this.decorated.get(play)
    if (cached?.entry === previous && cached.complete === complete)
      return cached.document as T
    const used = new Set<string>()
    const rawEvents = Array.isArray(play.playEvents) ? play.playEvents : []
    const signatures = rawEvents.map(eventSignature)
    const slots = eventSlots(play)
    const previousSlots =
      this.slots.get(play.about.atBatIndex) ?? identitySlots(play, previous)
    const survivors = new Map(
      previous.events.map(event => [previousSlots.get(event.id), event])
    )
    const events = rawEvents.map((_event, index) => {
      const signature = signatures[index]
      const candidate = survivors.get(slots[index])
      const kept =
        candidate?.signature === signature && !used.has(candidate.id)
          ? candidate
          : undefined
      const id = kept?.id ?? createId()
      used.add(id)
      return { id, index, signature, tag: kept?.tag ?? null }
    })
    const signature = playSignature(play)
    const kept = previous.play?.signature === signature ? previous.play : null
    const metadata: TagMetadata = {
      version: 1,
      play: complete
        ? (kept ?? { id: createId(), signature, tag: null })
        : null,
      events
    }
    this.entries.set(play.about.atBatIndex, metadata)
    this.slots.set(play.about.atBatIndex, identitySlots(play, metadata))
    const document = { ...play, tagTargets: metadata }
    this.decorated.set(play, { complete, entry: metadata, document })
    return document
  }

  retain(indexes: Iterable<number>): void {
    const kept = new Set(indexes)
    for (const index of this.entries.keys())
      if (!kept.has(index)) {
        this.entries.delete(index)
        this.slots.delete(index)
      }
  }

  setTag(id: string, tag: string | null): boolean {
    for (const [index, entry] of this.entries) {
      const target = [entry.play, ...entry.events].find(item => item?.id === id)
      if (target != null) {
        this.entries.set(index, {
          ...entry,
          play: entry.play?.id === id ? { ...entry.play, tag } : entry.play,
          events: entry.events.map(event =>
            event.id === id ? { ...event, tag } : event
          )
        })
        return true
      }
    }
    return false
  }
}

/** A legacy caller cannot disambiguate replacement versus insertion of activities. */
function requireUnambiguousActions(
  incoming: TagDocument,
  previous: TagDocument
): void {
  const oldEvents = eventsOf(previous)
  const tagged = tagMetadata(previous).events.filter(
    target => target.tag != null
  )
  const activities = (play: TagDocument): unknown[] =>
    eventsOf(play).filter(event => !isPitch(event) && !isSubstitution(event))
  const provenance = (event: unknown): string | null => {
    const raw = object(event)
    if (typeof raw.startTime !== 'string' || raw.startTime === '') return null
    const parsed = Date.parse(raw.startTime)
    return Number.isFinite(parsed) ? String(parsed) : raw.startTime
  }
  const beforeEvents = activities(previous)
  const afterEvents = activities(incoming)
  const before = beforeEvents.map(event =>
    canonicalSignature([eventSignature(event), provenance(event)])
  )
  const after = afterEvents.map(event =>
    canonicalSignature([eventSignature(event), provenance(event)])
  )
  const uniqueProvenance = (events: unknown[]): boolean => {
    const keys = events.map(provenance)
    return keys.every(key => key != null) && new Set(keys).size === keys.length
  }
  const ambiguousCountChange =
    before.length !== after.length &&
    before.length > 0 &&
    after.length > 0 &&
    (!uniqueProvenance(beforeEvents) || !uniqueProvenance(afterEvents))
  if (
    tagged.some(
      target =>
        !isPitch(oldEvents[target.index]) &&
        !isSubstitution(oldEvents[target.index])
    ) &&
    (ambiguousCountChange ||
      before
        .slice(0, Math.min(before.length, after.length))
        .some((signature, index) => signature !== after[index]))
  )
    throw conflict(
      'The action history changed. Reload its event identities before saving.'
    )
  const oldPitches = oldEvents.filter(isPitch)
  const newPitches = eventsOf(incoming).filter(isPitch)
  const timestampProves = (old: unknown, next: unknown): boolean => {
    const time = provenance(old)
    return (
      time != null &&
      time === provenance(next) &&
      oldPitches.filter(event => provenance(event) === time).length === 1 &&
      newPitches.filter(event => provenance(event) === time).length === 1
    )
  }
  const numbered = (events: unknown[]): boolean => {
    const numbers = events.map(event => object(event).pitchNumber)
    return (
      numbers.every(
        number => Number.isSafeInteger(number) && Number(number) > 0
      ) && new Set(numbers).size === numbers.length
    )
  }
  const oldPitchSlots = eventSlots(previous).filter((_, index) =>
    isPitch(oldEvents[index])
  )
  const incomingEvents = eventsOf(incoming)
  const newPitchSlots = eventSlots(incoming).filter((_, index) =>
    isPitch(incomingEvents[index])
  )
  if (
    tagged.some(target => isPitch(oldEvents[target.index])) &&
    (!numbered(oldPitches) || !numbered(newPitches)) &&
    oldPitchSlots
      .slice(0, Math.min(oldPitchSlots.length, newPitchSlots.length))
      .some((slot, index) => slot !== newPitchSlots[index])
  )
    throw conflict(
      'The pitch numbering changed. Reload its event identities before saving.'
    )
  if (
    tagged.some(target => isPitch(oldEvents[target.index])) &&
    numbered(oldPitches) &&
    numbered(newPitches) &&
    newPitches.some(event => {
      const previous = oldPitches.find(
        old => object(old).pitchNumber === object(event).pitchNumber
      )
      if (previous == null) {
        return oldPitches.some(
          old =>
            !newPitches.some(
              next => object(next).pitchNumber === object(old).pitchNumber
            ) &&
            eventSignature(old) === eventSignature(event) &&
            (timestampProves(old, event) ||
              (provenance(old) === provenance(event) &&
                canonicalSignature([object(old).count ?? null]) ===
                  canonicalSignature([object(event).count ?? null])))
        )
      }
      return (
        provenance(previous) !== provenance(event) ||
        (!timestampProves(previous, event) &&
          canonicalSignature([object(previous).count ?? null]) !==
            canonicalSignature([object(event).count ?? null]))
      )
    })
  )
    throw conflict(
      'The pitch history changed. Reload its event identities before saving.'
    )
  if (
    tagged.some(target => isPitch(oldEvents[target.index])) &&
    (!numbered(oldPitches) || !numbered(newPitches))
  ) {
    const pitchKey = (event: unknown): string =>
      provenance(event) != null
        ? canonicalSignature(['time', provenance(event)])
        : canonicalSignature([
            eventSignature(event),
            object(event).count ?? null
          ])
    const reliable = (events: unknown[]): boolean => {
      const keys = events.map(event => {
        const time = provenance(event)
        if (time != null) return `time:${time}`
        const count = object(object(event).count)
        return typeof count.balls === 'number' &&
          typeof count.strikes === 'number' &&
          typeof count.outs === 'number'
          ? canonicalSignature([count.balls, count.strikes, count.outs])
          : null
      })
      return (
        keys.every(key => key != null) && new Set(keys).size === keys.length
      )
    }
    const countChanged =
      oldPitches.length !== newPitches.length &&
      oldPitches.length > 0 &&
      newPitches.length > 0
    const oldTimes = oldPitches.map(provenance)
    const newTimes = newPitches.map(provenance)
    const timedReorder =
      oldPitches.length === newPitches.length &&
      (oldTimes.some((time, index) => time !== newTimes[index]) ||
        oldPitches.some(
          (event, index) =>
            !timestampProves(event, newPitches[index]) &&
            canonicalSignature([object(event).count ?? null]) !==
              canonicalSignature([object(newPitches[index]).count ?? null])
        ))
    if (
      timedReorder ||
      (countChanged &&
        (!reliable(oldPitches) ||
          !reliable(newPitches) ||
          oldPitches
            .slice(0, Math.min(oldPitches.length, newPitches.length))
            .some(
              (event, index) => pitchKey(event) !== pitchKey(newPitches[index])
            )))
    )
      throw conflict(
        'The pitch history changed. Reload its event identities before saving.'
      )
  }
  const substitutions = (play: TagDocument): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const event of eventsOf(play).filter(isSubstitution)) {
      const signature = eventSignature(event)
      counts.set(signature, (counts.get(signature) ?? 0) + 1)
    }
    return counts
  }
  const oldSubs = substitutions(previous)
  const newSubs = substitutions(incoming)
  for (const target of tagged) {
    const event = oldEvents[target.index]
    if (!isSubstitution(event)) continue
    const signature = eventSignature(event)
    const oldCount = oldSubs.get(signature) ?? 0
    const newCount = newSubs.get(signature) ?? 0
    const oldOccurrences = oldEvents.filter(
      item => isSubstitution(item) && eventSignature(item) === signature
    )
    const newOccurrences = eventsOf(incoming).filter(
      item => isSubstitution(item) && eventSignature(item) === signature
    )
    const changedOccurrences = oldOccurrences.some(
      (item, index) => provenance(item) !== provenance(newOccurrences[index])
    )
    const changedSequence =
      canonicalSignature(
        oldEvents.filter(isSubstitution).map(eventSignature)
      ) !==
      canonicalSignature(
        eventsOf(incoming).filter(isSubstitution).map(eventSignature)
      )
    if (
      newCount > 0 &&
      (oldCount !== newCount ||
        changedOccurrences ||
        (Math.max(oldCount, newCount) > 1 &&
          oldOccurrences.some(item => provenance(item) == null) &&
          changedSequence))
    )
      throw conflict(
        'The repeated action history changed. Reload its event identities before saving.'
      )
  }
}

/** Preserve legacy saves against the original raw document before indexes change. */
export function withPreviousTagIdentities<T extends TagDocument>(
  incoming: T,
  previous: unknown,
  complete: boolean
): T {
  const supplied = tagMetadata(incoming)
  const raw = Array.isArray(incoming.playEvents) ? incoming.playEvents : []
  const ids = [
    ...supplied.events.map(target => target.id),
    ...(supplied.play == null ? [] : [supplied.play.id])
  ]
  if (
    incoming.tagTargets != null &&
    supplied.events.length === raw.length &&
    new Set(ids).size === ids.length &&
    (complete
      ? supplied.play?.signature === playSignature(incoming)
      : supplied.play == null) &&
    raw.every((event, index) =>
      supplied.events.some(
        target =>
          target.index === index && target.signature === eventSignature(event)
      )
    )
  )
    return incoming
  const stored = object(previous)
  if (
    stored.tagTargets == null ||
    object(stored.about).atBatIndex !== incoming.about.atBatIndex
  )
    return incoming
  const original = stored as unknown as TagDocument
  requireUnambiguousActions(incoming, original)
  const registry = new TagIdentityRegistry()
  registry.restore(original)
  return registry.decorate(incoming, complete)
}

/** The persisted pitches/actions followed by each completed play. */
export function tagTargets(play: TagDocument): TagTarget[] {
  const metadata = tagMetadata(play)
  const rawEvents = Array.isArray(play.playEvents) ? play.playEvents : []
  const out: TagTarget[] = []
  for (const event of metadata.events) {
    const raw = object(rawEvents[event.index])
    const details = object(raw.details)
    const description =
      typeof details.description === 'string' ? details.description : ''
    const name = details.eventType ?? details.code
    out.push({
      id: event.id,
      atBatIndex: play.about.atBatIndex,
      eventIndex: event.index,
      title:
        description !== ''
          ? description
          : typeof name === 'string'
            ? name
            : 'Action',
      description,
      tag: event.tag
    })
  }
  if (metadata.play != null) {
    const description =
      typeof play.result?.description === 'string'
        ? play.result.description
        : ''
    out.push({
      id: metadata.play.id,
      atBatIndex: play.about.atBatIndex,
      eventIndex: null,
      completed: true,
      title: eventTypeName(
        typeof play.result?.eventType === 'string'
          ? play.result.eventType
          : null
      ),
      description,
      tag: metadata.play.tag
    })
  }
  return out
}

/** A completed play describes the same Undo step as its terminal pitch/action. */
function terminalEvent(play: TagDocument): TagTarget | undefined {
  if (tagMetadata(play).play == null) return undefined
  const events = Array.isArray(play.playEvents) ? play.playEvents : []
  const target = tagTargets(play)
    .filter(
      item =>
        item.eventIndex != null &&
        !isSubstitution(events[item.eventIndex]) &&
        (isPitch(events[item.eventIndex]) ||
          object(object(events[item.eventIndex]).details).isInPlay === true ||
          (typeof play.result?.eventType === 'string' &&
            object(object(events[item.eventIndex]).details).eventType ===
              play.result.eventType))
    )
    .at(-1)
  if (target?.eventIndex == null) return undefined
  const event = object(events[target.eventIndex])
  const details = object(event.details)
  const code = details.code ?? object(details.call).code
  const count = object(event.count)
  const result = play.result?.eventType
  const terminal =
    details.isInPlay === true ||
    (result === 'hit_by_pitch' && isPitch(event) && code === 'H') ||
    (typeof details.eventType === 'string' && details.eventType === result) ||
    (typeof result === 'string' &&
      result.startsWith('strikeout') &&
      isPitch(event) &&
      ((typeof count.strikes === 'number' && count.strikes >= 3) ||
        ['C', 'S', 'T', 'L'].includes(typeof code === 'string' ? code : ''))) ||
    ((result === 'walk' || result === 'intent_walk') &&
      isPitch(event) &&
      ((typeof count.balls === 'number' && count.balls >= 4) || code === 'B'))
  return terminal ? target : undefined
}

export function completedPlayTag(play: TagDocument): string | null {
  const completed = tagMetadata(play).play
  return completed == null
    ? null
    : (completed.tag ?? terminalEvent(play)?.tag ?? null)
}

/** One display row per action; raw pitch and play identities remain intact. */
export function historyTargets(play: TagDocument): TagTarget[] {
  const all = tagTargets(play)
  const terminal = terminalEvent(play)
  if (terminal == null) return all
  const completed = all.find(target => target.eventIndex === null)!
  const row =
    completed.tag == null && terminal.tag != null
      ? {
          ...completed,
          id: terminal.id,
          eventIndex: terminal.eventIndex,
          tag: terminal.tag
        }
      : completed
  return [
    ...all.filter(
      target => target.id !== terminal.id && target.eventIndex !== null
    ),
    row
  ]
}

/** Apply authoritative storage labels without changing Gumbo descriptions. */
export function withTargetTags<T extends TagDocument>(
  play: T,
  tags: ReadonlyMap<string, string>
): T {
  const metadata = tagMetadata(play)
  const label = (item: Identity): Identity => ({
    ...item,
    tag: tags.get(item.id) ?? null
  })
  return {
    ...play,
    tagTargets: {
      ...metadata,
      play: metadata.play == null ? null : label(metadata.play),
      events: metadata.events.map(item => ({ ...item, ...label(item) }))
    }
  }
}
