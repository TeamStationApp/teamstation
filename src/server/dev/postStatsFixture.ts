import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import type { GumboPlay } from '../../common/gumboPlay'
import type { PlayerGameLine } from '../stats/gumboStats'

export interface FixtureFile {
  plays: GumboPlay[]
  expected: PlayerGameLine[]
  finalScore: { away: number; home: number }
}

export interface RosterPlayer {
  userId: number
  isPlayer: boolean
}

export interface FixtureOptions {
  innings?: number
  noScores?: boolean
  drop?: string
}

export interface MappedFixture {
  plays: GumboPlay[]
  expected: PlayerGameLine[]
  idMap: Map<number, number>
}

/**
 * Map scorebook placeholders 1–10 to away players and 11–19 to home players.
 * Placeholder 20 stays without an id. Dual-roster people are skipped on home.
 */
export function mapScorebookFixture(
  fixture: FixtureFile,
  awayRoster: RosterPlayer[],
  homeRoster: RosterPlayer[],
  teams: { awayTeamId: string; homeTeamId: string },
  options: FixtureOptions = {}
): MappedFixture {
  const awayPlayers = awayRoster
    .filter(row => row.isPlayer)
    .sort((a, b) => a.userId - b.userId)
  const awayIds = new Set(awayPlayers.map(row => row.userId))
  const homePlayers = homeRoster
    .filter(row => row.isPlayer && !awayIds.has(row.userId))
    .sort((a, b) => a.userId - b.userId)

  if (awayPlayers.length < 10) {
    throw new Error(
      `Away roster needs 10 isPlayer entries, has ${awayPlayers.length}`
    )
  }
  if (homePlayers.length < 9) {
    throw new Error(
      `Home roster needs 9 isPlayer entries after dual-roster skip, has ${homePlayers.length}`
    )
  }

  const idMap = new Map<number, number>()
  for (let i = 0; i < 10; i++) idMap.set(i + 1, awayPlayers[i].userId)
  for (let i = 0; i < 9; i++) idMap.set(i + 11, homePlayers[i].userId)

  let plays = structuredClone(fixture.plays)
  if (options.innings != null) {
    plays = plays.filter(
      play =>
        typeof play.about?.inning === 'number' &&
        play.about.inning <= options.innings!
    )
  }
  if (options.noScores === true) {
    for (const play of plays) {
      if (play.result != null) {
        play.result.awayScore = null
        play.result.homeScore = null
      }
    }
  }
  if (options.drop != null) {
    const at = options.drop.lastIndexOf('@')
    if (at < 0) throw new Error(`Bad --drop value: ${options.drop}`)
    const path = options.drop.slice(0, at)
    const index = Number(options.drop.slice(at + 1))
    if (!Number.isInteger(index)) {
      throw new Error(`Bad --drop atBatIndex: ${options.drop}`)
    }
    const play = plays.find(p => p.about?.atBatIndex === index)
    if (play == null) throw new Error(`No play at atBatIndex ${index}`)
    dropPath(play, path)
  }

  remapIds(plays, idMap)

  const expected = fixture.expected
    .filter(line => idMap.has(line.userId))
    .map(line => ({
      ...line,
      userId: idMap.get(line.userId)!,
      teamId:
        line.teamId === 'away'
          ? teams.awayTeamId
          : line.teamId === 'home'
            ? teams.homeTeamId
            : line.teamId
    }))

  return { plays, expected, idMap }
}

function dropPath(root: Record<string, unknown>, path: string): void {
  const parts = path.split('.')
  let cursor: unknown = root
  for (let i = 0; i < parts.length - 1; i++) {
    if (cursor == null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      throw new Error(
        `Cannot drop ${path}: missing ${parts.slice(0, i + 1).join('.')}`
      )
    }
    cursor = (cursor as Record<string, unknown>)[parts[i]]
  }
  if (cursor == null || typeof cursor !== 'object' || Array.isArray(cursor)) {
    throw new Error(`Cannot drop ${path}`)
  }
  Reflect.deleteProperty(cursor, parts[parts.length - 1])
}

