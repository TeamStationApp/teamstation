import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { extname } from 'node:path'

import type { StoredGame } from '../../common/scoring/session'
import { userIdOfGumbo } from '../../common/userId'
import { rosterEntryFromBody } from '../../test/mintedRosterEntry'
import { POSITIONS } from './scoringTypes'

interface FixturePlayer {
  userId: string
  gumboId: number
  shortName: string
  jersey: string
  positions: string[]
  isPlayer: boolean
  role: string
  section: string
  staffRoles: string[]
  inheritedFrom: null
  bats: string
  throws: string
}
interface LineupPerson {
  gumboId: number
  name: string
  jersey: string
}
interface ModalFixture {
  reset: (missing?: boolean) => string
  loaded: () => string
  pauseWrites: (paused: boolean) => void
  stored: () => StoredGame
  unexpected: string[]
  close: () => Promise<void>
}

const names = [
  'Mookie Betts',
  'Mike Trout',
  'Shohei Ohtani',
  'Aaron Judge',
  'Bryce Harper',
  'Freddie Freeman',
  'Francisco Lindor',
  'Juan Soto',
  'Bobby Witt',
  'Julio Rodriguez'
]
const roster = (side: string): FixturePlayer[] =>
  names.map((name, i) => ({
    userId: userIdOfGumbo((side === 'away' ? 100 : 200) + i),
    gumboId: (side === 'away' ? 100 : 200) + i,
    shortName: name,
    jersey: String(i + 1),
    positions: [POSITIONS[i % 9]],
    isPlayer: true,
    role: 'member',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null,
    bats: 'right',
    throws: 'right'
  }))
const lineup = (
  side: string,
  missing: boolean
): {
  batters: LineupPerson[]
  defense: Record<string, LineupPerson | null>
} => {
  const rows = roster(side)
  const person = (i: number): LineupPerson => ({
    gumboId: rows[i].gumboId,
    name: rows[i].shortName,
    jersey: rows[i].jersey
  })
  return {
    batters: rows.slice(0, 9).map((_, i) => person(i)),
    defense: Object.fromEntries(
      POSITIONS.map((slot, i) => [
        slot,
        missing && slot === 'P' ? null : person(i)
      ])
    )
  }
}

