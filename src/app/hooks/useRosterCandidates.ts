import { asArray, asMaybe, asString, type Cleaner } from 'cleaners'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'

import {
  asRosterCandidate,
  ROSTER_CANDIDATE_MAX,
  type RosterCandidate,
  type TeamStationClient
} from '../../common/api'
import { HttpError, unauthorized } from '../../common/errors'
import { SEARCH_TEXT_MAX, type SearchResult } from '../../common/search/types'
import type {
  SearchSocket,
  SearchSocketStatus
} from '../../common/searchSocket'
import { candidatesKey, foundWords, searchWords } from '../sync/documentKeys'
import {
  makeSearchSocket,
  SearchSocketFactoryContext
} from './searchSocketFactory'
import { useDebouncedValue } from './useDebouncedValue'

/**
 * How long typing must pause before `GET /users?forTeam=` is asked, where
 * there is no search socket: one request per settled search. The socket is
 * asked on every change, with no pause: the engine answers at once, and an
 * answer for older typing never arrives.
 */
export const CANDIDATE_DEBOUNCE_MS = 500

export interface RosterCandidates {
  rows: RosterCandidate[]
  /** The current search's answer is on its way, with nothing shown yet. */
  loading: boolean
  /** The server's answer is on its way under the phone's rows. */
  updating: boolean
  /** Why the search failed; the phone's rows shown stay. */
  error?: string
  /**
   * The server answered as many as one search answers
   * (`ROSTER_CANDIDATE_MAX`): more may match, and typing more narrows them.
   */
  capped: boolean
  /** The client cannot reach the server, so nothing is asked. */
  offline: boolean
  /** The search the rows answer (over HTTP, once typing settles). */
  query: string
  retry: () => void
}

/**
 * A person the phone keeps for a team, with the words of the searches that
 * found him (`matched`): the server matched each to the start of one of his
 * names, which his short name (`Jordan Q`) may not show.
 */
export type KeptCandidate = RosterCandidate & { matched?: string[] }

/** A kept person as the phone stored him, his search words with him. */
const asKeptCandidate: Cleaner<KeptCandidate> = raw => {
  const candidate = asRosterCandidate(raw)
  const matched = asMaybe(asArray(asString))(
    raw != null && typeof raw === 'object'
      ? (raw as { matched?: unknown }).matched
      : undefined
  )
  return matched == null || matched.length === 0
    ? candidate
    : { ...candidate, matched }
}

/**
 * Whether a person the phone keeps answers `query`, as the server matches:
 * each word starts one of his shown names, or starts a word of a search the
 * server already found him by (a name of his that starts with that word
 * starts with this one too).
 */
export function candidateMatches(
  candidate: KeptCandidate,
  query: string
): boolean {
  const words = searchWords(query)
  if (words.length === 0) return true
  const names = [
    candidate.shortName,
    candidate.shortParts.first,
    candidate.shortParts.last,
    ...(candidate.matched ?? [])
  ]
    .join(' ')
    .toLowerCase()
    .split(/\s+/)
  return words.every(word => names.some(name => name.startsWith(word)))
}

/** A kept person as a row to list, without his search words. */
function listedRow(candidate: KeptCandidate): RosterCandidate {
  if (candidate.matched == null) return candidate
  const { matched: _matched, ...row } = candidate
  return row
}

/**
 * The people each client's searches found this session, by the session's
 * token and the team: the scoring screen's at-once list where the client
 * keeps no file (the web), and before the phone's file is read.
 */
const found = new WeakMap<object, Map<string, KeptCandidate[]>>()

function foundFor(client: TeamStationClient, teamId: string): KeptCandidate[] {
  return found.get(client)?.get(`${client.token ?? ''} ${teamId}`) ?? []
}

/**
 * A row of an answer to `query`, with the words of it that found him
 * (`matched`, none kept when empty): the words the server says did
 * (`found`, folded). A search keeps anybody any one typed word finds.
 */
export function withMatched(
  row: RosterCandidate,
  query: string,
  found: readonly string[]
): KeptCandidate {
  const words = foundWords(query, found)
  return words.length === 0 ? row : { ...row, matched: words }
}

/**
 * Keeps `rows`, an answer, as found for `teamId`, newest first and each
 * once, each with the words that found him.
 */
function keepFound(
  client: TeamStationClient,
  teamId: string,
  rows: readonly KeptCandidate[]
): void {
  if (rows.length === 0) return
  const byTeam = found.get(client) ?? new Map<string, KeptCandidate[]>()
  found.set(client, byTeam)
  const key = `${client.token ?? ''} ${teamId}`
  byTeam.set(key, merged(rows, byTeam.get(key) ?? []).slice(0, 500))
}

