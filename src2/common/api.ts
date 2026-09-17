import {
  asArray,
  asBoolean,
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue,
  type Cleaner
} from 'cleaners'

import { type ApiError, asApiError, HttpError } from './errors'

/**
 * The client the app talks to the server through.
 *
 * Every response is cleaned here, not just on the server: the two ends check
 * the same shapes, so a server that starts sending something else fails loudly
 * in one place instead of making a screen render nonsense.
 */

/** The API sends `null` for an absent value, which `asOptional` will not take. */
const asNullable = <T>(cleaner: Cleaner<T>): Cleaner<T | null> =>
  asEither(asValue(null), cleaner)

export const asTeamSummary = asObject({
  id: asString,
  name: asString,
  shortName: asNullable(asString),
  logoPath: asNullable(asString),
  /**
   * Signed and short-lived. The app never builds one: only the server knows
   * where a picture lives and who may see it.
   */
  logoUrl: asOptional(asNullable(asString), null)
})
export type TeamSummary = ReturnType<typeof asTeamSummary>

export const asGameSummary = asObject({
  id: asString,
  homeTeamId: asString,
  awayTeamId: asString,
  homeTeamName: asString,
  awayTeamName: asString,
  seasonId: asNullable(asString),
  startAt: asNullable(asString),
  venue: asNullable(asString),
  status: asString,
  homeScore: asNullable(asNumber),
  awayScore: asNullable(asNumber),
  ingestStatus: asString,
  videoCount: asNumber
})
export type GameSummary = ReturnType<typeof asGameSummary>

export const asVideoSummary = asObject({
  id: asString,
  kind: asString,
  title: asString,
  status: asString,
  storage: asString,
  startAt: asNullable(asString),
  durationSec: asNullable(asNumber),
  width: asNullable(asNumber),
  height: asNullable(asNumber),
  codecs: asNullable(asString)
})
export type VideoSummary = ReturnType<typeof asVideoSummary>

export const asGameDetail = asObject({
  id: asString,
  homeTeamId: asString,
  awayTeamId: asString,
  homeTeamName: asString,
  awayTeamName: asString,
  seasonId: asNullable(asString),
  startAt: asNullable(asString),
  venue: asNullable(asString),
  status: asString,
  homeScore: asNullable(asNumber),
  awayScore: asNullable(asNumber),
  ingestStatus: asString,
  ingestMessage: asNullable(asString),
  videos: asArray(asVideoSummary)
})
export type GameDetail = ReturnType<typeof asGameDetail>

export const asHighlight = asObject({
  eventId: asString,
  atBatIndex: asNumber,
  title: asString,
  startOffsetSec: asNumber,
  playOffsetSec: asNumber,
  eventType: asNullable(asString),
  isScoringPlay: asBoolean,
  /** One frame of the video at the moment of the play. */
  stillUrl: asString
})
export type Highlight = ReturnType<typeof asHighlight>

export const asHighlightsResponse = asObject({
  withheld: asNullable(asString),
  highlights: asArray(asHighlight)
})
export type HighlightsResponse = ReturnType<typeof asHighlightsResponse>

const asRates = asObject({
  avg: asOptional(asNumber),
  obp: asOptional(asNumber),
  slg: asOptional(asNumber),
  ops: asOptional(asNumber)
})

export const asBattingRow = asObject({
  userId: asString,
  displayName: asOptional(asString),
  teamId: asNullable(asString),
  pa: asNumber,
  ab: asNumber,
  h: asNumber,
  singles: asNumber,
  doubles: asNumber,
  triples: asNumber,
  hr: asNumber,
  bb: asNumber,
  k: asNumber,
  hbp: asNumber,
  rbi: asNumber,
  rates: asRates
})
export type BattingRow = ReturnType<typeof asBattingRow>