/** An isolated synthetic API for the real scoring app on either iOS surface. */
export async function modalFixture(
  assets: string,
  port: number
): Promise<ModalFixture> {
  assert(['localhost', '127.0.0.1'].includes(new URL(assets).hostname))
  let sequence = Date.now()
  let missing = false
  let id = ''
  let loaded = ''
  let held: StoredGame = { plays: [], currentPlay: null }
  const games = new Map<string, StoredGame>()
  const unexpected: string[] = []
  let paused = false
  const waiting = new Set<() => void>()
  const pauseWrites = (value: boolean): void => {
    paused = value
    if (!paused) {
      for (const resolve of waiting) resolve()
      waiting.clear()
    }
  }
  const reset = (emptyPitcher = false): string => {
    missing = emptyPitcher
    id = `modal${++sequence}`
    loaded = ''
    held = { plays: [], currentPlay: null }
    games.set(id, held)
    return id
  }
  reset()
  const server = createServer((request, response) => {
    const respond = async (): Promise<void> => {
      const u = new URL(request.url ?? '/', 'http://localhost')
      response.setHeader('Access-Control-Allow-Origin', '*')
      response.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization'
      )
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      if (request.method === 'OPTIONS') {
        response.end()
        return
      }
      if (!u.pathname.startsWith('/api/')) {
        const asset = extname(u.pathname) === '' ? '/' : u.pathname
        const url = new URL(asset, assets)
        if (url.origin !== new URL(assets).origin) {
          response.statusCode = 404
          response.end()
          return
        }
        const upstream = await fetch(url)
        response.statusCode = upstream.status
        response.setHeader(
          'Content-Type',
          upstream.headers.get('content-type') ?? 'application/octet-stream'
        )
        response.end(Buffer.from(await upstream.arrayBuffer()))
        return
      }
      let body: unknown
      if (u.pathname.endsWith('/auth/me'))
        body = { id: 999, displayName: 'Scorer', isAdmin: false }
      else if (u.pathname.endsWith('/me/roles'))
        body = { teams: [], players: [] }
      else if (u.pathname.endsWith('/health'))
        body = {
          status: 'ok',
          version: '',
          database: 'ok',
          migrations: 0,
          dictation: true,
          dictationModels: ['gpt-6-luna', 'gpt-6-sol']
        }
      else if (u.pathname === '/api/v1/events') body = []
      else if (u.pathname.endsWith('/events')) {
        const gameId = u.pathname.split('/').at(-2) ?? ''
        // Safari restores a prior synthetic scoring tab before navigation.
        // Permit its empty read, while all writes remain scoped to this run.
        const stored =
          games.get(gameId) ??
          (request.method === 'GET' && /^modal\d+$/.test(gameId)
            ? { plays: [], currentPlay: null }
            : undefined)
        assert(stored != null, 'Only fixture games may be read or written')
        if (request.method === 'POST') {
          if (paused) await new Promise<void>(resolve => waiting.add(resolve))
          let bytes = ''
          for await (const chunk of request) bytes += String(chunk)
          const change = JSON.parse(bytes) as Partial<StoredGame> & {
            remove?: number[]
          }
          const kept = new Map(
            stored.plays.map(play => [play.about.atBatIndex, play])
          )
          for (const index of change.remove ?? []) kept.delete(index)
          for (const play of change.plays ?? [])
            kept.set(play.about.atBatIndex, play)
          stored.plays = [...kept.values()]
          if (change.currentPlay !== undefined)
            stored.currentPlay = change.currentPlay
        }
        body = {
          plays: stored.plays.map(play => ({
            id: `event${play.about.atBatIndex}`,
            gameId,
            gumbo: play
          })),
          currentPlay: stored.currentPlay
        }
      } else if (/\/games\/[^/]+$/.test(u.pathname)) {
        loaded = u.pathname.split('/').at(-1) ?? ''
        body = {
          id: loaded,
          awayTeamId: 'away',
          homeTeamId: 'home',
          awayTeamName: 'Owls',
          homeTeamName: 'Hawks',
          seasonId: null,
          startAt: null,
          venue: null,
          status: 'scheduled',
          homeScore: null,
          awayScore: null,
          ingestStatus: 'pending',
          ingestMessage: null,
          nonMemberView: false,
          canScore: true,
          videos: []
        }
      } else if (u.pathname.endsWith('/roster'))
        body = roster(u.pathname.includes('/away/') ? 'away' : 'home')
      else if (u.pathname.endsWith('/default-lineup'))
        body = {
          lineup: lineup(
            u.pathname.includes('/away/') ? 'away' : 'home',
            missing && u.pathname.includes('/home/')
          ),
          fromGameId: null,
          setAt: null
        }
      else if (u.pathname.endsWith('/live-streams'))
        body = { gameId: id, mine: [], others: [], canAdd: 0, maxCameras: 3 }
      else if (
        ['/api/v1/teams', '/api/v1/live', '/api/v1/seasons'].includes(
          u.pathname
        )
      )
        body = []
      else if (
        request.method === 'POST' &&
        u.pathname.endsWith('/roster-players')
      ) {
        let bytes = ''
        for await (const chunk of request) bytes += String(chunk)
        body = rosterEntryFromBody(JSON.parse(bytes === '' ? '{}' : bytes))
        response.statusCode = 201
      } else {
        unexpected.push(`${request.method} ${u.pathname}`)
        body = []
      }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(body))
    }
    respond().catch((error: unknown) => {
      unexpected.push(String(error))
      response.statusCode = 500
      response.end('{}')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  return {
    reset,
    loaded: () => loaded,
    pauseWrites,
    stored: () => held,
    unexpected,
    close: async () => {
      pauseWrites(false)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error == null) resolve()
          else reject(error)
        })
      })
    }
  }
}
