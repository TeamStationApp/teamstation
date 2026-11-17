import {
  asArray,
  asEither,
  asNull,
  asNumber,
  asObject,
  asOptional,
  asString,
  asUnknown,
  type Cleaner
} from 'cleaners'

import { asLiteral } from '../asLiteral'
import {
  asPlayerNamePrivacy,
  type PlayerNamePrivacy
} from '../playerNamePrivacy'
import { asUserId, type UserId } from '../userId'

/**
 * What travels over the search socket at `/api/v1/search`, and the ask the
 * server's search engine answers.
 *
 * The client sends a `search` frame on every change to the typed text or the
 * chosen location, numbered by `seq`. The server answers each one at once
 * with the lexicographic `results`, and, a second after the typing pauses,
 * with Jev's re-ranked `results` for the latest `seq` only. A frame it cannot
 * read is answered with an `error`.
 */

/** The socket's path. */
export const SEARCH_SOCKET_PATH = '/api/v1/search'

/** The largest frame either side sends or reads, in bytes of JSON text. */
export const SEARCH_FRAME_MAX_BYTES = 4096

/** The most characters of typed text a search carries. */
export const SEARCH_TEXT_MAX = 200

/**
 * The most rows one answer holds, in either mode: Add Existing Player's
 * answer, people alone, is full at this many.
 */
export const SEARCH_RESULTS_MAX = 50

/** The longest id a frame carries. */
const ID_MAX = 128

/** The longest name, label or line a frame carries. */
const TEXT_MAX = 300

function asText(max: number): Cleaner<string> {
  return raw => {
    const text = asString(raw)
    if (text.length > max)
      throw new TypeError(`Expected at most ${max} characters`)
    return text
  }
}

function asWord(max: number): Cleaner<string> {
  const text = asText(max)
  return raw => {
    const value = text(raw)
    if (value.trim() === '') throw new TypeError('Expected a non-empty string')
    return value
  }
}

function asBounded(limit: number): Cleaner<number> {
  return raw => {
    const value = asNumber(raw)
    if (!Number.isFinite(value) || Math.abs(value) > limit)
      throw new TypeError(`Expected a number within ±${limit}`)
    return value
  }
}

/** A frame's sequence number: a non-negative safe integer. */
export const asSeq: Cleaner<number> = raw => {
  const value = asNumber(raw)
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError('Expected a non-negative integer seq')
  return value
}

/** What a location pill names. */
export type LocationKind = 'city' | 'region' | 'country'

/**
 * A place a search can be narrowed to: a catalog city, a region or a
 * country. Its id is `geonames:<id>` for a city, `region:<CC>:<region>` for
 * a region and `country:<CC>` for a country.
 */
export interface Location {
  kind: LocationKind
  id: string
  /** The pill's text, as `placeLabel` writes it. */
  label: string
  city?: string
  region?: string
  /** The ISO 3166 code: `US`. */
  country: string
  latitude?: number
  longitude?: number
}

/** A city's location id, from its places catalog id. */
export function cityLocationId(placeId: string): string {
  return `geonames:${placeId}`
}

/** A region's location id. */
export function regionLocationId(country: string, region: string): string {
  return `region:${country}:${region}`
}

/** A country's location id. */
export function countryLocationId(country: string): string {
  return `country:${country}`
}

const asCountryCode: Cleaner<string> = raw => {
  const code = asString(raw)
  if (!/^[A-Z]{2}$/.test(code))
    throw new TypeError('Expected an ISO 3166 country code')
  return code
}

const asLocationShape = asObject({
  kind: asLiteral('city', 'region', 'country'),
  id: asWord(ID_MAX + TEXT_MAX),
  label: asWord(TEXT_MAX),
  city: asOptional(asWord(TEXT_MAX)),
  region: asOptional(asWord(TEXT_MAX)),
  country: asCountryCode,
  latitude: asOptional(asBounded(90)),
  longitude: asOptional(asBounded(180))
})

/**
 * A location, checked: a city names its city, region and `geonames:` id, a
 * region its region and `region:` id, a country its `country:` id; and
 * latitude and longitude come together or not at all.
 */
