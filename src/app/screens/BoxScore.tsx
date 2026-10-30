import React from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle
} from 'react-native'

import type {
  BattingRow,
  BoxScore as BoxScoreData,
  GameDetail,
  LineScoreSide,
  PitchingRow
} from '../../common/api'
import type { Side } from '../../common/scoring/state'
import { FrozenNameTable } from '../components/FrozenNameTable'
import { TickerText } from '../components/TickerText'
import { usePaneWidth } from '../components/useBreakpoint'
import { lstrings } from '../locales/strings'
import { cacheStyles } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'
import { battingTotals, pitchingTotals } from './boxScoreTotals'
import type { StatColumn } from './statColumns'

/** A player's name, below the line score's: all nine figures fit a phone. */
const PLAYER_NAME_REM = 5.75

/**
 * The line score's names take the width of the longer name, from a floor, and
 * never so much of a phone that the innings have nowhere to scroll.
 */
const LINE_NAME_MIN_REM = 6.5
const LINE_NAME_MAX_SHARE = 0.45

export interface BoxScoreProps {
  game: GameDetail
  /** `undefined` while it is still loading. */
  box: BoxScoreData | undefined
  theme: Theme
  /** Away and home side by side, rather than one at a time. */
  sideBySide: boolean
  membershipAccess?: React.ReactNode
  /**
   * A coach's side, which comes first in one column: its batters, then its
   * pitchers, then the opponent's batters and pitchers.
   */
  first?: Side
  /**
   * Each side's batting order as it stands. A side given one lists its whole
   * order: those who have come to the plate, in the order they first did,
   * then those who have not, in this order, on empty lines.
   */
  lineups?: Readonly<Partial<Record<Side, readonly LineupBatter[]>>>
  /**
   * Opening a line. The game's season and the side that line belongs to go
   * with it, so the player's stats open on the season being read rather than
   * on a career total nobody asked for. The side goes again as `onTeam`, the
   * team a coach's Settings tab edits the player on.
   */
  onOpenPlayer?: (
    userId: string,
    name: string,
    from?: { seasonId?: string; teamId?: string; onTeam?: string }
  ) => void
}

/** A batter in a side's batting order as it stands. */
export interface LineupBatter {
  /** Null for a player the scorer made up, who has no user. */
  userId: string | null
  shortName: string
  /** Their id in the game, which a withdrawn line names when it is theirs. */
  gumboId?: number | null
}

/**
 * A line in a batting table: the server's, or an empty one for a batter in
 * the order who has not come to the plate, who may have no user.
 */
export type BattingLine = Omit<BattingRow, 'userId'> & {
  userId: string | null
}

/**
 * The box score: the innings across the top, then each side's batting and
 * pitching.
 *
 * Away on the left and home on the right, the same way round as the card above
 * — and the same way round as every scoreboard ever printed. On a phone there
 * is no room for two columns, so the four tables run one under another, home
 * first, which is a scroll rather than four decisions.
 *
 * A side with no batting lines, or no pitching lines, leaves that section
 * out. A side's batting and pitching each end with their totals, and the
 * line score above totals the game.
 *
 * Every table keeps its names outside the sideways scroll, so a row scrolled
 * to its last column is still somebody's, on the phone as in a browser.
 *
 * A coach reads his own team's first (`first`), whatever the width, and
 * before the game an empty line score over "The game has not started", so
 * his first look is never a blank page.
 */
