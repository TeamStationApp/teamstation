import { mostRestrictive, type PlayerNamePrivacy } from './playerNamePrivacy'

/**
 * How a person's name is written anywhere in the app: first name, last
 * initial, `Jordan P`, unless the player's league, season or team has chosen
 * another public format (`playerNamePrivacy.ts`), which only the server picks.
 *
 * The full name is stored — it is what the import sent, what a parent would
 * search for, and what an admin needs to tell two children apart. The API
 * sends it to nobody except whoever may see it — `mayViewFullNames` on the
 * server: whoever may edit it (`mayEditName`: a guardian, the player, a site
 * administrator, and an administrator, coach, assistant or scorekeeper of a
 * team the player plays for, set on the team or carried down from its season
 * or league, or that team's owner or manager), and an administrator, coach
 * or assistant of a level whose people list holds the person. To them every
 * read that names the person to them names them in full. Its halves, which
 * are for changing it, come through `GET /players/:userId/name` and a roster
 * read with `includeFullNames` by the team's roster managers.
 * A songkeeper or videographer never reads it, and nothing that goes to
 * somebody else — the live board, mail, push, a stored document, a model —
 * carries it.
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
 * the last. `Jordan P` → `Jordan`, `P`. The add-to-roster form shows the two
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
 * Short names for a list: each person once, by id, and each name as
 * `shortName` writes it alone. Two people whose names shorten the same read
 * the same; nothing adds letters to tell them apart.
 */
export function shortNames(
  people: NamedPerson[]
): Map<string | number, string> {
  const result = new Map<string | number, string>()
  for (const person of people) {
    if (!result.has(person.id)) result.set(person.id, shortName(person))
  }
  return result
}

/**
 * `Alex Lee` as the public format writes it: `Alex L`, `A Lee`, `A L` or
 * `Alex Lee`. No period after an initial, and a missing half is left out.
 */
export function formatName(
  person: NamedPerson,
  format: PlayerNamePrivacy
): string {
  if (format === 'full') return fullName(person)
  if (fullName(person) === DELETED_NAME) return DELETED_NAME
  if (format === 'firstLastInitial') return shortName(person)
  const { first, last } = halves(person)
  const shownLast = format === 'initialLast' ? last : last.slice(0, 1)
  return `${first.slice(0, 1)} ${shownLast}`.trim()
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

/**
 * Public names for a list, each name in its format alone (`formatName`), or
 * as a model is given it (`modelLabel`) when the list is `spoken`. Somebody
 * who appears twice in two formats is written once, in the more restrictive.
 * Two people whose names format the same read the same: nothing adds letters
 * to tell them apart, so no name ever says more than its format allows.
 */
export function formatNames(
  entries: readonly FormattedPerson[],
  options: { spoken?: boolean } = {}
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
  const write = options.spoken === true ? modelLabel : formatName
  return new Map(
    [...unique.values()].map(entry => [
      entry.person.id,
      write(entry.person, entry.format)
    ])
  )
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
