import type { MatchKind } from '../../common/search/match'
import type { Location, LocationKind } from '../../common/search/types'

/**
 * Jev re-ranks a search: TypeSafe's System One model, which answers typed
 * questions about a `state` rather than writing text. One request asks a
 * `noul` question per candidate and per location pill, each named by its
 * key, and the answer's nouls order them, highest first.
 *
 * Jev is an improvement, never a dependency: with no key, a non-200 (a 429
 * or 529 is not retried), a timeout or an answer that does not read,
 * `jevRank` is null and the lexicographic answer stands. The key is sent
 * only in the Authorization header and never logged.
 */

/** Where TypeSafe serves System One, unless `serverConfig.jev.baseUrl` says otherwise. */
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai'

/** The model asked for. The answer names the version that answered. */
export const JEV_MODEL = 'jev-latest'

/** How long a ranking may take before the lexicographic answer stands. */
export const JEV_TIMEOUT_MS = 3000

/** The most candidates and location pills a ranking keeps. */
export const JEV_MAX_CANDIDATES = 50
export const JEV_MAX_LOCATIONS = 4

/** What Jev reads about one result candidate, as `jevFacts` gathers it. */
export interface JevCandidateFacts {
  kind: 'league' | 'season' | 'team' | 'person'
  /**
   * The name. A person's is the one `runSpoken(readerNaming)` gives, the
   * narrowed name models get, never more than the reader is shown.
   */
  name: string
  /** The group's place: its city, region and country, and the pill label of it. */
  city?: string
  region?: string
  /** The ISO 3166 code: `US`. */
  country?: string
  placeLabel?: string
  /** Each typed word, in typed order, and how it matched; null for none. */
  words: Array<{ word: string; match: MatchKind | null }>
  /** The name characters the typed words matched, over all of them: 0 to 1. */
  coverage: number
  /** A group's most recent game or team event, `YYYY-MM-DD`. */
  lastActivityOn?: string
  /** A season's dates, `YYYY-MM-DD`. */
  startsOn?: string
  endsOn?: string
  /** With a city pill, the miles from that city. */
  milesAway?: number
  /** How the reader is tied to the candidate. */
  ties: {
    /** The reader belongs to the group. */
    member?: boolean
    /** The reader follows the group. */
    follows?: boolean
    /** The person shares a team with the reader. */
    sharesTeam?: boolean
    /** The reader is the person's guardian. */
    guardian?: boolean
    /** Mode `people`: the person is in the target team's season. */
    inTargetSeason?: boolean
    /** Mode `people`: the person is in the target team's league. */
    inTargetLeague?: boolean
  }
}

/** What Jev reads about one suggested location pill. */
export interface JevLocationFacts {
  kind: LocationKind
  label: string
  city?: string
  region?: string
  country: string
  population?: number
}

/** The `state` a ranking request carries. */
export interface JevState {
  /** The typed text. */
  query: string
  /** The chosen location pill, or null. */
  location: Location | null
  /** The reader's date, `YYYY-MM-DD`. */
  today: string
  /**
   * The candidates keyed `c1`…`cN`, in lexicographic order: Jev's ties keep
   * that order.
   */
  candidates: Record<string, JevCandidateFacts>
  /** The location pills keyed `l1`…`lN`, in lexicographic order. */
  locations: Record<string, JevLocationFacts>
  /**
   * Roughly where the reader is (`City, RG`: their own groups' area, or
   * their IP address's city), or null when it is not known.
   */
  reader: { place: string | null }
}

export interface JevRanking {
  /** Candidate keys, best first, at most `JEV_MAX_CANDIDATES`. */
  order: string[]
  /** Location keys, best first, at most `JEV_MAX_LOCATIONS`. */
  locations: string[]
  /** The model version that answered. */
  model: string
}

export interface JevOptions {
  timeoutMs?: number
  /** Where the answering model's version is written. */
  log?: (line: string) => void
}

interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria: { true: string; false: string }
}