export function BoxScore(props: BoxScoreProps): React.ReactElement {
  const { game, box, theme, sideBySide, first, lineups, onOpenPlayer } = props
  const styles = getStyles(theme)

  // The innings and the runs are a non-member's; each side's lines are not.
  if (game.nonMemberView) {
    return (
      <View style={styles.boxScore}>
        <LineScore game={game} theme={theme} />
        {props.membershipAccess ?? (
          <Text accessibilityRole="alert" style={styles.notice}>
            {lstrings.box_score_members_only}
          </Text>
        )}
      </View>
    )
  }

  if (box == null) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.primaryTextColor} />
      </View>
    )
  }

  const sides = [
    { key: 'away', teamId: game.awayTeamId, name: game.awayTeamName },
    { key: 'home', teamId: game.homeTeamId, name: game.homeTeamName }
  ] as const

  const tables = (side: (typeof sides)[number]): React.ReactElement => {
    const batting = battingOrder(
      box.batting.filter(row => row.teamId === side.teamId),
      lineups?.[side.key],
      side.teamId
    )
    const pitching = box.pitching.filter(row => row.teamId === side.teamId)
    const open =
      onOpenPlayer == null
        ? undefined
        : (userId: string, name: string) => {
            onOpenPlayer(userId, name, {
              seasonId: game.seasonId ?? undefined,
              teamId: side.teamId,
              onTeam: side.teamId
            })
          }
    return (
      <View style={styles.boxSide}>
        <BattingTable
          name={side.name}
          rows={batting}
          theme={theme}
          onOpenPlayer={open}
        />
        <PitchingTable
          name={side.name}
          rows={pitching}
          theme={theme}
          onOpenPlayer={open}
        />
      </View>
    )
  }

  const notStarted = first != null && game.linescore == null
  return (
    <View style={styles.boxScore}>
      <LineScore game={game} theme={theme} empty={notStarted} />
      {notStarted && (
        <Text style={styles.notice}>{lstrings.box_score_not_started}</Text>
      )}

      {first != null ? (
        <View style={styles.boxSide}>
          {[...sides]
            .sort((a, b) => (a.key === first ? -1 : b.key === first ? 1 : 0))
            .map(side => (
              <View key={side.key}>{tables(side)}</View>
            ))}
        </View>
      ) : sideBySide ? (
        <View style={styles.boxColumns}>
          {sides.map(side => (
            <View key={side.key} style={styles.boxColumn}>
              {tables(side)}
            </View>
          ))}
        </View>
      ) : (
        // One long column rather than a row of pills. Four tables of nine
        // rows is a scroll, not a decision, and a pill for each is four taps
        // to read what one thumb can.
        <View style={styles.boxSide}>
          {[...sides].reverse().map(side => (
            <View key={side.key}>{tables(side)}</View>
          ))}
        </View>
      )}
    </View>
  )
}

/**
 * A side's batters in the order they first came to the plate, as the server
 * sends them, then, given its batting order as it stands, everyone else in
 * that order: a line the server sent for one who has not batted (a pinch
 * runner who scored), or an empty one. Lines for players out of the order who
 * never batted come last. Without an order, the server's lines stand.
 */
export function battingOrder(
  rows: readonly BattingRow[],
  lineup?: readonly LineupBatter[],
  teamId: string | null = null
): BattingLine[] {
  if (lineup == null) return [...rows]
  const batted = rows.filter(row => row.pa > 0)
  // A withdrawn line names the batter it stands in for, whom the order may
  // still name, with an account (a pool player left in a game under way)
  // or none: in his place the order shows the line, never his name.
  const standIn = new Map(
    rows.flatMap(row =>
      row.standsFor == null ? [] : [[row.standsFor, row] as const]
    )
  )
  const inOrder = (row: BattingRow): boolean =>
    (row.userId != null &&
      lineup.some(batter => batter.userId === row.userId)) ||
    (row.standsFor != null &&
      lineup.some(batter => batter.gumboId === row.standsFor))
  const waiting = lineup.flatMap(batter => {
    const line =
      batter.gumboId == null ? undefined : standIn.get(batter.gumboId)
    // One who batted is already above; one yet to bat waits in his slot.
    if (line != null) return line.pa > 0 ? [] : [line]
    if (batter.userId == null) return [emptyLine(batter, teamId)]
    if (batted.some(row => row.userId === batter.userId)) return []
    return [
      rows.find(row => row.userId === batter.userId) ??
        emptyLine(batter, teamId)
    ]
  })
  return [
    ...batted,
    ...waiting,
    ...rows.filter(row => row.pa === 0 && !inOrder(row))
  ]
}

