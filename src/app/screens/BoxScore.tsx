import React from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextStyle,
  useWindowDimensions,
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
import { webStyle } from '../components/glass'
import { WideTable } from '../components/WideTable'
import { lstrings } from '../locales/strings'
import { cacheStyles } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'
import {
  STAT_COLUMN_GAP_REM,
  type StatColumn,
  statColumnWidths
} from './statColumns'

export interface BoxScoreProps {
  game: GameDetail
  /** `undefined` while it is still loading. */
  box: BoxScoreData | undefined
  theme: Theme
  /** Away and home side by side, rather than one at a time. */
  sideBySide: boolean
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
    userId: number,
    name: string,
    from?: { seasonId?: string; teamId?: string; onTeam?: string }
  ) => void
}

/** A batter in a side's batting order as it stands. */
export interface LineupBatter {
  /** Null for a player the scorer made up, who has no user. */
  userId: number | null
  shortName: string
}

/**
 * A line in a batting table: the server's, or an empty one for a batter in
 * the order who has not come to the plate, who may have no user.
 */
export type BattingLine = Omit<BattingRow, 'userId'> & {
  userId: number | null
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
 * out. The totals are still in the line score above.
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
        <Text accessibilityRole="alert" style={styles.notice}>
          {lstrings.box_score_members_only}
        </Text>
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
        : (userId: number, name: string) => {
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
  const inOrder = (row: BattingRow): boolean =>
    lineup.some(batter => batter.userId === row.userId)
  const waiting = lineup.flatMap(batter =>
    batted.some(row => row.userId === batter.userId)
      ? []
      : [
          rows.find(row => row.userId === batter.userId) ??
            emptyLine(batter, teamId)
        ]
  )
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
    seasonAvg: null
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
  const line: Record<'away' | 'home', ShownSide> | null =
    game.linescore ?? (empty ? { away: NO_RUNS, home: NO_RUNS } : null)
  if (line == null) return null

  const innings = Math.max(line.away.runs.length, line.home.runs.length)
  const sides = [
    { name: game.awayTeamName, side: line.away },
    { name: game.homeTeamName, side: line.home }
  ]
  // Runs, hits, errors and home runs. A hit batter belongs in the pitcher's
  // line and the batter's, not up here beside the innings. A non-member is sent
  // the runs alone.
  const counted = !game.nonMemberView
  const totals = counted ? ['R', 'H', 'E', 'HR'] : ['R']

  return (
    // Seven innings and five totals is wider than a phone. It scrolls sideways
    // rather than being cut off at the runs column, which is the half somebody
    // opened the box score for.
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.lineScore}
      contentContainerStyle={styles.lineScoreContent}
    >
      <View style={[styles.tableRow, styles.tableHead]}>
        <Text
          style={[styles.cellName, styles.cellHead, styles.lineScoreName]}
          numberOfLines={1}
        />
        {Array.from({ length: innings }, (unused, index) => (
          <Text key={index} style={[styles.cell, styles.cellHead]}>
            {index + 1}
          </Text>
        ))}
        {totals.map(label => (
          <Text key={label} style={[styles.cell, styles.cellHead]}>
            {label}
          </Text>
        ))}
      </View>
      {sides.map(({ name, side }) => (
        <View key={name} style={styles.tableRow}>
          <Text
            style={[styles.cellName, styles.lineScoreName]}
            numberOfLines={1}
          >
            {name}
          </Text>
          {Array.from({ length: innings }, (unused, index) => (
            <Text key={index} style={styles.cell}>
              {side.runs[index] ?? '–'}
            </Text>
          ))}
          <Text style={[styles.cell, styles.cellStrong]}>{side.r ?? '–'}</Text>
          {counted && (
            <>
              <Text style={styles.cell}>{side.h ?? '–'}</Text>
              <Text style={styles.cell}>{side.e ?? '–'}</Text>
              <Text style={styles.cell}>{side.hr ?? '–'}</Text>
            </>
          )}
        </View>
      ))}
    </ScrollView>
  )
}