const CANDIDATE_TRUE =
  'The name matches the typed words closely (a perfect word match over starts-with over substring, more typed words over fewer, a name the query covers more fully), and the candidate is active recently: a team or season with events this year, a current season, a group inside the chosen location or near it, or a group or person the user is connected to.'
const CANDIDATE_FALSE =
  'A weak or partial name match, or a team or season whose last event was years ago, a past season, or a place far from the chosen location.'
const LOCATION_TRUE =
  'The place name matches the typed words closely (a perfect word match over starts-with over substring, more typed words over fewer), and it is the well-known or more populous place of that name. Among places that match equally well, one near the reader (`reader.place`) ranks first.'
const LOCATION_FALSE =
  'A weak or partial name match, or a small place that shares its name with a better-known one.'

/** One noul question per candidate and per location, named by its key. */
export function jevQuestions(state: JevState): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {}
  for (const key of Object.keys(state.candidates))
    questions[key] = {
      type: 'noul',
      instructions: `Is candidate \`${key}\` one of the results this user most likely wants for the search \`query\`?`,
      criteria: { true: CANDIDATE_TRUE, false: CANDIDATE_FALSE }
    }
  for (const key of Object.keys(state.locations))
    questions[key] = {
      type: 'noul',
      instructions: `Is location \`${key}\` the place this user means by the search \`query\`?`,
      criteria: { true: LOCATION_TRUE, false: LOCATION_FALSE }
    }
  return questions
}

/**
 * Rank a search's candidates and location pills with Jev. Null with no key,
 * nothing to rank, a non-200, a timeout (`JEV_TIMEOUT_MS`), the caller's
 * signal aborting, or an answer missing any noul asked for.
 */
export async function jevRank(
  state: JevState,
  key: string | null | undefined,
  baseUrl: string,
  signal?: AbortSignal,
  options: JevOptions = {}
): Promise<JevRanking | null> {
  if (key == null || key === '') return null
  const candidateKeys = Object.keys(state.candidates)
  const locationKeys = Object.keys(state.locations)
  if (candidateKeys.length + locationKeys.length === 0) return null
  const timeout = AbortSignal.timeout(options.timeoutMs ?? JEV_TIMEOUT_MS)
  const composed = signal == null ? timeout : AbortSignal.any([signal, timeout])
  let raw: unknown
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/+$/, '')}/v1/systemone`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: JEV_MODEL,
          state,
          questions: jevQuestions(state)
        }),
        signal: composed
      }
    )
    if (response.status !== 200) {
      // Read nothing more; the body may echo the request.
      await response.body?.cancel().catch(() => undefined)
      return null
    }
    raw = await response.json()
  } catch {
    return null
  }
  const answer = readAnswer(raw, [...candidateKeys, ...locationKeys])
  if (answer == null) return null
  ;(options.log ?? console.log)(`jev: ranked by ${answer.model}`)
  return {
    order: byNoul(candidateKeys, answer.nouls).slice(0, JEV_MAX_CANDIDATES),
    locations: byNoul(locationKeys, answer.nouls).slice(0, JEV_MAX_LOCATIONS),
    model: answer.model
  }
}

/** The keys by noul, highest first; a tie keeps the keys' own order. */
function byNoul(keys: string[], nouls: Map<string, number>): string[] {
  return keys
    .map((key, index) => ({ key, index, noul: nouls.get(key) ?? 0 }))
    .sort((a, b) => (b.noul !== a.noul ? b.noul - a.noul : a.index - b.index))
    .map(entry => entry.key)
}

function readAnswer(
  raw: unknown,
  keys: string[]
): { model: string; nouls: Map<string, number> } | null {
  if (!isRecord(raw)) return null
  const { model, answers } = raw
  if (typeof model !== 'string' || model === '' || !isRecord(answers))
    return null
  const nouls = new Map<string, number>()
  for (const key of keys) {
    const entry = answers[key]
    if (!isRecord(entry) || entry.type !== 'noul') return null
    const noul = entry.noul
    if (typeof noul !== 'number' || !Number.isFinite(noul)) return null
    if (noul < 0 || noul > 1) return null
    nouls.set(key, noul)
  }
  return { model, nouls }
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw)
}