export const asLocation: Cleaner<Location> = raw => {
  const shape = asLocationShape(raw)
  const location: Location = {
    kind: shape.kind,
    id: shape.id,
    label: shape.label,
    country: shape.country
  }
  if (shape.city != null) location.city = shape.city
  if (shape.region != null) location.region = shape.region
  if ((shape.latitude == null) !== (shape.longitude == null))
    throw new TypeError('Expected a latitude and a longitude together')
  if (shape.latitude != null && shape.longitude != null) {
    location.latitude = shape.latitude
    location.longitude = shape.longitude
  }
  switch (location.kind) {
    case 'city':
      if (location.city == null || location.region == null)
        throw new TypeError('Expected a city with its city and region')
      if (!/^geonames:[^:\s]+$/.test(location.id))
        throw new TypeError('Expected a geonames: id for a city')
      break
    case 'region':
      if (location.region == null)
        throw new TypeError('Expected a region with its region')
      if (location.id !== regionLocationId(location.country, location.region))
        throw new TypeError('Expected a region: id for a region')
      break
    case 'country':
      if (location.id !== countryLocationId(location.country))
        throw new TypeError('Expected a country: id for a country')
      break
  }
  return location
}

/**
 * Who a search looks for: everything (`all`), or only people (`people`),
 * as Add Existing Player asks for a team and maybe a game.
 */
export type SearchMode = 'all' | 'people'

/** One search, as the engine answers it. */
export interface SearchAsk {
  text: string
  location: Location | null
  mode: SearchMode
  /** In mode `people`: the team the person would be added to. */
  forTeam?: string
  /** In mode `people`, with `forTeam`: the game they would be added to. */
  forGame?: string
}

/** What kind of organization a group result is. */
export type SearchGroupKind = 'league' | 'season' | 'team'

/** A league, season or team found by a search. */
export interface SearchGroupResult {
  kind: SearchGroupKind
  id: string
  name: string
  imageUrl: string | null
  /** The middle line: a team's or season's city; null for a league. */
  cityLine: string | null
  /**
   * A team's seasons and leagues, a season's league, a league's city; empty
   * when there are none.
   */
  associations: string
  /**
   * The reader's Follow pill: `follow` or `following`; null when signed out
   * or on a group the reader belongs to.
   */
  follow: 'follow' | 'following' | null
}

/** How near a person found for Add Existing Player is, nearest first. */
export type SearchPersonTier = 'mine' | 'season' | 'league'

/**
 * What Add Existing Player's card needs of a person beside the row, carried
 * in mode `people` with `forTeam`: the fields of a `RosterCandidate` that a
 * person row does not already hold, built by the server's `rosterRows`, the
 * same as `GET /users?forTeam=` answers them.
 */
export interface SearchRosterFields {
  gumboId: number | null
  /** The name the reader is shown, in its format alone: `Jordan P`. */
  shortName: string
  /** The format of `shortName`, unless it is the built-in one. */
  nameFormat?: PlayerNamePrivacy
  /** The public name, when `shortName` is full only because of the reader. */
  compactName?: string
  /** The format of `compactName`, unless it is the built-in one. */
  compactFormat?: PlayerNamePrivacy
  /** The public label split where it was built. */
  shortParts: { first: string; last: string }
  bats: 'left' | 'right' | 'switch' | null
  throws: 'left' | 'right' | null
  /** The teams they play for in a current or future season, as seen. */
  teams: Array<{ teamId: string; name: string }>
  tier: SearchPersonTier
  /**
   * The typed words, folded, that found this person by a name the reader
   * may find them by: the words the phone keeps to find them again offline.
   * Absent when nothing typed found them.
   */
  matched?: string[]
}

/** A person found by a search, within the reader's reach. */
export interface SearchPersonResult {
  kind: 'person'
  userId: UserId
  /** The name the reader is shown. */
  name: string
  avatarUrl: string | null
  /** The `personAffiliations` text: guardian links and teams. */
  associations: string
  /** In mode `people` with `forTeam`: the card Add Existing Player draws. */
  roster?: SearchRosterFields
}

/** One row of a search's answer. */
export type SearchResult = SearchGroupResult | SearchPersonResult

const asNullable = <T>(cleaner: Cleaner<T>): Cleaner<T | null> =>
  asEither(asNull, cleaner)