/** A side's line in the line score, whose runs are unknown before the game. */
type ShownSide = Pick<LineScoreSide, 'runs' | 'h' | 'e' | 'hr'> & {
  r: number | null
}
const NO_RUNS: ShownSide = { runs: [], r: null, h: null, e: null, hr: null }

function statCellSize(
  theme: Theme,
  width: number,
  index: number
): { width: number; paddingLeft: number; fontVariant: Array<'tabular-nums'> } {
  const gap = index === 0 ? 0 : STAT_COLUMN_GAP_REM
  return {
    width: theme.rem(width + gap),
    paddingLeft: theme.rem(gap),
    fontVariant: ['tabular-nums']
  }
}

/**
 * One person's line, in any of the four tables.
 *
 * The whole row is the target rather than the name: a name is a few characters
 * at one end of a row read on a phone at the edge of a field, and the rest of
 * the row is the part the thumb actually lands on.
 */
function StatRow(props: {
  name: string
  cells: string[]
  widths: number[]
  theme: Theme
  onPress?: () => void
}): React.ReactElement {
  const { name, cells, widths, theme, onPress } = props
  const styles = getStyles(theme)
  const content = (
    <>
      <Text style={[styles.cellName, styles.statName]} numberOfLines={1}>
        {name}
      </Text>
      {cells.map((value, index) => (
        <Text
          key={index}
          style={[styles.cell, statCellSize(theme, widths[index], index)]}
          // A figure is one line. Whatever it measures, it must not be
          // allowed to make its row taller than the row above.
          numberOfLines={1}
        >
          {value}
        </Text>
      ))}
    </>
  )
  if (onPress == null) {
    return <View style={[styles.tableRow, styles.playerRow]}>{content}</View>
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tableRow,
        styles.playerRow,
        pressed && styles.playerRowPressed
      ]}
    >
      {content}
    </Pressable>
  )
}

function BattingTable(props: {
  name: string
  rows: BattingLine[]
  theme: Theme
  onOpenPlayer?: (userId: number, name: string) => void
}): React.ReactElement | null {
  const { name, rows, theme, onOpenPlayer } = props
  const { fontScale } = useWindowDimensions()
  if (rows.length === 0) return null
  const styles = getStyles(theme)
  // The server preserves each side’s first plate-appearance order.
  const lines = rows
  const widths = statColumnWidths(
    battingColumns,
    rows,
    0.8125,
    0.8125,
    0,
    fontScale
  )
  return (
    <View style={styles.table}>
      <Text style={styles.heading}>
        {lstrings.game_batting} — {name}
      </Text>
      <WideTable>
        <View style={[styles.tableRow, styles.tableHead]}>
          <Text style={[styles.cellName, styles.statName, styles.cellHead]}>
            {lstrings.stats_player}
          </Text>
          {battingColumns.map((column, index) => (
            <Text
              key={column.label}
              style={[
                styles.cell,
                styles.cellHead,
                statCellSize(theme, widths[index], index)
              ]}
              numberOfLines={1}
            >
              {column.label}
            </Text>
          ))}
        </View>
        {lines.map((line, index) => {
          const { userId } = line
          return (
            <StatRow
              key={userId ?? `made-up-${index}`}
              name={line.shortName ?? ''}
              cells={battingColumns.map(column => column.value(line))}
              widths={widths}
              theme={theme}
              onPress={
                onOpenPlayer == null || userId == null
                  ? undefined
                  : () => {
                      onOpenPlayer(userId, line.shortName ?? '')
                    }
              }
            />
          )
        })}
      </WideTable>
    </View>
  )
}

