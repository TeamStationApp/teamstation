/** Enough of a player to write his roster or lineup card. */
export interface RosterNamePlayer {
  jersey: string
  fullName: string
  firstName?: string
  lastName?: string
}

/** A card's two lines: the slot, jersey and first name, then the last name. */
export interface RosterNameLines {
  first: string
  last: string
}

/**
 * A roster or lineup card's name, split where it may wrap: `1. #27 Trea` and
 * `Turner`. The last name is the player's own when the name ends with it,
 * else the name's last word; a one-word name has none. `prefix` is the
 * lineup's slot.
 */
export function rosterNameLines(
  player: RosterNamePlayer,
  prefix?: string
): RosterNameLines {
  const name = player.fullName.trim().replace(/\s+/g, ' ')
  const lastName = (player.lastName ?? '').trim().replace(/\s+/g, ' ')
  let given = name
  let last = ''
  if (
    lastName !== '' &&
    name.length > lastName.length &&
    name.endsWith(` ${lastName}`)
  ) {
    given = name.slice(0, name.length - lastName.length - 1)
    last = lastName
  } else {
    const space = name.lastIndexOf(' ')
    if (space > 0) {
      given = name.slice(0, space)
      last = name.slice(space + 1)
    }
  }
  const jersey = player.jersey.trim()
  const first = [prefix?.trim() ?? '', jersey === '' ? '' : `#${jersey}`, given]
    .filter(part => part !== '')
    .join(' ')
  return { first, last }
}