export const asSearchGroupResult: Cleaner<SearchGroupResult> = asObject({
  kind: asLiteral('league', 'season', 'team'),
  id: asWord(ID_MAX),
  name: asText(TEXT_MAX),
  imageUrl: asNullable(asText(2048)),
  cityLine: asNullable(asText(TEXT_MAX)),
  associations: asText(1024),
  follow: asLiteral('follow', 'following', null)
})

const asSearchRosterShape = asObject({
  gumboId: asNullable(asNumber),
  shortName: asText(TEXT_MAX),
  nameFormat: asOptional(asPlayerNamePrivacy),
  compactName: asOptional(asText(TEXT_MAX)),
  compactFormat: asOptional(asPlayerNamePrivacy),
  shortParts: asObject({ first: asText(TEXT_MAX), last: asText(TEXT_MAX) }),
  bats: asLiteral('left', 'right', 'switch', null),
  throws: asLiteral('left', 'right', null),
  teams: asArray(asObject({ teamId: asWord(ID_MAX), name: asText(TEXT_MAX) })),
  tier: asLiteral('mine', 'season', 'league'),
  matched: asOptional(asArray(asText(TEXT_MAX)))
})

/** A person's roster fields, checked: absent optional fields stay absent. */
export const asSearchRosterFields: Cleaner<SearchRosterFields> = raw => {
  const shape = asSearchRosterShape(raw)
  const fields: SearchRosterFields = {
    gumboId: shape.gumboId,
    shortName: shape.shortName,
    shortParts: { first: shape.shortParts.first, last: shape.shortParts.last },
    bats: shape.bats,
    throws: shape.throws,
    teams: shape.teams.map(team => ({ teamId: team.teamId, name: team.name })),
    tier: shape.tier
  }
  if (shape.nameFormat != null) fields.nameFormat = shape.nameFormat
  if (shape.compactName != null) fields.compactName = shape.compactName
  if (shape.compactFormat != null) fields.compactFormat = shape.compactFormat
  if (shape.matched != null && shape.matched.length > 0)
    fields.matched = [...shape.matched]
  return fields
}

const asSearchPersonShape = asObject({
  kind: asLiteral('person'),
  userId: asUserId,
  name: asText(TEXT_MAX),
  avatarUrl: asNullable(asText(2048)),
  associations: asText(1024),
  roster: asOptional(asSearchRosterFields)
})

export const asSearchPersonResult: Cleaner<SearchPersonResult> = raw => {
  const shape = asSearchPersonShape(raw)
  const person: SearchPersonResult = {
    kind: 'person',
    userId: shape.userId,
    name: shape.name,
    avatarUrl: shape.avatarUrl,
    associations: shape.associations
  }
  if (shape.roster != null) person.roster = shape.roster
  return person
}

export const asSearchResult: Cleaner<SearchResult> = raw => {
  const kind = asObject({ kind: asString })(raw).kind
  return kind === 'person'
    ? asSearchPersonResult(raw)
    : asSearchGroupResult(raw)
}

/** The client's frame: one search, sent on every change. */
export interface SearchFrame extends SearchAsk {
  type: 'search'
  seq: number
}

const asSearchFrameShape = asObject({
  type: asLiteral('search'),
  seq: asSeq,
  text: asText(SEARCH_TEXT_MAX),
  location: asNullable(asLocation),
  mode: asLiteral('all', 'people'),
  forTeam: asOptional(asWord(ID_MAX)),
  forGame: asOptional(asWord(ID_MAX))
})

/**
 * A `search` frame, checked: `forTeam` only in mode `people`, and
 * `forGame` only with `forTeam`.
 */
export const asSearchFrame: Cleaner<SearchFrame> = raw => {
  const shape = asSearchFrameShape(raw)
  if (shape.forTeam != null && shape.mode !== 'people')
    throw new TypeError('Expected forTeam only in mode people')
  if (shape.forGame != null && shape.forTeam == null)
    throw new TypeError('Expected forGame only with forTeam')
  const frame: SearchFrame = {
    type: 'search',
    seq: shape.seq,
    text: shape.text,
    location: shape.location,
    mode: shape.mode
  }
  if (shape.forTeam != null) frame.forTeam = shape.forTeam
  if (shape.forGame != null) frame.forGame = shape.forGame
  return frame
}

