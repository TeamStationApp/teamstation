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
  logoPath: asNullable(asString)
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
  isScoringPlay: asBoolean
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

export const asSession = asObject({
  token: asString,
  expiresAt: asString,
  user: asObject({
    id: asString,
    displayName: asString,
    email: asOptional(asString),
    isAdmin: asBoolean
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

  async boxScore(gameId: string): Promise<BattingRow[]> {
    return await this.request(
      'GET',
      `/games/${encodeURIComponent(gameId)}/box-score`,
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

    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })

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