/** The line of a batter who has not come to the plate: all noughts. */
function emptyLine(batter: LineupBatter, teamId: string | null): BattingLine {
  return {
    userId: batter.userId,
    // Only a line that names somebody opens anything.
    openable: batter.userId != null,
    shortName: batter.shortName,
    teamId,
    g: 0,
    pa: 0,
    ab: 0,
    h: 0,
    singles: 0,
    doubles: 0,
    triples: 0,
    hr: 0,
    bb: 0,
    k: 0,
    r: 0,
    hbp: 0,
    rbi: 0,
    sb: 0,
    cs: 0,
    sf: 0,
    sh: 0,
    roe: null,
    fc: null,
    pik: null,
    rates: {
      avg: undefined,
      obp: undefined,
      slg: undefined,
      ops: undefined,
      sbPct: undefined
    },
    seasonAvg: null,
    standsFor: null,
    gumboIds: []
  }
}

/**
 * Runs by inning, the way a scoreboard draws them, with the totals at the end.
 *
 * Hits and errors sit beside the runs because that is where fifty years of
 * scoreboards have put them; home runs and hit batters follow, since both are
 * counted from the plays and neither fits in a batting table without crowding
 * the columns that matter.
 */
function LineScore(props: {
  game: GameDetail
  theme: Theme
  /** Without a line score, draw it with no innings and no totals. */
  empty?: boolean
}): React.ReactElement | null {
  const { game, theme, empty = false } = props
  const styles = getStyles(theme)
  const paneWidth = usePaneWidth()
  const line: Record<'away' | 'home', ShownSide> | null =
    game.linescore ?? (empty ? { away: NO_RUNS, home: NO_RUNS } : null)
  if (line == null) return null

  const innings = Math.max(line.away.runs.length, line.home.runs.length)
  const rows: LineScoreRow[] = [
    { key: 'away', name: game.awayTeamName, side: line.away },
    { key: 'home', name: game.homeTeamName, side: line.home }
  ]
  // Runs, hits, errors and home runs. A hit batter belongs in the pitcher's
  // line and the batter's, not up here beside the innings. A non-member is sent
  // the runs alone.
  const counted = !game.nonMemberView
  const columns: Array<StatColumn<LineScoreRow>> = [
    ...Array.from({ length: innings }, (unused, index) => ({
      label: String(index + 1),
      sample: '9',
      value: (row: LineScoreRow) => String(row.side.runs[index] ?? '–')
    })),
    {
      label: 'R',
      sample: '99',
      strong: true,
      value: row => String(row.side.r ?? '–')
    },
    ...(counted
      ? [
          {
            label: 'H',
            value: (row: LineScoreRow) => String(row.side.h ?? '–')
          },
          {
            label: 'E',
            value: (row: LineScoreRow) => String(row.side.e ?? '–')
          },
          {
            label: 'HR',
            value: (row: LineScoreRow) => String(row.side.hr ?? '–')
          }
        ]
      : [])
  ]

  return (
    // Seven innings and five totals is wider than a phone. The innings scroll
    // sideways under the team names rather than being cut off at the runs
    // column, which is the half somebody opened the box score for.
    <View style={styles.lineScore}>
      <FrozenNameTable
        heading=""
        rows={rows}
        columns={columns}
        rowKey={row => row.key}
        rowLabel={row => row.name}
        compact
        namesGrow={false}
        nameWidth={LINE_NAME_MIN_REM}
        nameMaxWidth={(LINE_NAME_MAX_SHARE * paneWidth) / theme.rem(1)}
        columnWidth={2}
        headBackground={theme.cardBackgroundColor}
        nameBackground={theme.cardBackgroundColor}
        name={row => (
          <TickerText style={styles.cellName}>{row.name}</TickerText>
        )}
      />
    </View>
  )
}

/** A side's line in the line score, whose runs are unknown before the game. */
type ShownSide = Pick<LineScoreSide, 'runs' | 'h' | 'e' | 'hr'> & {
  r: number | null
}
const NO_RUNS: ShownSide = { runs: [], r: null, h: null, e: null, hr: null }

/** One side's row of the line score. */
interface LineScoreRow {
  key: 'away' | 'home'
  name: string
  side: ShownSide
}

/**
 * A person's name, frozen beside their figures: the target that opens them.
 *
 * At least 44 points tall and the width of the column, so the thumb that
 * lands near a name lands on it. A line with no one to open is plain text.
 */