/** The ask a `search` frame carries. */
export function askOfFrame(frame: SearchFrame): SearchAsk {
  const ask: SearchAsk = {
    text: frame.text,
    location: frame.location,
    mode: frame.mode
  }
  if (frame.forTeam != null) ask.forTeam = frame.forTeam
  if (frame.forGame != null) ask.forGame = frame.forGame
  return ask
}

/** Which ranking a `results` frame carries. */
export type SearchStage = 'lexicographic' | 'jev'

/** The server's answer to one `search` frame. */
export interface SearchResultsFrame {
  type: 'results'
  seq: number
  stage: SearchStage
  results: SearchResult[]
  locations: Location[]
}

/**
 * Why a frame was refused: `malformed`, a frame the server could not read;
 * `tooLarge`, one over `SEARCH_FRAME_MAX_BYTES`; `internal`, the server
 * failing, so asking again may work. In mode `people` with `forTeam`,
 * `notFound`, `forbidden` and `badRequest` are what the REST candidates
 * route answers for the same team and game: one the reader cannot see, one
 * they may not add players to, and a game the team does not play in.
 */
export type SearchErrorCode =
  | 'malformed'
  | 'tooLarge'
  | 'internal'
  | 'notFound'
  | 'forbidden'
  | 'badRequest'

/** Every `SearchErrorCode`. */
export const SEARCH_ERROR_CODES: readonly SearchErrorCode[] = [
  'malformed',
  'tooLarge',
  'internal',
  'notFound',
  'forbidden',
  'badRequest'
]

/** The server's refusal of a frame; `seq` when it could read one. */
export interface SearchErrorFrame {
  type: 'error'
  seq?: number
  code: SearchErrorCode
  message: string
}

/** What the server sends. */
export type SearchServerFrame = SearchResultsFrame | SearchErrorFrame

export const asSearchResultsFrame: Cleaner<SearchResultsFrame> = asObject({
  type: asLiteral('results'),
  seq: asSeq,
  stage: asLiteral('lexicographic', 'jev'),
  results: asArray(asSearchResult),
  locations: asArray(asLocation)
})

const asSearchErrorShape = asObject({
  type: asLiteral('error'),
  seq: asOptional(asSeq),
  code: asLiteral(...SEARCH_ERROR_CODES),
  message: asText(TEXT_MAX)
})

export const asSearchErrorFrame: Cleaner<SearchErrorFrame> = raw => {
  const shape = asSearchErrorShape(raw)
  const frame: SearchErrorFrame = {
    type: 'error',
    code: shape.code,
    message: shape.message
  }
  if (shape.seq != null) frame.seq = shape.seq
  return frame
}

export const asSearchServerFrame: Cleaner<SearchServerFrame> = raw => {
  const type = asObject({ type: asString })(raw).type
  return type === 'error' ? asSearchErrorFrame(raw) : asSearchResultsFrame(raw)
}

const asSearchResultsEnvelope = asObject({
  type: asLiteral('results'),
  seq: asSeq,
  stage: asLiteral('lexicographic', 'jev'),
  results: asArray(asUnknown),
  locations: asArray(asUnknown)
})

/** A row `searchServerFrameOf` left out, and why. */
export interface DroppedRow {
  list: 'results' | 'locations'
  index: number
  error: unknown
}

/**
 * What the server sent, as `asSearchServerFrame` reads it, except that a
 * results frame is read row by row: each result and location the cleaners
 * refuse is left out and handed to `dropped`, so one bad row never costs
 * the others. A frame whose own fields are wrong still throws.
 */
export function searchServerFrameOf(
  raw: unknown,
  dropped: (row: DroppedRow) => void
): SearchServerFrame {
  const type = asObject({ type: asString })(raw).type
  if (type === 'error') return asSearchErrorFrame(raw)
  const envelope = asSearchResultsEnvelope(raw)
  const rows = <T>(
    list: DroppedRow['list'],
    values: unknown[],
    clean: Cleaner<T>
  ): T[] =>
    values.flatMap((value, index) => {
      try {
        return [clean(value)]
      } catch (error) {
        dropped({ list, index, error })
        return []
      }
    })
  return {
    type: 'results',
    seq: envelope.seq,
    stage: envelope.stage,
    results: rows('results', envelope.results, asSearchResult),
    locations: rows('locations', envelope.locations, asLocation)
  }
}