/**
 * Forgets `userId` from the people found for `teamId`, kept in memory and on
 * the phone: once he is added he is no longer somebody to add.
 */
export function forgetFound(
  client: TeamStationClient,
  teamId: string,
  userId: string
): void {
  const byTeam = found.get(client)
  const key = `${client.token ?? ''} ${teamId}`
  const rows = byTeam?.get(key)
  if (rows != null)
    byTeam!.set(
      key,
      rows.filter(row => row.userId !== userId)
    )
}

/**
 * `first`, then each of `then` it does not list, by user id. A person in
 * both keeps the search words of both.
 */
function merged<T extends KeptCandidate>(
  first: readonly T[],
  then: readonly T[]
): T[] {
  const later = new Map(then.map(row => [row.userId, row]))
  const listed = new Set(first.map(row => row.userId))
  return [
    ...first.map(row => {
      const words = [
        ...new Set([
          ...(row.matched ?? []),
          ...(later.get(row.userId)?.matched ?? [])
        ])
      ]
      return words.length === (row.matched?.length ?? 0)
        ? row
        : { ...row, matched: words }
    }),
    ...then.filter(row => !listed.has(row.userId))
  ]
}

/** What a search says when the session is refused: the route's 401. */
const SIGNED_OUT_PROBLEM = unauthorized().message

function problemOf(error: unknown): string {
  return error instanceof HttpError
    ? error.message
    : 'Unable to load players. Please try again.'
}

/**
 * The card of a person row of a search in mode `people` with `forTeam`, as
 * `GET /users?forTeam=` answers it; null for any other row.
 */
export function rosterCandidateOf(
  result: SearchResult
): RosterCandidate | null {
  if (result.kind !== 'person' || result.roster == null) return null
  const card = result.roster
  return {
    userId: result.userId,
    gumboId: card.gumboId,
    externalIds: [],
    shortName: card.shortName,
    ...(card.nameFormat == null ? {} : { nameFormat: card.nameFormat }),
    ...(card.compactName == null ? {} : { compactName: card.compactName }),
    ...(card.compactFormat == null
      ? {}
      : { compactFormat: card.compactFormat }),
    shortParts: card.shortParts,
    avatarUrl: result.avatarUrl,
    bats: card.bats,
    throws: card.throws,
    teams: card.teams,
    affiliations: result.associations,
    tier: card.tier
  }
}

/** An answer, with the search it answers. */
interface Answer {
  query: string
  rows: RosterCandidate[]
}

/** What one source of candidates says about the search typed now. */
interface Source {
  /** The answer to the search typed now; none until it comes. */
  answer: Answer | undefined
  /** An answer is on its way. */
  pending: boolean
  error: string | undefined
  /** Nothing can be asked: no signal. */
  offline: boolean
  /** The search the source answers. */
  query: string
  retry: () => void
}

/**
 * The search socket's people search (mode `people`, `forTeam`, `forGame`),
 * asked on every change of the typed text, with no pause. Only an answer
 * for the latest ask reaches here (`SearchSocket` drops the rest), so the
 * answer is always for the text typed now, and none is shown until it
 * comes. Off (`socket` null), it asks nothing. A socket closed for a
 * session the server no longer takes (`unauthorized`) fails as the route's
 * 401 does: the client is told (`onSessionRefused`) and the search says to
 * sign in.
 */