export const asRosterEntry = asObject({
  userId: asString,
  displayName: asString,
  avatarUrl: asOptional(asNullable(asString), null),
  jersey: asNullable(asString),
  positions: asArray(asString),
  isPlayer: asBoolean,
  role: asString
})
export type RosterEntry = ReturnType<typeof asRosterEntry>

export const asStandingsRow = asObject({
  teamId: asString,
  teamName: asString,
  w: asNumber,
  l: asNumber,
  t: asNumber,
  runsFor: asNumber,
  runsAgainst: asNumber,
  played: asNumber,
  winningPct: asNullable(asNumber),
  runDifferential: asNumber
})
export type StandingsRow = ReturnType<typeof asStandingsRow>

export const asPlayback = asObject({
  videoId: asString,
  storage: asString,
  /** `null` when the row exists but its files do not. */
  url: asNullable(asString),
  expiresAt: asNullable(asString),
  durationSec: asNullable(asNumber),
  unavailable: asBoolean
})
export type Playback = ReturnType<typeof asPlayback>

export const asSeasonSummary = asObject({
  id: asString,
  /** Null until somebody creates a league and moves this season into it. */
  leagueId: asNullable(asString),
  name: asString,
  year: asNumber,
  term: asNullable(asString),
  ageGroup: asNullable(asString),
  teams: asNumber,
  games: asNumber,
  videos: asNumber
})
export type SeasonSummary = ReturnType<typeof asSeasonSummary>

export const asSeasonGame = asObject({
  id: asString,
  homeTeamId: asString,
  awayTeamId: asString,
  homeTeamName: asString,
  awayTeamName: asString,
  /** An opponent from outside the season: no roster, no team page. */
  homeTeamExternal: asBoolean,
  awayTeamExternal: asBoolean,
  seasonId: asNullable(asString),
  startAt: asNullable(asString),
  venue: asNullable(asString),
  status: asString,
  homeScore: asNullable(asNumber),
  awayScore: asNullable(asNumber),
  ingestStatus: asString,
  videoCount: asNumber
})
export type SeasonGame = ReturnType<typeof asSeasonGame>

export const asSession = asObject({
  token: asString,
  expiresAt: asString,
  user: asObject({
    id: asString,
    displayName: asString,
    email: asOptional(asString),
    isAdmin: asBoolean,
    /** Signed and short-lived, for the picture in the header. */
    avatarUrl: asOptional(asNullable(asString), null)
  })
})
export type Session = ReturnType<typeof asSession>

export interface ClientOptions {
  baseUrl: string
  token?: string
  /** Swapped out in tests. Defaults to the platform's own. */
  fetch?: typeof fetch
}

export class GameStationClient {
  private readonly baseUrl: string
  private readonly doFetch: typeof fetch
  token: string | undefined

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async signInWithPassword(email: string, password: string): Promise<Session> {
    const session = await this.request('POST', '/auth/password', asSession, {
      email,
      password
    })
    this.token = session.token
    return session
  }

  /** Always succeeds, whether or not the address has an account. */
  async requestEmailCode(email: string): Promise<void> {
    await this.request('POST', '/auth/email-code', asUnknownOk, { email })
  }

  async signInWithCode(email: string, code: string): Promise<Session> {
    const session = await this.request(
      'POST',
      '/auth/email-code/verify',
      asSession,
      { email, code }
    )
    this.token = session.token
    return session
  }

  async signOut(): Promise<void> {
    await this.request('POST', '/auth/logout', asUnknownOk)
    this.token = undefined
  }

  async teams(): Promise<TeamSummary[]> {
    return await this.request('GET', '/teams', asArray(asTeamSummary))
  }

  /** The seasons this person can see, which is what home leads with. */
  async seasons(): Promise<SeasonSummary[]> {
    return await this.request('GET', '/seasons', asArray(asSeasonSummary))
  }

