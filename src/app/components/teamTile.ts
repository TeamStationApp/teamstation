import { initialsOf, personInitialsOf } from './initials'

/**
 * The tile a team without a logo is drawn with: two capital letters on a
 * colour of its own.
 */

/**
 * `Badgers (Ripken)` → `BR`, `Badgers` → `BA`.
 *
 * The first letter of each of the first two words; a name of one word gives
 * its first two letters, so a one-word team still fills the tile. Anything
 * that is not a letter or a digit — brackets, full stops, apostrophes — is
 * dropped first, so it can neither be an initial nor make a word of its own.
 *
 * Not `initialsOf`, which is a person's: a person called `Paul` is `P`.
 */
export function teamInitialsOf(name: string): string {
  const words = name
    .split(/[\s-]+/)
    .map(word => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(word => word.length > 0)
  const letters =
    words.length === 1
      ? Array.from(words[0]).slice(0, 2).join('')
      : words
          .slice(0, 2)
          .map(word => Array.from(word)[0])
          .join('')
  return letters.toUpperCase()
}

/**
 * Thirty-two colours a tile can be, each dark enough under white letters to read
 * at 4.5:1 or better.
 */
export const TEAM_TINTS = [
  '#B91C1C', // red
  '#C2410C', // orange
  '#B45309', // amber
  '#15803D', // green
  '#0F766E', // teal
  '#1D4ED8', // blue
  '#6D28D9', // violet
  '#BE185D', // pink
  '#991B1B',
  '#9A3412',
  '#92400E',
  '#166534',
  '#115E59',
  '#1E40AF',
  '#5B21B6',
  '#9D174D',
  '#7F1D1D',
  '#7C2D12',
  '#78350F',
  '#14532D',
  '#134E4A',
  '#1E3A8A',
  '#4C1D95',
  '#831843',
  '#9F1239',
  '#854D0E',
  '#3F6212',
  '#065F46',
  '#155E75',
  '#075985',
  '#3730A3',
  '#86198F'
] as const

/**
 * One of `TEAM_TINTS`, by a 32-bit FNV-1a hash of `key`.
 *
 * The same key gives the same colour on every visit, every screen and every
 * platform, so the key is an id, which a rename leaves alone.
 */
function tintOf(key: string): string {
  let hash = 0x811c9dc5
  for (const unit of Array.from(key)) {
    const code = unit.codePointAt(0) ?? 0
    hash ^= code
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return TEAM_TINTS[hash % TEAM_TINTS.length]
}

/**
 * A team's tile colour, by its id. A merged team's rows carry the id of the
 * team it became, so it draws that team's colour.
 */
export function teamTint(teamId: string): string {
  return tintOf(teamId)
}

/** A league's tile colour, by its id. */
export function leagueTint(leagueId: string): string {
  return tintOf(leagueId)
}

/**
 * A season's tile colour: its league's, so every season of a league reads as
 * that league, or by its own id when it has no league.
 */
export function seasonTint(season: {
  id: string
  leagueId?: string | null
}): string {
  return season.leagueId != null && season.leagueId !== ''
    ? leagueTint(season.leagueId)
    : tintOf(season.id)
}

/**
 * The picture a season is drawn with: its own, or else its league's, or null
 * for initials on `seasonTint`.
 */
export function seasonPicture(season: {
  pictureUrl?: string | null
  leaguePictureUrl?: string | null
}): string | null {
  if (season.pictureUrl != null && season.pictureUrl !== '')
    return season.pictureUrl
  if (season.leaguePictureUrl != null && season.leaguePictureUrl !== '')
    return season.leaguePictureUrl
  return null
}

/**
 * A person's tile colour, by their primary account id alone (the survivor a
 * merged account resolves to, which every answer carries): one colour for
 * every reader, on every list and every team, and no name goes into it. A
 * missing or empty id gets none, the theme's neutral tile.
 */
export function personTint(
  userId: string | null | undefined
): string | undefined {
  return userId == null || userId === '' ? undefined : tintOf(userId)
}

/**
 * A person's tile without a photo: the initials of the name the row shows
 * the reader (`personInitialsOf`), on their account's colour (`personTint`).
 */
export function personTile(person: { userId: string; name: string }): {
  initials: string
  tint: string | undefined
} {
  return {
    initials: personInitialsOf(person.name),
    tint: personTint(person.userId)
  }
}

/** A team, league or season, as its tile draws it. */
export interface GroupTileSource {
  kind: 'team' | 'league' | 'season'
  /** Null only for a group not saved yet: the theme's untinted tile. */
  id: string | null
  /** A season's league. */
  leagueId?: string | null
  name: string
  /** The group's own picture. */
  uri?: string | null
  /** A season's league's picture. */
  leagueUri?: string | null
}

/** What a group's tile shows. */
export interface GroupTile {
  initials: string
  /** None before the group has an id. */
  tint: string | undefined
  uri: string | null
}

/** A saved team's, league's or season's colour, by its id. */
export function groupTint(
  group: Pick<GroupTileSource, 'kind' | 'leagueId'> & { id: string }
): string {
  return group.kind === 'team'
    ? teamTint(group.id)
    : group.kind === 'league'
      ? leagueTint(group.id)
      : seasonTint({ id: group.id, leagueId: group.leagueId })
}

/**
 * What a group's tile shows: its initials, its colour and its picture. One
 * answer for every surface, chat included, so a team, league or season is the
 * same tile everywhere.
 */
export function groupTile(group: GroupTileSource): GroupTile {
  const name = group.name.trim()
  const { id, kind } = group
  const tint = id == null ? undefined : groupTint({ ...group, id })
  if (kind === 'team') {
    const initials = teamInitialsOf(name)
    return {
      initials: initials === '' ? 'T' : initials,
      tint,
      uri: group.uri ?? null
    }
  }
  const initials = initialsOf(name)
  return {
    initials: initials === '' ? (kind === 'league' ? 'L' : 'S') : initials,
    tint,
    uri:
      kind === 'league'
        ? (group.uri ?? null)
        : seasonPicture({
            pictureUrl: group.uri,
            leaguePictureUrl: group.leagueUri
          })
  }
}