function useSocketSource({
  socket,
  client,
  teamId,
  gameId,
  typed
}: {
  socket: SearchSocket | null
  client: TeamStationClient
  teamId: string
  gameId: string | undefined
  typed: string
}): Source {
  const [status, setStatus] = useState<SearchSocketStatus>(
    socket?.status ?? 'connecting'
  )
  const [answer, setAnswer] = useState<Answer & { seq: number }>()
  const [error, setError] = useState<{ seq: number; message: string }>()
  const [attempt, setAttempt] = useState(0)
  // The latest ask: its seq, and the text it asked.
  const asked = useRef({ seq: 0, query: '' })

  useEffect(() => {
    if (socket == null) return
    setStatus(socket.status)
    const stops = [
      socket.onStatus(next => {
        setStatus(next)
        // The server no longer takes the session: told as a REST 401 is.
        if (next === 'unauthorized') client.onSessionRefused?.()
      }),
      socket.onResults(results => {
        // Only the latest ask is answered: one resent after a reconnect too.
        if (results.seq < asked.current.seq) return
        asked.current = { ...asked.current, seq: results.seq }
        const query = asked.current.query
        const rows: RosterCandidate[] = []
        const kept: KeptCandidate[] = []
        for (const result of results.results) {
          const row = rosterCandidateOf(result)
          if (row == null) continue
          rows.push(row)
          // Only the words that found him: an answer lists anybody any
          // one typed word found.
          kept.push(
            withMatched(
              row,
              query,
              result.kind === 'person' ? (result.roster?.matched ?? []) : []
            )
          )
        }
        keepFound(client, teamId, kept)
        client.keepRosterCandidates(teamId, kept).catch(() => undefined)
        setAnswer({ seq: results.seq, query, rows })
        setError(undefined)
      }),
      socket.onError(refused => {
        setError({
          seq: refused.seq ?? asked.current.seq,
          message: refused.message
        })
      })
    ]
    return () => {
      for (const stop of stops) stop()
    }
  }, [socket, client, teamId])

  useEffect(() => {
    if (socket == null) return
    const query = typed.slice(0, SEARCH_TEXT_MAX)
    const seq = socket.search({
      text: query,
      location: null,
      mode: 'people',
      forTeam: teamId,
      ...(gameId == null ? {} : { forGame: gameId })
    })
    asked.current = { seq, query }
    setError(undefined)
  }, [socket, typed, teamId, gameId, attempt])

  const retry = useCallback((): void => {
    setAttempt(count => count + 1)
  }, [])
  const query = typed.slice(0, SEARCH_TEXT_MAX)
  // An answer for other typing, or asked before the latest ask (for another
  // team or game, or before a retry), is not this one's.
  const current =
    answer?.query === query && answer.seq >= asked.current.seq
      ? answer
      : undefined
  // A session the server no longer takes fails the search as the route's
  // 401 does, and shows nothing it found before.
  const signedOut = status === 'unauthorized'
  const refused = signedOut
    ? SIGNED_OUT_PROBLEM
    : error != null && error.seq >= asked.current.seq
      ? error.message
      : undefined
  return {
    answer: signedOut ? undefined : current,
    pending:
      socket != null &&
      current == null &&
      refused == null &&
      status !== 'offline',
    error: refused,
    offline: status === 'offline',
    query,
    retry
  }
}

/**
 * `GET /users?forTeam=`, where there is no search socket: asked once the
 * typing pauses (`CANDIDATE_DEBOUNCE_MS`), one request per settled search,
 * each aborting the one before. An answer for other typing than the text
 * typed now is not shown. Off (`enabled` false), it asks nothing.
 */
function useHttpSource({
  enabled,
  client,
  teamId,
  gameId,
  typed,
  cacheFirst
}: {
  enabled: boolean
  client: TeamStationClient
  teamId: string
  gameId: string | undefined
  typed: string
  cacheFirst: boolean
}): Source {
  const settled = useDebouncedValue(typed, CANDIDATE_DEBOUNCE_MS)
  const [phoneOffline, setOffline] = useState(client.offline)
  const offline = phoneOffline && !cacheFirst
  useEffect(() => {
    setOffline(client.offline)
    return client.subscribeOffline(setOffline)
  }, [client])

  const [answer, setAnswer] = useState<Answer>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled || offline) return
    if (cacheFirst && phoneOffline) {
      // The phone's people are the whole list until the signal is back.
      setAnswer(undefined)
      setLoading(false)
      setError(undefined)
      return
    }
    const controller = new AbortController()
    let current = true
    setLoading(true)
    setError(undefined)
    setAnswer(undefined)
    client
      .rosterCandidates({
        teamId,
        gameId,
        q: settled,
        // It draws `capped` when the answer is full: as many as the socket
        // answers, so "Showing the first 50" counts what is shown.
        capped: true,
        limit: ROSTER_CANDIDATE_MAX,
        signal: controller.signal
      })
      .then(
        answered => {
          if (!current) return
          // A server that answers more than asked still shows the first 50.
          const found = answered.slice(0, ROSTER_CANDIDATE_MAX)
          // Only the words that found each: the route, as the socket, lists
          // anybody any one typed word found.
          keepFound(
            client,
            teamId,
            found.map(({ matched, ...row }) =>
              withMatched(row, settled, matched ?? [])
            )
          )
          setAnswer({ query: settled, rows: found.map(listedRow) })
          setLoading(false)
        },
        (caught: unknown) => {
          if (!current) return
          setLoading(false)
          // With the phone's people shown, no signal is no failure.
          if (
            cacheFirst &&
            caught instanceof HttpError &&
            caught.code === 'offline'
          )
            return
          setError(problemOf(caught))
        }
      )
    return () => {
      current = false
      controller.abort()
    }
  }, [
    enabled,
    client,
    teamId,
    gameId,
    settled,
    offline,
    attempt,
    cacheFirst,
    phoneOffline
  ])

  const retry = useCallback((): void => {
    setAttempt(count => count + 1)
  }, [])
  return {
    // The rows of an older search are not this one's (#210).
    answer: answer?.query === typed ? answer : undefined,
    // Typing not settled yet is a search on its way too.
    pending:
      loading ||
      (enabled &&
        !offline &&
        !(cacheFirst && phoneOffline) &&
        settled !== typed),
    error,
    offline,
    query: settled,
    retry
  }
}

