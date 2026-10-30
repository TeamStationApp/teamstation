/**
 * The rows a player's total is split into on their stats tab: one per team
 * for a career, one per game once the page is narrowed to a season, a team or
 * a year.
 *
 * The server orders them and the page labels them, and both read this module,
 * so a tie the server broke by a label is broken the same way the reader sees
 * it.
 */
import {
  asBoolean,
  asEither,
  asNull,
  asObject,
  asString,
  asValue,
  type Cleaner
} from 'cleaners'

const asNullable = <T>(cleaner: Cleaner<T>): Cleaner<T | null> =>
  asEither(asNull, cleaner)

/** What a career's rows are, and what a narrowed page's are. */
export const asStatSplitBy = asValue('team', 'game')
export type StatSplitBy = ReturnType<typeof asStatSplitBy>

/** Where one row's lines were played. */
export const asStatSplit = asObject({
  /** The team the lines were played for; null on lines with no team. */
  teamId: asNullable(asString),
  teamName: asNullable(asString),
  /** The season of the row's latest game. */
  seasonName: asNullable(asString),
  /** The game, on a game row; null on a team row. */
  gameId: asNullable(asString),
  /** The game's start; on a team row, its latest game's. ISO 8601. */
  startAt: asNullable(asString),
  /** The other side, on a game row whose side is known. */
  opponentName: asNullable(asString),
  /** Whether the player's team was home, on a game row whose side is known. */
  home: asNullable(asBoolean)
})
export type StatSplit = ReturnType<typeof asStatSplit>

/**
 * What tells two rows with the same start apart: the side and the opponent,
 * then the team and its season. A game row's label is its date and these, and
 * two rows with one start have one date, so this orders them as their labels
 * do.
 */
export function splitTieKey(split: StatSplit): string {
  const side =
    split.opponentName == null ? '' : `${split.home === true ? 'vs' : '@'} `
  return [
    `${side}${split.opponentName ?? ''}`,
    split.teamName ?? '',
    split.seasonName ?? ''
  ].join('\u0000')
}

/**
 * Newest first. A row with no start is the oldest, just above the total. Equal
 * starts go by their labels, then by the game or team they are, so the same
 * rows always come back in the same order.
 */
export function compareSplits(a: StatSplit, b: StatSplit): number {
  const at = (split: StatSplit): number =>
    split.startAt == null ? -Infinity : Date.parse(split.startAt)
  const byStart = at(b) - at(a)
  if (byStart !== 0 && !Number.isNaN(byStart)) return byStart
  const byLabel = splitTieKey(a).localeCompare(splitTieKey(b))
  if (byLabel !== 0) return byLabel
  const id = (split: StatSplit): string => split.gameId ?? split.teamId ?? ''
  return id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0
}

/**
 * One label per row, for the column that does not scroll.
 *
 * A team row is the team's name, and its season as well when another row is a
 * team of the same name: a club that keeps its name from one season to the
 * next is two teams and two rows. A game row is its date and opponent, `vs` at
 * home and `@` away, the team as well when the rows are not all one team's,
 * and the year in the date when they are not all one year's. Rows that still
 * read the same are numbered, because each is a different row of figures.
 *
 * `among` is every row on the page, so that a page's two tables tell their
 * rows apart in the same way.
 */
export function splitLabels(
  splits: readonly StatSplit[],
  by: StatSplitBy,
  formatDate: (startAt: string) => string,
  among: readonly StatSplit[] = splits
): string[] {
  const teams = new Set(among.map(split => split.teamId))
  // By the UTC year, which is the one the route's year filter means: a narrowed
  // page's rows are one year's even where a game's local date says otherwise.
  const years = new Set(
    among.flatMap(split =>
      split.startAt == null ? [] : new Date(split.startAt).getUTCFullYear()
    )
  )
  // `mark` follows the first words, which the two lines a label gets always
  // show, so rows told apart by it stay apart under a long opponent's name.
  const teamLabel = (split: StatSplit, mark: string): string => {
    const name = split.teamName ?? 'No team'
    const shared = among.some(
      other =>
        other.teamId !== split.teamId && (other.teamName ?? 'No team') === name
    )
    return shared && split.seasonName != null
      ? `${name}${mark} · ${split.seasonName}`
      : `${name}${mark}`
  }
  const gameLabel = (split: StatSplit, mark: string): string => {
    const date =
      split.startAt == null
        ? 'No date'
        : years.size > 1
          ? `${formatDate(split.startAt)}, ${new Date(split.startAt).getFullYear()}`
          : formatDate(split.startAt)
    const against =
      split.opponentName == null
        ? ''
        : ` ${split.home === true ? 'vs' : '@'} ${split.opponentName}`
    const team =
      teams.size > 1 && split.teamName != null ? ` · ${split.teamName}` : ''
    return `${date}${mark}${against}${team}`
  }
  const label = by === 'team' ? teamLabel : gameLabel
  const rowKey = (split: StatSplit): string =>
    `${split.gameId ?? ''}:${split.teamId ?? ''}`
  // Numbered in the order they were played, as a doubleheader is, whatever
  // order they are drawn in.
  const played = [...among].sort((a, b) =>
    (a.startAt ?? '').localeCompare(b.startAt ?? '')
  )
  const alike = new Map<string, string[]>()
  for (const split of played) {
    const keys = alike.get(label(split, '')) ?? []
    if (!keys.includes(rowKey(split))) keys.push(rowKey(split))
    alike.set(label(split, ''), keys)
  }
  return splits.map(split => {
    const keys = alike.get(label(split, '')) ?? []
    return label(
      split,
      keys.length > 1 ? ` (${keys.indexOf(rowKey(split)) + 1})` : ''
    )
  })
}
