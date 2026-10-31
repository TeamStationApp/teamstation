import type { VideoGame } from '../../common/api'

export function gameDate(
  game: Pick<VideoGame, 'startAt' | 'timezone'>
): string {
  if (game.startAt === null || !Number.isFinite(Date.parse(game.startAt)))
    return 'Date to be announced'
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: game.timezone,
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(game.startAt))
  } catch {
    return (
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(new Date(game.startAt)) + ' UTC'
    )
  }
}
export function monthOf(game: Pick<VideoGame, 'startAt' | 'timezone'>): string {
  if (game.startAt === null || !Number.isFinite(Date.parse(game.startAt)))
    return 'Date to be announced'
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: game.timezone,
      month: 'long',
      year: 'numeric'
    }).format(new Date(game.startAt))
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'long',
      year: 'numeric'
    }).format(new Date(game.startAt))
  }
}
export function fourAcross<T>(items: T[]): T[][] {
  return Array.from({ length: Math.ceil(items.length / 4) }, (_, i) =>
    items.slice(i * 4, i * 4 + 4)
  )
}
export function monthSections(
  games: VideoGame[]
): Array<{ month: string; rows: VideoGame[][] }> {
  const groups: Array<{ month: string; games: VideoGame[] }> = []
  for (const game of games) {
    const month = monthOf(game)
    const last = groups[groups.length - 1]
    if (last?.month === month) last.games.push(game)
    else groups.push({ month, games: [game] })
  }
  return groups.map(group => ({
    month: group.month,
    rows: fourAcross(group.games)
  }))
}