/**
 * The players a roster manager may add to `teamId` (and, with `gameId`, to
 * its side of that game), as the search engine finds them: over the search
 * socket in mode `people` where the app provides one
 * (`SearchSocketFactoryContext`), asked on every change of `query` with no
 * pause; else from `GET /users?forTeam=`, once typing pauses for half a
 * second. Either answers at most one full answer, with no further pages.
 * Both the scoring sheet and the team's Add Player scene draw it.
 *
 * Only the answer to the text typed now is listed: an answer for older
 * typing never replaces a newer one, and while the current text's answer is
 * on its way, no row of an older one is shown.
 *
 * `cacheFirst` (the scoring screen, which never waits on the network): the
 * people the phone keeps for the team that match the text typed now are
 * listed at once, and the server's matches join them when they come. With
 * no signal (the socket `offline`) the phone's are the list, and the search
 * is not `offline`. Every answer is kept, the phone's file written from the
 * socket's answers as from the route's. Nobody in `excluded` (by user id:
 * those already on the team's roster or in the game) is listed, since the
 * phone's kept rows, and an answer read before an add landed, may still
 * hold him.
 */
export function useRosterCandidates({
  client,
  teamId,
  gameId,
  query,
  cacheFirst = false,
  excluded
}: {
  client: TeamStationClient
  teamId: string
  gameId?: string
  query: string
  cacheFirst?: boolean
  excluded?: ReadonlySet<string>
}): RosterCandidates {
  const factory = useContext(SearchSocketFactoryContext)
  // The socket, once made; null where none can be: the route is asked.
  const [socket, setSocket] = useState<SearchSocket | null | undefined>(
    factory == null ? null : undefined
  )
  useEffect(() => {
    if (factory == null) {
      setSocket(null)
      return
    }
    let made: SearchSocket
    try {
      made = makeSearchSocket(factory, client, true)
    } catch {
      // No address or no WebSocket here.
      setSocket(null)
      return
    }
    setSocket(made)
    return () => {
      made.close()
    }
  }, [factory, client])

  // The people found before for the team: this session's at once, then
  // those the phone keeps.
  const [kept, setKept] = useState<KeptCandidate[]>(() =>
    cacheFirst ? foundFor(client, teamId) : []
  )
  useEffect(() => {
    if (!cacheFirst) return
    let current = true
    setKept(foundFor(client, teamId))
    // A cache that cannot be read is one that holds nobody.
    Promise.resolve()
      .then(
        async () =>
          await client.cached(candidatesKey(teamId), asArray(asKeptCandidate))
      )
      .then(
        stored => {
          if (current && stored != null && stored.length > 0)
            setKept(held => merged(held, stored))
        },
        () => undefined
      )
    return () => {
      current = false
    }
  }, [client, teamId, cacheFirst])

  const typed = query.trim()
  const viaSocket = useSocketSource({
    socket: socket ?? null,
    client,
    teamId,
    gameId,
    typed
  })
  const viaHttp = useHttpSource({
    enabled: socket === null,
    client,
    teamId,
    gameId,
    typed,
    cacheFirst
  })
  const source = socket === null ? viaHttp : viaSocket
  // With no signal, the phone's people are the list, and nothing failed.
  const phoneOnly = cacheFirst && source.offline
  const rows = phoneOnly ? [] : (source.answer?.rows ?? [])
  // Those the phone keeps matching what is typed, as it is typed.
  const cachedRows = cacheFirst
    ? kept
        .filter(candidate => candidateMatches(candidate, typed))
        .map(listedRow)
    : []
  // The server's rows first, nearest first, then the phone's it has not
  // listed; the phone's alone while the server's are on their way.
  const listed = cacheFirst ? merged(rows, cachedRows) : rows
  const shownRows =
    excluded == null || excluded.size === 0
      ? listed
      : listed.filter(row => !excluded.has(row.userId))
  const loading = !phoneOnly && source.pending
  return {
    rows: shownRows,
    loading: loading && shownRows.length === 0,
    // The server's answer still coming under the phone's rows.
    updating: loading && shownRows.length > 0,
    error: phoneOnly ? undefined : source.error,
    capped: !loading && rows.length >= ROSTER_CANDIDATE_MAX,
    offline: source.offline && !cacheFirst,
    query: source.query,
    retry: source.retry
  }
}
