import { gameFixture } from '../app/scoring/isUnscoredGame.test'
import type { PreferenceStorage } from '../app/scoring/scoringPreferenceStore'
import type { GumboPlay } from '../common/gumboPlay'
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
  posts: Post[]
} {
  const plays = new Map(stored.plays.map(play => [play.about.atBatIndex, play]))
  let currentPlay = stored.currentPlay
  let revision = 1
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
      .map((gumbo, index) => ({ id: `evt_${index}`, gameId: 'g1', gumbo })),
    currentPlay,
    playsDigest: `plays-${revision}`,
    lineupsDigest: 'lineups-1'
  })
  const routes: Record<string, () => unknown> = {
    // The scorekeeper also coaches the Hawks, for Coach Game.
    '/games/g1': () => ({ ...gameFixture, coachSides: ['home'] }),
    '/games/g1/events': eventsBody,
    '/games/g1/lineups': () => ({
      away: side('away', 'Owls'),
      home: side('home', 'Hawks'),
      digest: 'lineups-1'
    }),
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
    posts: [] as Post[],
    fetch: (async (url: unknown, init?: RequestInit) => {
      if (state.hold != null) await state.hold
      if (state.offline) throw new TypeError('Load failed')
      const target = String(url).replace('http://x/api/v1', '')
      // A post is routed without its query, which says what it is answered.
      const [path, query = ''] =
        init?.method === 'POST' ? target.split('?') : [target]
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), { status })
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
          if (state.superseded)
            return json(200, { ...(eventsBody() as object), superseded: true })
          for (const index of body.remove as number[]) plays.delete(index)
          for (const play of body.plays as GumboPlay[])
            plays.set(play.about.atBatIndex, play)
          if ('currentPlay' in body) currentPlay = body.currentPlay
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
