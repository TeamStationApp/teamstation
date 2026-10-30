import { mostRestrictive, type PlayerNamePrivacy } from './playerNamePrivacy'

/**
 * How a person's name is written anywhere in the app: first name, last
 * initial, `Jordan P`, unless the player's league, season or team has chosen
 * another public format (`playerNamePrivacy.ts`), which only the server picks.
 *
 * The full name is stored — it is what the import sent, what a parent would
 * search for, and what an admin needs to tell two children apart — but it is
 * drawn only in authorized roster management and player Settings. The API
 * sends it to nobody except whoever may edit it —
 * `mayEditName` on the server: a guardian, the player, a site
 * administrator, and an administrator, coach, assistant or scorekeeper of a
 * team the player plays for, set on the team or carried down from its season
 * or league, or that team's owner or manager — through
 * `GET /players/:userId/name`, and a roster read with `includeFullNames` by
 * the team's roster managers. A songkeeper or videographer never reads it.
 */

/**
 * What a deleted account is called wherever it still appears, as one first
 * name: its short name is the whole of it, never "Deleted u".
 */
export const DELETED_NAME = 'Deleted user'

export interface NamedPerson {
  id: string | number
  firstName?: string | null
  lastName?: string | null
  /** The whole name, for people imported before we had the two halves. */
  displayName: string
}

/** `Jordan`, `Pujols` → `Jordan P`. */
export function shortName(person: NamedPerson): string {
  const { first, last } = halves(person)
  if (first !== '' && last.length >= 2) return `${first} ${last[0]}`
  if (first !== '' && last.length === 1) return `${first} ${last}`
  if (first !== '') return first
  return last
}

/**
 * A short name split where it was built: the first name, and what was kept of
 * the last. `Jordan Pa` → `Jordan`, `Pa`. The add-to-roster form shows the two
 * halves in its two name fields without ever holding the whole name.
 */
export function shortParts(
  person: NamedPerson,
  short: string
): { first: string; last: string } {
  const { first } = halves(person)
  if (first !== '' && short.startsWith(first))
    return { first, last: short.slice(first.length).trim() }
  // A format that abbreviated the first name: `A L`.
  if (first !== '' && short.includes(' ')) {
    const [given = '', ...rest] = short.split(' ')
    return { first: given, last: rest.join(' ') }
  }
  return { first: '', last: short }
}

/**
 * `Jordan`, `Pujols` → `Jordan Pujols`: both halves as stored, or the display name
 * for somebody imported before there were halves.
 */
export function fullName(person: NamedPerson): string {
  const first = (person.firstName ?? '').trim()
  const last = (person.lastName ?? '').trim()
  if (first === '' && last === '') return person.displayName.trim()
  return [first, last].filter(half => half !== '').join(' ')
}

/** Authorized roster display uses complete name parts, or the legacy full
 * label when an import only split part of it. Ordinary screens use shortName.
 */
export function rosterFullName(person: NamedPerson): string {
  const first = (person.firstName ?? '').trim()
  const last = (person.lastName ?? '').trim()
  if (first !== '' && last !== '') return fullName(person)
  const legacy = person.displayName.trim()
  return legacy === '' ? fullName(person) : legacy
}

/**
 * Short names for a list, with collisions broken.
 *
 * `Jordan Pujols` and `Jordan Palmeiro` both come out `Jordan P`, so the function
 * works over the list being drawn rather than a row at a time: anything still
 * identical takes another letter of the surname until it is not. The scope is
 * one screen's worth — a game for a box score, a team for a roster — which
 * keeps an answer stable while somebody is looking at it.
 */
export function shortNames(
  people: NamedPerson[]
): Map<string | number, string> {
  // One entry per person. A box score joins the same user through more than
  // one row, and counting those as two people called `Henry H` made every
  // name in the list grow a letter it did not need.
  const unique = new Map<string | number, NamedPerson>()
  for (const person of people) {
    if (!unique.has(person.id)) unique.set(person.id, person)
  }

  const byName = new Map<string, NamedPerson[]>()
  for (const person of unique.values()) {
    const name = shortName(person)
    const held = byName.get(name)
    if (held == null) byName.set(name, [person])
    else held.push(person)
  }

  const result = new Map<string | number, string>()
  for (const [name, group] of byName) {
    if (group.length === 1) {
      const only = group[0]
      if (only != null) result.set(only.id, name)
      continue
    }
    for (const person of group) {
      result.set(person.id, lengthenUntilDistinct(person, group))
    }
  }
  return result
}

/** A person's name with this many letters of each abbreviated part. */
function written(
  person: NamedPerson,
  format: PlayerNamePrivacy,
  given: number,
  surname: number
): string {
  if (format === 'full') return fullName(person)
  if (fullName(person) === DELETED_NAME) return DELETED_NAME
  const { first, last } = halves(person)
  if (format === 'firstLastInitial') {
    if (surname === 1) return shortName(person)
    return `${first} ${last.slice(0, surname)}`.trim()
  }
  const shownLast = format === 'initialLast' ? last : last.slice(0, surname)
  return `${first.slice(0, given)} ${shownLast}`.trim()
}

/**
 * `Alex Lee` as the public format writes it: `Alex L`, `A Lee`, `A L` or
 * `Alex Lee`. No period after an initial, and a missing half is left out.
 */