  async seasonGames(seasonId: string): Promise<SeasonGame[]> {
    return await this.request(
      'GET',
      `/seasons/${encodeURIComponent(seasonId)}/games`,
      asArray(asSeasonGame)
    )
  }

  async seasonTeams(seasonId: string): Promise<TeamSummary[]> {
    return await this.request(
      'GET',
      `/seasons/${encodeURIComponent(seasonId)}/teams`,
      asArray(asTeamSummary)
    )
  }

  async teamGames(teamId: string): Promise<GameSummary[]> {
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/games`,
      asArray(asGameSummary)
    )
  }

  async game(gameId: string): Promise<GameDetail> {
    return await this.request(
      'GET',
      `/games/${encodeURIComponent(gameId)}`,
      asGameDetail
    )
  }

  async highlights(videoId: string): Promise<HighlightsResponse> {
    return await this.request(
      'GET',
      `/videos/${encodeURIComponent(videoId)}/highlights`,
      asHighlightsResponse
    )
  }

  /**
   * Where to play a video from, and for how long that answer is good.
   *
   * The app never builds a media URL itself: the server decides, because only
   * it knows whether the video is on its own disk, still in PeerTube's tree or
   * finished in the Space, and it checks membership while it is looking.
   */
  async playback(videoId: string): Promise<Playback> {
    return await this.request(
      'GET',
      `/videos/${encodeURIComponent(videoId)}/playback`,
      asPlayback
    )
  }

  async boxScore(gameId: string): Promise<BattingRow[]> {
    return await this.request(
      'GET',
      `/games/${encodeURIComponent(gameId)}/box-score`,
      asArray(asBattingRow)
    )
  }

  async roster(teamId: string): Promise<RosterEntry[]> {
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/roster`,
      asArray(asRosterEntry)
    )
  }

  /** A team's batting for a season, or across every season when unset. */
  async teamStats(teamId: string, seasonId?: string): Promise<BattingRow[]> {
    const query =
      seasonId == null ? '' : `?seasonId=${encodeURIComponent(seasonId)}`
    return await this.request(
      'GET',
      `/teams/${encodeURIComponent(teamId)}/stats${query}`,
      asArray(asBattingRow)
    )
  }

  async standings(seasonId: string): Promise<StandingsRow[]> {
    return await this.request(
      'GET',
      `/seasons/${encodeURIComponent(seasonId)}/standings`,
      asArray(asStandingsRow)
    )
  }

  private async request<T>(
    method: string,
    path: string,
    cleaner: Cleaner<T>,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.token != null) headers.authorization = `Bearer ${this.token}`

    // `fetch` rejects with a bare TypeError when the request never leaves the
    // device — no data, aeroplane mode, a captive portal at the field. Safari
    // words that "Load failed", Chrome "Failed to fetch", and either one
    // reaching a parent reads as "the site is broken" when the site is fine.
    // The distinction is worth keeping: this app is used on a phone at the edge
    // of a ball field, where no signal is the ordinary case, not the exception.
    let response: Response
    try {
      response = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    } catch (caught: unknown) {
      throw new HttpError(
        'offline',
        'Cannot reach GameStation. Check your connection and try again.'
      )
    }

    const text = await response.text()
    if (!response.ok) throw errorFrom(response.status, text)
    if (text === '') return cleaner(undefined)

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new HttpError('internal', 'The server sent something unreadable')
    }
    return cleaner(parsed)
  }
}

/** For the endpoints whose body carries nothing a caller needs. */
const asUnknownOk: Cleaner<null> = () => null

/**
 * Turns a failed response back into the same `HttpError` the server threw, so
 * a caller can branch on `code` rather than on a status number.
 */
function errorFrom(status: number, text: string): HttpError {
  let api: ApiError | undefined
  try {
    api = asApiError(JSON.parse(text))
  } catch {
    api = undefined
  }
  if (api != null) return new HttpError(api.code, api.message, api.details)
  return new HttpError('internal', `The server answered ${status}`)
}
