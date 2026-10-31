import type {
  TeamStationClient,
  TeamSummary,
  TvHighlight,
  VideoGame
} from '../../common/api'

export interface TvClip extends TvHighlight {
  game: VideoGame
  videoId: string
}
export interface TvCollection {
  hero: VideoGame | null
  recent: VideoGame[]
  highlights: TvClip[]
  teamRows: Array<{ team: TeamSummary; games: VideoGame[] }>
  teams: TeamSummary[]
  remaining: VideoGame[]
  nextOffset: number | null
}

function importance(clip: TvHighlight): number {
  switch (clip.eventType) {
    case 'home_run':
      return 6
    case 'triple':
    case 'double':
      return 5
    case 'single':
      return clip.isScoringPlay ? 4 : 3
    case 'strikeout':
    case 'strikeout_double_play':
      return 2
    default:
      return 1
  }
}

/** Three distinct plays per game, first favoring the viewer's family. */
export function topClips(game: VideoGame, clips: TvHighlight[]): TvClip[] {
  const unique = new Map<string, TvHighlight>()
  for (const clip of clips)
    if (!unique.has(clip.eventId)) unique.set(clip.eventId, clip)
  return [...unique.values()]
    .sort(
      (a, b) =>
        [
          Number(b.preferred) - Number(a.preferred),
          importance(b) - importance(a),
          b.playOffsetSec - a.playOffsetSec,
          a.eventId.localeCompare(b.eventId)
        ].find(order => order !== 0) ?? 0
    )
    .slice(0, 3)
    .map(clip => ({ ...clip, game, videoId: game.latestVideoId }))
}

export async function loadTvCollection(
  client: TeamStationClient,
  filter: { team?: string; participant?: string } = {}
): Promise<TvCollection> {
  const [games, latest, teams, follows] = await Promise.all([
    client.videoGames({ ...filter, limit: 50 }),
    client.videoGames({ ...filter, sort: 'upload', limit: 1 }),
    allVideoTeams(client, filter),
    filter.team === undefined && filter.participant === undefined
      ? client.myFollows()
      : Promise.resolve([])
  ])
  const highlights = (
    await Promise.all(
      games
        .slice(0, 4)
        .map(async game =>
          topClips(game, await client.tvHighlights(game.latestVideoId))
        )
    )
  ).flat()
  const followed = new Set(follows.map(team => team.id))
  const candidates = await Promise.all(
    teams
      .filter(team => followed.has(team.id))
      .map(async team => ({
        team,
        latest: (
          await client.videoGames({ team: team.id, sort: 'upload', limit: 1 })
        )[0]
      }))
  )
  const recentTeams = candidates
    .filter(row => row.latest !== undefined)
    .sort(
      (a, b) =>
        [
          Date.parse(b.latest.latestVideoAt) -
            Date.parse(a.latest.latestVideoAt),
          a.team.id.localeCompare(b.team.id)
        ].find(order => order !== 0) ?? 0
    )
    .slice(0, 3)
  const teamRows = await Promise.all(
    recentTeams.map(async ({ team }) => ({
      team,
      games: await client.videoGames({ team: team.id, limit: 12 })
    }))
  )
  return {
    hero: latest[0] ?? null,
    recent: games.slice(0, 10),
    highlights,
    teamRows,
    teams,
    remaining: games.slice(10),
    nextOffset: games.length === 50 ? 50 : null
  }
}

async function allVideoTeams(
  client: TeamStationClient,
  filter: { team?: string; participant?: string }
): Promise<TeamSummary[]> {
  const teams: TeamSummary[] = []
  for (let offset = 0; ; offset += 100) {
    const page = await client.videoTeams({ ...filter, offset, limit: 100 })
    teams.push(...page)
    if (page.length < 100) return teams
  }
}
