/**
 * How a person's name is written anywhere in the app: first name, last
 * initial. `Jordan P`.
 *
 * The full name is stored — it is what the import sent, what a parent would
 * search for, and what an admin needs to tell two children apart — but it is
 * not what gets drawn for everybody. It goes only to the people
 * `maySeeFullName` names on the server: a coach or an administrator of the
 * player's team, a parent, the player, and a site administrator.
 */

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
 * `Jordan`, `Pujols` → `Jordan Pujols`: both halves as stored, or the display name
 * for somebody imported before there were halves.
 */
export function fullName(person: NamedPerson): string {
  const first = (person.firstName ?? '').trim()
  const last = (person.lastName ?? '').trim()
  if (first === '' && last === '') return person.displayName.trim()
  return [first, last].filter(half => half !== '').join(' ')
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