function NameCell(props: {
  name: string
  theme: Theme
  onPress?: () => void
}): React.ReactElement {
  const { name, theme, onPress } = props
  const styles = getStyles(theme)
  const text = <TickerText style={styles.cellName}>{name}</TickerText>
  if (onPress == null) return <View style={styles.nameCell}>{text}</View>
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={onPress}
      style={({ pressed }) => [
        styles.nameCell,
        pressed && styles.playerRowPressed
      ]}
    >
      {text}
    </Pressable>
  )
}

/** The totals line's name, which is nobody and opens nothing. */
function TotalsCell(props: { theme: Theme }): React.ReactElement {
  const styles = getStyles(props.theme)
  return (
    <View style={styles.nameCell}>
      <Text style={[styles.cellName, styles.cellStrong]} numberOfLines={1}>
        {lstrings.box_score_totals}
      </Text>
    </View>
  )
}

function BattingTable(props: {
  name: string
  rows: BattingLine[]
  theme: Theme
  onOpenPlayer?: (userId: string, name: string) => void
}): React.ReactElement | null {
  const { name, rows, theme, onOpenPlayer } = props
  if (rows.length === 0) return null
  const styles = getStyles(theme)
  // The server preserves each side’s first plate-appearance order.
  return (
    <View style={styles.table}>
      <Text style={styles.heading}>
        {lstrings.game_batting} — {name}
      </Text>
      <FrozenNameTable
        heading={lstrings.stats_player}
        rows={rows}
        columns={battingColumns}
        rowKey={(line, index) => line.userId ?? `made-up-${index}`}
        rowLabel={line => line.shortName ?? ''}
        compact
        nameWidth={PLAYER_NAME_REM}
        headBackground={theme.backgroundColor}
        nameBackground={theme.backgroundColor}
        total={{
          row: battingTotals(rows),
          label: lstrings.box_score_totals,
          name: <TotalsCell theme={theme} />
        }}
        name={line => {
          const { userId } = line
          const shown = line.shortName ?? ''
          return (
            <NameCell
              name={shown}
              theme={theme}
              onPress={
                onOpenPlayer == null || userId == null || !line.openable
                  ? undefined
                  : () => {
                      onOpenPlayer(userId, shown)
                    }
              }
            />
          )
        }}
      />
    </View>
  )
}

function PitchingTable(props: {
  name: string
  rows: PitchingRow[]
  theme: Theme
  onOpenPlayer?: (userId: string, name: string) => void
}): React.ReactElement | null {
  const { name, rows, theme, onOpenPlayer } = props
  if (rows.length === 0) return null
  const styles = getStyles(theme)
  return (
    <View style={styles.table}>
      <Text style={styles.heading}>
        {lstrings.game_pitching} — {name}
      </Text>
      <FrozenNameTable
        heading={lstrings.stats_player}
        rows={rows}
        columns={pitchingColumns}
        rowKey={(line, index) => line.userId ?? `withdrawn-${index}`}
        rowLabel={line => line.shortName ?? ''}
        compact
        nameWidth={PLAYER_NAME_REM}
        headBackground={theme.backgroundColor}
        nameBackground={theme.backgroundColor}
        total={{
          row: pitchingTotals(rows),
          label: lstrings.box_score_totals,
          name: <TotalsCell theme={theme} />
        }}
        name={line => {
          const { userId } = line
          const shown = line.shortName ?? ''
          return (
            <NameCell
              name={shown}
              theme={theme}
              onPress={
                onOpenPlayer == null || userId == null || !line.openable
                  ? undefined
                  : () => {
                      onOpenPlayer(userId, shown)
                    }
              }
            />
          )
        }}
      />
    </View>
  )
}

const pitchingColumns: Array<StatColumn<PitchingRow>> = [
  { label: lstrings.stats_innings, sample: '9.2', value: row => row.ip },
  { label: 'BF', value: row => String(row.bf) },
  { label: lstrings.stats_hits, value: row => String(row.h) },
  { label: lstrings.stats_runs, value: row => String(row.r) },
  // Earned runs, worked out by replaying the inning the way a scorebook
  // does — the one figure on this line that a play-by-play cannot produce.
  { label: lstrings.stats_earned_runs, value: row => String(row.er) },
  { label: lstrings.stats_walks, value: row => String(row.bb) },
  { label: lstrings.stats_strikeouts, value: row => String(row.k) },
  { label: 'HR', value: row => String(row.hr) },
  { label: 'HBP', value: row => String(row.hbp) }
]

