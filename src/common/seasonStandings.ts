import type { StandingsRow } from './api'

export interface SeasonTeam {
  id: string
  name: string
  kind: 'full' | 'external'
  logoPath: string | null
}
export interface SeasonResult {
  id: string
  homeTeamId: string
  awayTeamId: string
  startAt: string
  status: string
  homeScore: number | null
  awayScore: number | null
  exhibition: boolean
}

/** Published results alone determine records; scheduled teams still have a zero row. */
export function seasonStandings(
  teams: SeasonTeam[],
  games: SeasonResult[],
  includeExhibitions = true
): Array<Omit<StandingsRow, 'logoUrl'> & { logoPath: string | null }> {
  const eligible = games.filter(game => includeExhibitions || !game.exhibition)
  const rows = teams.map(team => ({
    teamId: team.id,
    teamName: team.name,
    teamKind: team.kind,
    logoPath: team.logoPath,
    w: 0,
    l: 0,
    t: 0,
    runsFor: 0,
    runsAgainst: 0,
    played: 0,
    winningPct: null as number | null,
    runDifferential: 0,
    gamesBehind: null as number | null,
    streak: null as string | null,
    home: { w: 0, l: 0, t: 0 },
    away: { w: 0, l: 0, t: 0 }
  }))
  const byId = new Map(rows.map(row => [row.teamId, row]))
  const outcomes = new Map<string, string[]>()
  for (const game of [...eligible].sort((a, b) =>
    a.startAt.localeCompare(b.startAt) !== 0
      ? a.startAt.localeCompare(b.startAt)
      : a.id.localeCompare(b.id)
  )) {
    if (
      game.status !== 'final' ||
      game.homeScore == null ||
      game.awayScore == null
    )
      continue
    for (const side of ['home', 'away'] as const) {
      const row = byId.get(side === 'home' ? game.homeTeamId : game.awayTeamId)
      if (row == null) continue
      const own: number = side === 'home' ? game.homeScore : game.awayScore
      const other: number = side === 'home' ? game.awayScore : game.homeScore
      const result = own > other ? 'w' : own < other ? 'l' : 't'
      row[result] += 1
      row[side][result] += 1
      row.runsFor += own
      row.runsAgainst += other
      const history = outcomes.get(row.teamId) ?? []
      history.push(result.toUpperCase())
      outcomes.set(row.teamId, history)
    }
  }
  for (const row of rows) {
    row.played = row.w + row.l + row.t
    row.winningPct =
      row.played === 0
        ? null
        : Math.round(((row.w + row.t / 2) / row.played) * 1000) / 1000
    row.runDifferential = row.runsFor - row.runsAgainst
    const history = outcomes.get(row.teamId) ?? []
    const last = history.at(-1)
    if (last != null) {
      let count = 0
      for (let i = history.length - 1; i >= 0 && history[i] === last; --i)
        count++
      row.streak = `${last}${count}`
    }
  }
  rows.sort((a, b) => {
    const pct = (b.winningPct ?? -1) - (a.winningPct ?? -1)
    if (pct !== 0) return pct
    const diff = b.runDifferential - a.runDifferential
    if (diff !== 0) return diff
    const name = a.teamName.localeCompare(b.teamName)
    return name !== 0 ? name : a.teamId.localeCompare(b.teamId)
  })
  const leader = rows[0]
  if (leader != null && leader.played > 0)
    for (const row of rows)
      if (row.played > 0)
        row.gamesBehind = (leader.w - row.w + (row.l - leader.l)) / 2
  return rows
}