function remapIds(plays: GumboPlay[], idMap: Map<number, number>): void {
  const remapPlayer = (player: { id?: number | null } | undefined): void => {
    if (player?.id == null) return
    if (player.id === 20) {
      delete player.id
      return
    }
    const next = idMap.get(player.id)
    if (next != null) player.id = next
  }

  for (const play of plays) {
    remapPlayer(play.matchup?.batter)
    remapPlayer(play.matchup?.pitcher)
    for (const entry of play.runners ?? []) {
      const details = entry.details as
        | {
            runner?: { id?: number | null }
            responsiblePitcher?: { id?: number | null }
            pitcher?: { id?: number | null }
          }
        | undefined
      remapPlayer(details?.runner)
      remapPlayer(details?.responsiblePitcher)
      remapPlayer(details?.pitcher)
    }
  }
}

export function loadScorebookFixture(): FixtureFile {
  return JSON.parse(
    readFileSync(
      join(__dirname, '../stats/fixtures/scorebookGame.json'),
      'utf8'
    )
  ) as FixtureFile
}

export function parseFixtureArgs(argv: string[]): {
  game: string
  url: string
  cookie: string
  options: FixtureOptions
} {
  let game: string | undefined
  let url: string | undefined
  let cookie: string | undefined
  const options: FixtureOptions = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--game') game = argv[++i]
    else if (arg === '--url') url = argv[++i]
    else if (arg === '--cookie') cookie = argv[++i]
    else if (arg === '--innings') {
      const innings = Number(argv[++i])
      if (!Number.isInteger(innings) || innings < 1) {
        throw new Error('--innings must be a positive integer')
      }
      options.innings = innings
    } else if (arg === '--no-scores') options.noScores = true
    else if (arg === '--drop') options.drop = argv[++i]
  }
  if (game == null || url == null || cookie == null) {
    throw new Error(
      'Usage: stats-fixture --game <id> --url <server> --cookie <ts_session> [--innings n] [--no-scores] [--drop path@index]'
    )
  }
  return { game, url, cookie, options }
}

export async function postStatsFixture(input: {
  game: string
  url: string
  cookie: string
  options?: FixtureOptions
  fixture?: FixtureFile
  fetchImpl?: typeof fetch
  writeExpected?: (path: string, body: string) => void
}): Promise<MappedFixture> {
  const fetchImpl = input.fetchImpl ?? fetch
  const base = input.url.replace(/\/$/, '')
  const headers = {
    cookie: `ts_session=${input.cookie}`,
    'content-type': 'application/json'
  }

  const gameRes = await fetchImpl(`${base}/api/v1/games/${input.game}`, {
    headers
  })
  if (!gameRes.ok) {
    throw new Error(
      `GET game failed: ${gameRes.status} ${await gameRes.text()}`
    )
  }
  const game = (await gameRes.json()) as {
    homeTeamId: string
    awayTeamId: string
  }

  const [awayRoster, homeRoster] = await Promise.all([
    fetchRoster(fetchImpl, base, headers, game.awayTeamId),
    fetchRoster(fetchImpl, base, headers, game.homeTeamId)
  ])

  const fixture = input.fixture ?? loadScorebookFixture()
  const mapped = mapScorebookFixture(
    fixture,
    awayRoster,
    homeRoster,
    { awayTeamId: game.awayTeamId, homeTeamId: game.homeTeamId },
    input.options ?? {}
  )

  const postRes = await fetchImpl(`${base}/api/v1/games/${input.game}/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      plays: mapped.plays,
      source: { system: 'manual' }
    })
  })
  if (!postRes.ok) {
    throw new Error(
      `POST events failed: ${postRes.status} ${await postRes.text()}`
    )
  }

  const outPath = `${input.game}.expected.json`
  const write = input.writeExpected ?? writeFileSync
  write(outPath, JSON.stringify(mapped.expected, null, 2) + '\n')
  return mapped
}

async function fetchRoster(
  fetchImpl: typeof fetch,
  base: string,
  headers: Record<string, string>,
  teamId: string
): Promise<RosterPlayer[]> {
  const res = await fetchImpl(`${base}/api/v1/teams/${teamId}/roster`, {
    headers
  })
  if (!res.ok) {
    throw new Error(`GET roster failed: ${res.status} ${await res.text()}`)
  }
  const rows = (await res.json()) as Array<{
    userId: number
    isPlayer: boolean
  }>
  return rows.map(row => ({ userId: row.userId, isPlayer: row.isPlayer }))
}

export async function runFixtureMain(argv: string[]): Promise<void> {
  const args = parseFixtureArgs(argv)
  await postStatsFixture({
    game: args.game,
    url: args.url,
    cookie: args.cookie,
    options: args.options
  })
}

/* c8 ignore start */
if (require.main === module) {
  runFixtureMain(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
/* c8 ignore stop */