const battingColumns: Array<StatColumn<BattingLine>> = [
  { label: lstrings.stats_at_bats, value: row => String(row.ab) },
  { label: lstrings.stats_hits, value: row => String(row.h) },
  { label: lstrings.stats_runs, value: row => String(row.r) },
  { label: lstrings.stats_runs_batted_in, value: row => String(row.rbi) },
  { label: lstrings.stats_walks, value: row => String(row.bb) },
  { label: lstrings.stats_strikeouts, value: row => String(row.k) },
  { label: 'HR', value: row => String(row.hr) },
  { label: 'HBP', value: row => String(row.hbp) },
  {
    // The season's, not the afternoon's: three at-bats say nothing about a
    // hitter, and the number beside a name is read as what kind of hitter
    // they are.
    label: lstrings.stats_average,
    value: row => (row.seasonAvg == null ? '–' : average(row.seasonAvg)),
    sample: '1.000'
  }
]

/** `.667`, in the way a box score writes it: no leading zero. */
export function average(value: number | undefined): string {
  if (value == null) return lstrings.stats_no_average
  return value.toFixed(3).replace(/^0/, '')
}

/** `M:SS`, or `H:MM:SS` once a game runs past the hour. */

/**
 * The box score's styles, named: left to inference, a style sheet this size
 * checked ahead of the rest of the app sends the native type check into an
 * instantiation it gives up on.
 */
type BoxStyles = Record<
  | 'centre'
  | 'heading'
  | 'boxSide'
  | 'boxColumns'
  | 'boxColumn'
  | 'lineScore'
  | 'cellStrong'
  | 'boxScore'
  | 'table'
  | 'nameCell'
  | 'playerRowPressed'
  | 'cellName'
  | 'notice',
  ViewStyle & TextStyle
>

const getStyles = cacheStyles((theme: Theme) =>
  StyleSheet.create<BoxStyles>({
    centre: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.backgroundColor,
      padding: theme.rem(1)
    },
    heading: {
      color: theme.primaryTextColor,
      fontFamily: theme.boldTextFont,
      fontSize: theme.rem(1.1),
      paddingHorizontal: theme.rem(0.75),
      paddingTop: theme.rem(0.75)
    },
    boxSide: {
      gap: theme.rem(theme.spaceMdRem)
    },
    boxColumns: {
      width: '100%',
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.rem(theme.spaceLgRem)
    },
    boxColumn: {
      flex: 1,
      // Or the wider of the two tables spills over the other.
      overflow: 'hidden',
      // Zero basis in a row measures the width, which is what is wanted here:
      // two even columns, away on the left and home on the right, the same way
      // round as the card above them.
      flexBasis: 0,
      minWidth: 0
    },
    lineScore: {
      borderWidth: 1,
      borderColor: theme.defaultBorderColor,
      borderRadius: theme.rem(theme.radiusRem),
      backgroundColor: theme.cardBackgroundColor,
      overflow: 'hidden',
      paddingVertical: theme.rem(theme.spaceXsRem)
    },
    cellStrong: {
      fontFamily: theme.boldTextFont,
      fontWeight: '700',
      color: theme.primaryTextColor
    },
    boxScore: {
      // No cap: the whole point of a wide window here is two sides at once,
      // and a reading-width cap made for a line of text held both tables to
      // half of one column.
      width: '100%',
      gap: theme.rem(theme.spaceMdRem),
      paddingBottom: theme.rem(1)
    },
    table: { paddingBottom: theme.rem(0.5) },
    // A person's name, which opens their page: the whole cell is the target.
    nameCell: {
      flex: 1,
      alignSelf: 'stretch',
      minHeight: 44,
      // A taller target than its row, overhanging both sides.
      marginVertical: -5,
      justifyContent: 'center'
    },
    playerRowPressed: {
      backgroundColor: theme.highlightRowActiveBackground
    },
    cellName: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9)
    },
    // A notice the reader has to read, not a hint: the page's own text
    // colour on the page's own background.
    notice: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(1),
      lineHeight: theme.rem(1.4),
      textAlign: 'center'
    }
  })
)
