import { gameFixture } from '../app/scoring/isUnscoredGame.test'
import type { PreferenceStorage } from '../app/scoring/scoringPreferenceStore'
import type { GumboPlay } from '../common/gumboPlay'
import { playForWire, playFromWire } from '../common/scoring/wireRecord'
import { userIdOfGumbo } from '../common/userId'
import { scoringRoster } from './scoringSession'

/** The id the server gives the player the phone made offline. */
export const SERVER_GUMBO = 900_001

export interface Post {
  path: string
  query: string
  body: Record<string, unknown>
}

/**
 * The server of one upcoming game, `g1`, between the Owls (away) and the
 * Hawks (home), scored by a scorekeeper of both: its game, rosters, lineups
 * and the plays already stored, and the two writes scoring makes.
 */
export function fieldServer(stored: {
  plays: GumboPlay[]
  currentPlay: unknown
}): {
  fetch: typeof globalThis.fetch
  offline: boolean
  /** Another device saved the lineups: live posts are stale. */
  stale: boolean
  /** Another device changed the lineups later: lineup saves are refused. */
  newer: boolean
  superseded: boolean
  refuseRenames: boolean
  /** While set, a play's save waits on it before it is answered. */
  holdPlays?: Promise<void>
  /** While set, every request waits on it before it is answered. */
  hold?: Promise<void>
  /** A request held by `hold` is lost once it is let go, never delivered. */
  dropHeld: boolean
  posts: Post[]
  /** Each write as it reached the server: method and path. */
  writes: string[]
  /** While set, a tag is refused: its event is not the server's. */
  refuseTags: boolean
  /** While set, a post of plays is refused for good, once `holdPlays` lets it go. */
  refusePlays: boolean
  /**
   * While set, a post of plays answered once a swap or a reset has landed,
   * built on the lineups or the plays generation before it, is refused as
   * stale, as the server's lineups and generation checks refuse it.
   */
  staleOnSwap: boolean
} {
  const plays = new Map(stored.plays.map(play => [play.about.atBatIndex, play]))
  let currentPlay = stored.currentPlay
  let revision = 1
  // Home and away, as a swap leaves them, and the play generation.
  let swapped = false
  let generation = 0
  // The game's teams by side as they stand: records are kept by team and
  // carried by side under these, as the server keeps and carries them.
  const teams = (): Record<'away' | 'home', { id: string }> => {
    const away = { id: gameFixture.awayTeamId }
    const home = { id: gameFixture.homeTeamId }
    return swapped ? { away: home, home: away } : { away, home }
  }
  const tags = new Map<string, string>()
  const made: Array<{ teamId: string; entry: unknown }> = []
  const roster = (teamId: string): unknown[] => [
    ...JSON.parse(
      JSON.stringify(scoringRoster(teamId === gameFixture.awayTeamId ? 1 : 10))
    ),
    ...made.filter(entry => entry.teamId === teamId).map(entry => entry.entry)
  ]
  const side = (teamId: string, teamName: string): unknown => ({
    teamId,
    teamName,
    start: null,
    changes: [],
    current: null
  })
  const eventsBody = (): unknown => ({
    plays: [...plays.values()]
      .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
      .map((gumbo, index) => ({
        id: `evt_${index}`,
        gameId: 'g1',
        gumbo: playForWire(gumbo, teams())
      })),
    currentPlay: playForWire(currentPlay, teams()),
    playsDigest: `plays-${revision}`,
    lineupsDigest: swapped ? 'lineups-swapped' : 'lineups-1',
    generation
  })
  const routes: Record<string, () => unknown> = {
    // The scorekeeper also coaches the Hawks, for Coach Game.
    '/games/g1': () => ({
      ...gameFixture,
      ...(swapped
        ? {
            homeTeamId: gameFixture.awayTeamId,
            awayTeamId: gameFixture.homeTeamId,
            homeTeamName: gameFixture.awayTeamName,
            awayTeamName: gameFixture.homeTeamName
          }
        : {}),
      generation,
      coachSides: ['home']
    }),
    '/games/g1/events': eventsBody,
    '/games/g1/lineups': () => ({
      away: swapped ? side('home', 'Hawks') : side('away', 'Owls'),
      home: swapped ? side('away', 'Owls') : side('home', 'Hawks'),
      digest: swapped ? 'lineups-swapped' : 'lineups-1',
      generation
    }),
    '/tags': () => ({ recent: ['great catch'], popular: [] }),
    '/me/roles': () => ({
      teams: { away: ['scorekeeper'], home: ['scorekeeper'] },
      guardianOf: []
    }),
    '/events?when=upcoming': () => [
      {
        id: 'g1',
        seasonId: null,
        homeTeamId: 'home',
        awayTeamId: 'away',
        homeTeamName: 'Hawks',
        awayTeamName: 'Owls',
        homeTeamExternal: false,
        awayTeamExternal: false,
        startAt: '2026-10-22T18:00:00Z',
        venue: null,
        status: 'scheduled',
        homeScore: null,
        awayScore: null,
        ingestStatus: 'none',
        videoCount: 0
      }
    ],
    '/teams': () => [],
    '/teams/away/roster': () => roster('away'),
    '/teams/away/roster?includeFullNames=true': () => roster('away'),
    '/teams/home/roster': () => roster('home'),
    '/teams/home/roster?includeFullNames=true': () => roster('home'),
    '/teams/away/default-lineup': () => ({
      lineup: null,
      fromGameId: null,
      setAt: null
    }),
    '/teams/home/default-lineup': () => ({
      lineup: null,
      fromGameId: null,
      setAt: null
    })
  }
  const state = {
    offline: false,
    stale: false,
    newer: false,
    superseded: false,
    refuseRenames: false,
    holdPlays: undefined as Promise<void> | undefined,
    hold: undefined as Promise<void> | undefined,
    dropHeld: false,
    posts: [] as Post[],
    writes: [] as string[],
    refuseTags: false,
    refusePlays: false,
    staleOnSwap: false,
    fetch: (async (url: unknown, init?: RequestInit) => {
      if (state.hold != null) {
        await state.hold
        // A stalled link the phone gave up on never delivered it.
        if (state.dropHeld) throw new TypeError('Load failed')
      }
      if (state.offline) throw new TypeError('Load failed')
      const target = String(url).replace('http://x/api/v1', '')
      // A post is routed without its query, which says what it is answered.
      const [path, query = ''] =
        init?.method === 'POST' ? target.split('?') : [target]
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), { status })
      if (init?.method != null && init.method !== 'GET')
        state.writes.push(`${init.method} ${path}`)
      const tag = /^\/games\/g1\/tags\/([^/]+)$/.exec(path)?.[1]
      if (tag != null && state.refuseTags)
        return json(404, { code: 'notFound', message: 'No such event.' })
      if (
        tag != null &&
        (init?.method === 'PUT' || init?.method === 'DELETE')
      ) {
        const label =
          init.method === 'PUT'
            ? String((JSON.parse(init.body as string) as { tag: string }).tag)
            : null
        if (label == null) tags.delete(tag)
        else tags.set(tag, label)
        return json(200, {
          targetId: tag,
          tag: label,
          revision: String(revision++)
        })
      }
      if (init?.method === 'POST' && path === '/games/g1/swap-sides') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>
        state.posts.push({ path, query, body })
        const home = swapped ? gameFixture.awayTeamId : gameFixture.homeTeamId
        if (body.homeTeamId !== home)
          return json(409, {
            code: 'conflict',
            message: "This game's teams changed. Open it again."
          })
        const lost = plays.size
        if (typeof body.playsDigest === 'string') {
          if (body.playsDigest !== `plays-${revision}`)
            return json(409, {
              code: 'conflict',
              message: "This game's plays changed. Open it again."
            })
          plays.clear()
          currentPlay = null
          generation++
        }
        swapped = !swapped
        revision++
        return json(200, {
          homeTeamId: swapped ? gameFixture.awayTeamId : gameFixture.homeTeamId,
          awayTeamId: swapped ? gameFixture.homeTeamId : gameFixture.awayTeamId,
          generation,
          reset: { atBats: lost, innings: lost > 0 ? 1 : 0 }
        })
      }
      if (
        init?.method === 'PUT' &&
        path.startsWith('/games/g1/guest-players/')
      ) {
        if (state.refuseRenames)
          return json(400, { code: 'badRequest', message: 'Rename refused' })
        const names = JSON.parse(init.body as string) as Record<string, string>
        return json(200, { ...scoringRoster(1)[0], nameDetails: names })
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as Record<string, unknown>
        state.posts.push({ path, query, body })
        revision++
        const team = /^\/teams\/([^/]+)\/roster-players$/.exec(path)?.[1]
        if (team != null) {
          const entry = {
            userId: userIdOfGumbo(SERVER_GUMBO),
            gumboId: SERVER_GUMBO,
            shortName: 'Mookie B',
            nameDetails: {
              firstName: body.firstName,
              lastName: body.lastName,
              displayName: 'Mookie Betts'
            },
            jersey: body.jersey,
            positions: body.positions,
            isPlayer: true,
            role: 'member',
            section: 'player',
            staffRoles: [],
            inheritedFrom: null
          }
          made.push({ teamId: team, entry })
          return json(201, entry)
        }
        if (path === '/games/g1/lineups' && state.newer)
          return json(409, {
            code: 'conflict',
            message: 'Another device changed this lineup later',
            details: { stale: true, newer: true }
          })
        if (path === '/games/g1/lineups')
          return json(200, {
            away: side('away', 'Owls'),
            home: side('home', 'Hawks'),
            digest: `lineups-${revision}`
          })
        if (path === '/games/g1/events' && state.stale)
          return json(409, {
            code: 'conflict',
            message: 'Somebody else changed the lineups',
            details: { stale: true }
          })
        if (path === '/games/g1/events') {
          await state.holdPlays
          // Built on the plays a reset deleted, as the server tells it.
          if (state.staleOnSwap && body.generation !== generation)
            return json(409, {
              code: 'conflict',
              message: 'This game was reset since it was read',
              details: { stale: true, generation }
            })
          if (
            state.staleOnSwap &&
            swapped &&
            body.lineupsBase !== 'lineups-swapped'
          )
            return json(409, {
              code: 'conflict',
              message:
                'Somebody else changed the lineups since this game was read',
              details: { stale: true }
            })
          if (state.refusePlays)
            return json(409, {
              code: 'conflict',
              message: "Another scorer's change came first."
            })
          if (state.superseded)
            return json(200, { ...(eventsBody() as object), superseded: true })
          for (const index of body.remove as number[]) plays.delete(index)
          for (const play of body.plays as GumboPlay[])
            plays.set(play.about.atBatIndex, playFromWire(play, teams()))
          if ('currentPlay' in body)
            currentPlay = playFromWire(body.currentPlay, teams())
          return json(200, eventsBody())
        }
        return json(404, { code: 'notFound', message: 'Not found' })
      }
      const route = routes[path]
      return route == null
        ? json(404, { code: 'notFound', message: 'Not found' })
        : json(200, route())
    }) as unknown as typeof globalThis.fetch
  }
  return state
}

export function memoryStorage(): PreferenceStorage {
  const held = new Map<string, string>()
  return {
    getItem: async key => held.get(key) ?? null,
    setItem: async (key, value) => {
      held.set(key, value)
    }
  }
}
