import { asMaybe, asValue } from 'cleaners'

/**
 * How a player's name is written for anyone who may not read the stored full
 * name. A league, season or team stores one of these, or nothing: Default,
 * which is not the same as `firstLastInitial`, because it keeps inheriting.
 */
export const PLAYER_NAME_PRIVACY = [
  'firstLastInitial',
  'initialLast',
  'initials',
  'full'
] as const

export type PlayerNamePrivacy = (typeof PLAYER_NAME_PRIVACY)[number]

export const asPlayerNamePrivacy = asValue(...PLAYER_NAME_PRIVACY)

/** A stored value, read leniently: anything else is Default. */
export const asStoredPlayerNamePrivacy = asMaybe(asPlayerNamePrivacy, null)

/** What applies when nothing above a level says otherwise. */
export const DEFAULT_PLAYER_NAME_PRIVACY: PlayerNamePrivacy = 'firstLastInitial'

export const PLAYER_NAME_PRIVACY_LABELS: Record<PlayerNamePrivacy, string> = {
  firstLastInitial: 'First name, last initial',
  initialLast: 'First initial, last name',
  initials: 'First initial, last initial',
  full: 'Full name'
}

export const DEFAULT_PRIVACY_LABEL = 'Default'

/** The wheel's stops, from the top. */
export const PLAYER_NAME_PRIVACY_STOPS: ReadonlyArray<PlayerNamePrivacy | null> =
  [null, 'firstLastInitial', 'initialLast', 'initials', 'full']

/**
 * Most restrictive first. `initialLast` is less restrictive than
 * `firstLastInitial` because it publishes the surname, which is what the
 * built-in format exists to withhold.
 */
const RESTRICTIVENESS: readonly PlayerNamePrivacy[] = [
  'initials',
  'firstLastInitial',
  'initialLast',
  'full'
]

/** The most restrictive of `formats`, or the built-in format for none. */
export function mostRestrictive(
  formats: Iterable<PlayerNamePrivacy>
): PlayerNamePrivacy {
  const given = new Set(formats)
  return (
    RESTRICTIVENESS.find(format => given.has(format)) ??
    DEFAULT_PLAYER_NAME_PRIVACY
  )
}

/**
 * The format of a name on a path any reader can reach and a model also
 * receives, narration and Tess: never a surname, and never a first name the
 * public format withholds.
 */
export function spokenFormat(format: PlayerNamePrivacy): PlayerNamePrivacy {
  return format === 'initials' || format === 'initialLast'
    ? 'initials'
    : 'firstLastInitial'
}

export interface PlayerNamePrivacySource {
  kind: 'league' | 'season' | 'team'
  id: string
  name: string
  value: PlayerNamePrivacy | null
}

export interface ResolvedPlayerNamePrivacy {
  format: PlayerNamePrivacy
  stored: PlayerNamePrivacy | null
  /** The closest level whose explicit value won; both, when two tied. */
  inheritedFrom: Array<Pick<PlayerNamePrivacySource, 'kind' | 'id' | 'name'>>
}

/** Sources that stored a value, the most restrictive answered and named. */
function winnerOf(
  sources: readonly PlayerNamePrivacySource[]
): Omit<ResolvedPlayerNamePrivacy, 'stored'> | undefined {
  const voting = sources.filter(source => source.value != null)
  if (voting.length === 0) return undefined
  const format = mostRestrictive(voting.map(source => source.value!))
  return {
    format,
    inheritedFrom: voting
      .filter(source => source.value === format)
      .sort((a, b) =>
        a.name.localeCompare(b.name) !== 0
          ? a.name.localeCompare(b.name)
          : a.id < b.id
            ? -1
            : 1
      )
      .map(({ kind, id, name }) => ({ kind, id, name }))
  }
}

/**
 * A level's effective format. Its own value wins outright. Otherwise the
 * managing seasons vote, and a season on Default does not; only when none of
 * them has a value do the managing leagues, the same way. A closer explicit
 * value replaces a further one, including a more restrictive one.
 */
export function resolvePlayerNamePrivacy(sources: {
  self: PlayerNamePrivacySource
  managingSeasons: readonly PlayerNamePrivacySource[]
  managingLeagues: readonly PlayerNamePrivacySource[]
}): ResolvedPlayerNamePrivacy {
  const { self, managingSeasons, managingLeagues } = sources
  const stored = self.value
  if (stored != null) return { format: stored, stored, inheritedFrom: [] }
  const winner = winnerOf(managingSeasons) ?? winnerOf(managingLeagues)
  return {
    format: winner?.format ?? DEFAULT_PLAYER_NAME_PRIVACY,
    stored: null,
    inheritedFrom: winner?.inheritedFrom ?? []
  }
}
