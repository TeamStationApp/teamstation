import type { VideoGame } from '../../common/api'
import { viewerTimezone } from '../../common/eventTime'

export function gameDate(
  game: Pick<VideoGame, 'startAt' | 'timezone'>,
  timeZone = viewerTimezone()
): string {
  if (game.startAt === null || !Number.isFinite(Date.parse(game.startAt)))
    return 'Date to be announced'
  const format = (timeZone: string): string => {
    const date = new Date(game.startAt!)
    const day = new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'long',
      day: 'numeric'
    }).format(date)
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
      .format(date)
      .replace(':00', '')
      .toLowerCase()
    return `${day} at ${time}`
  }
  try {
    return format(timeZone)
  } catch {
    return format('UTC') + ' UTC'
  }
}
export function monthOf(
  game: Pick<VideoGame, 'startAt' | 'timezone'>,
  timeZone = viewerTimezone()
): string {
  if (game.startAt === null || !Number.isFinite(Date.parse(game.startAt)))
    return 'Date to be announced'
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
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
  games: VideoGame[],
  timeZone = viewerTimezone()
): Array<{ month: string; rows: VideoGame[][] }> {
  const groups: Array<{ month: string; games: VideoGame[] }> = []
  for (const game of games) {
    const month = monthOf(game, timeZone)
    const last = groups[groups.length - 1]
    if (last?.month === month) last.games.push(game)
    else groups.push({ month, games: [game] })
  }
  return groups.map(group => ({
    month: group.month,
    rows: fourAcross(group.games)
  }))
}

/** Reserve a complete first row, including title, details and focus-lift gutters. */
export function browseGeometry(
  width: number,
  viewportHeight: number,
  monthly: boolean,
  fontScale = 1
): {
  tileWidth: number
  tileGap: number
  rowHeight: number
  heroHeight: number
} {
  const originalWidth = Math.max(1, (width - 152 - 72) / 4)
  const tileWidth = originalWidth * 0.85
  const tileGap = 24 + originalWidth - tileWidth
  const tileHeight = (tileWidth * 9) / 16 + (38 + 34) * fontScale + 14
  const rowHeight = monthly
    ? 92 + tileHeight + 28
    : 38 * fontScale + 18 + 48 + tileHeight
  return {
    tileWidth,
    tileGap,
    rowHeight,
    heroHeight: Math.max(0, viewportHeight - rowHeight)
  }
}
/** The first quarter of the ramp image fades in; its remaining three quarters stay dark. */
export function collectionGradientLayout(
  firstRowTop: number,
  rowHeight: number,
  screenHeight: number
): { height: number; inputRange: number[]; outputRange: number[] } {
  const fadeHeight = Math.max(rowHeight, screenHeight / 3)
  return {
    height: 4 * fadeHeight,
    inputRange: [0, firstRowTop + fadeHeight],
    outputRange: [firstRowTop, -fadeHeight]
  }
}

/** Fit wrapped matchup names and venue text inside the reserved hero area. */
export function heroDetailsScale(
  heroHeight: number,
  fontScale: number,
  measuredHeight: number
): number {
  return Math.min(1, heroHeight / Math.max(440 * fontScale, measuredHeight))
}