export function formatName(
  person: NamedPerson,
  format: PlayerNamePrivacy
): string {
  return written(person, format, 1, 1)
}

/**
 * A name as a model is given it: its format's, and with no first name to go
 * by, the surname's initial alone, never the surname.
 */
export function modelLabel(
  person: NamedPerson,
  format: PlayerNamePrivacy
): string {
  const { first, last } = halves(person)
  return first === '' ? last.slice(0, 1) : formatName(person, format)
}

/** One person of a list, and the public format that applies to them. */
export interface FormattedPerson {
  person: NamedPerson
  format: PlayerNamePrivacy
}

/** The letters of each part a format can lengthen, in the order it does. */
function lengthenings(entry: FormattedPerson): Array<[number, number]> {
  const { first, last } = halves(entry.person)
  const given = first.length
  const surname = last.length
  const steps: Array<[number, number]> = []
  if (entry.format === 'firstLastInitial')
    for (let take = 2; take <= surname; take++) steps.push([1, take])
  if (entry.format === 'initialLast')
    for (let take = 2; take <= given; take++) steps.push([take, 1])
  if (entry.format === 'initials') {
    for (let take = 2; take <= given; take++) steps.push([take, 1])
    for (let take = 2; take <= surname; take++) steps.push([given, take])
  }
  return steps
}

/**
 * Public names for a list, each person in their own format, with collisions
 * broken across the whole list: anything still identical takes another letter
 * of the part its format abbreviates until it differs. A full name abbreviates
 * nothing, so two identical full names stay identical. Somebody who appears
 * twice in two formats is written in the more restrictive. Over a list wholly
 * in the built-in format this answers exactly what `shortNames` does. A list
 * going to a model is not lengthened: another letter of a surname, or of a
 * first name the public format withholds, is what it must never be told.
 */
export function formatNames(
  entries: readonly FormattedPerson[],
  options: { lengthen?: boolean } = {}
): Map<string | number, string> {
  const unique = new Map<string | number, FormattedPerson>()
  for (const entry of entries) {
    const held = unique.get(entry.person.id)
    unique.set(
      entry.person.id,
      held == null
        ? entry
        : {
            person: held.person,
            format: mostRestrictive([held.format, entry.format])
          }
    )
  }
  const people = [...unique.values()]
  if (options.lengthen === false)
    return new Map(
      people.map(entry => [
        entry.person.id,
        modelLabel(entry.person, entry.format)
      ])
    )
  if (people.every(entry => entry.format === 'firstLastInitial'))
    return shortNames(people.map(entry => entry.person))
  // Everybody still identical takes one more letter, all together, so a step
  // only ever goes up and the loop ends with the last letter anybody has.
  const steps = new Map(people.map(entry => [entry, 0]))
  const nameOf = (entry: FormattedPerson): string => {
    const step = steps.get(entry)!
    if (step === 0) return formatName(entry.person, entry.format)
    const [given, surname] = lengthenings(entry)[step - 1]
    return written(entry.person, entry.format, given, surname)
  }
  const duplicates = (): FormattedPerson[][] => {
    const groups = new Map<string, FormattedPerson[]>()
    for (const entry of people) {
      const name = nameOf(entry)
      groups.set(name, [...(groups.get(name) ?? []), entry])
    }
    return [...groups.values()].filter(group => group.length > 1)
  }
  let moved = true
  while (moved) {
    moved = false
    for (const group of duplicates())
      for (const entry of group) {
        if (steps.get(entry)! >= lengthenings(entry).length) continue
        steps.set(entry, steps.get(entry)! + 1)
        moved = true
      }
  }
  // Nothing here can tell these apart, as `lengthenUntilDistinct` says.
  for (const group of duplicates())
    for (const entry of group) steps.set(entry, 0)
  return new Map(people.map(entry => [entry.person.id, nameOf(entry)]))
}

function lengthenUntilDistinct(
  person: NamedPerson,
  group: NamedPerson[]
): string {
  const { first, last } = halves(person)
  for (let take = 2; take <= last.length; take++) {
    const candidate = `${first} ${last.slice(0, take)}`
    const clashes = group.some(
      other =>
        other.id !== person.id &&
        `${halves(other).first} ${halves(other).last.slice(0, take)}` ===
          candidate
    )
    if (!clashes) return candidate
  }
  // Two people with the same name on the same team. Nothing here can tell them
  // apart, and inventing a suffix would be a lie about what we know.
  return shortName(person)
}

function halves(person: NamedPerson): { first: string; last: string } {
  const first = (person.firstName ?? '').trim()
  const last = (person.lastName ?? '').trim()
  if (first !== '' || last !== '') return { first, last }
  // A deleted account read by its name alone (a game read with short names
  // only) is still one first name.
  if (person.displayName.trim() === DELETED_NAME)
    return { first: DELETED_NAME, last: '' }
  // Imported with only a display name: split it the same way and carry on.
  const words = person.displayName
    .trim()
    .split(/\s+/)
    .filter(w => w !== '')
  if (words.length === 0) return { first: '', last: '' }
  if (words.length === 1) return { first: words[0] ?? '', last: '' }
  return {
    first: words[0] ?? '',
    last: words[words.length - 1] ?? ''
  }
}