function PitchingTable(props: {
  name: string
  rows: PitchingRow[]
  theme: Theme
  onOpenPlayer?: (userId: number, name: string) => void
}): React.ReactElement | null {
  const { name, rows, theme, onOpenPlayer } = props
  const { fontScale } = useWindowDimensions()
  if (rows.length === 0) return null
  const styles = getStyles(theme)
  const widths = statColumnWidths(
    pitchingColumns,
    rows,
    0.8125,
    0.8125,
    0,
    fontScale
  )
  return (
    <View style={styles.table}>
      <Text style={styles.heading}>
        {lstrings.game_pitching} — {name}
      </Text>
      <WideTable>
        <View style={[styles.tableRow, styles.tableHead]}>
          <Text style={[styles.cellName, styles.statName, styles.cellHead]}>
            {lstrings.stats_player}
          </Text>
          {pitchingColumns.map((column, index) => (
            <Text
              key={column.label}
              style={[
                styles.cell,
                styles.cellHead,
                statCellSize(theme, widths[index], index)
              ]}
              numberOfLines={1}
            >
              {column.label}
            </Text>
          ))}
        </View>
        {rows.map(line => (
          <StatRow
            key={line.userId}
            name={line.shortName ?? ''}
            cells={pitchingColumns.map(column => column.value(line))}
            widths={widths}
            theme={theme}
            onPress={
              onOpenPlayer == null
                ? undefined
                : () => {
                    onOpenPlayer(line.userId, line.shortName ?? '')
                  }
            }
          />
        ))}
      </WideTable>
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
  | 'lineScoreContent'
  | 'lineScoreName'
  | 'cellStrong'
  | 'boxScore'
  | 'table'
  | 'tableRow'
  | 'tableHead'
  | 'playerRow'
  | 'playerRowPressed'
  | 'cellName'
  | 'statName'
  | 'cell'
  | 'cellHead'
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
      flexGrow: 0,
      borderWidth: 1,
      borderColor: theme.defaultBorderColor,
      borderRadius: theme.rem(theme.radiusRem),
      backgroundColor: theme.cardBackgroundColor,
      paddingHorizontal: theme.rem(theme.spaceSmRem),
      paddingVertical: theme.rem(theme.spaceXsRem)
    },
    lineScoreContent: {
      flexDirection: 'column'
    },
    // The line score is a white card, so its pinned names are white too. The
    // page colour `cellName` paints is for the tables that sit on the page.
    lineScoreName: {
      backgroundColor: theme.cardBackgroundColor
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
    table: { paddingBottom: theme.rem(0.5), overflow: 'hidden' },
    tableRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: theme.rem(0.75),
      paddingVertical: theme.rem(0.3)
    },
    tableHead: {
      borderBottomColor: theme.defaultBorderColor,
      borderBottomWidth: 1
    },
    // A line about a person, which opens their page. The head row and the
    // line score keep the tighter `tableRow`: neither is a target, and
    // growing them would spend the height these rows just took.
    playerRow: {
      minHeight: theme.rem(2.75),
      paddingVertical: theme.rem(theme.spaceSmRem)
    },
    playerRowPressed: {
      backgroundColor: theme.highlightRowActiveBackground
    },
    cellName: {
      color: theme.primaryTextColor,
      // Wide enough for a name before anything else gets a say, and greedy
      // for whatever a wide window has left over. It never gives any back:
      // inside a horizontal scroll a shrinking name is a column of ellipses
      // where there was room to scroll instead.
      flexBasis: theme.rem(6.5),
      flexGrow: 1,
      flexShrink: 0,
      // And pinned, so a row scrolled to its last column is still somebody's.
      // `sticky` is a position React Native has no name for; this app renders
      // to the DOM, where it does. The background is what the numbers pass
      // under rather than through.
      ...webStyle({ position: 'sticky', left: 0, zIndex: 1 }),
      backgroundColor: theme.backgroundColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.9)
    },
    statName: { minWidth: theme.rem(6.5) },
    cell: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.8125),
      // Fixed, so the columns of two tables beside each other line up and
      // neither can push the other out of its half.
      width: theme.rem(2),
      flexGrow: 0,
      flexShrink: 0,
      textAlign: 'right'
    },
    cellHead: {
      color: theme.secondaryTextColor,
      fontFamily: theme.semiBoldTextFont
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
