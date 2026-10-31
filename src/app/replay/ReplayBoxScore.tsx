import React from 'react'
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import {
  battingTotals,
  pitchingTotals,
  type ReplayBoxScore as Box,
  type ReplaySide
} from '../../common/replay/replayBoxScore'
import { ordinal } from '../../common/scoring/lineup'
import { scaledSize } from '../components/FrozenNameTable'
import { scoringSurface as surface } from '../theme/scoringSurface'
import { useTheme } from '../theme/ThemeContext'

export interface ReplayBoxScoreProps {
  box: Box
  /** Room left clear under the last row, for the pause button. */
  bottomInset?: number
  /** Who may be opened, by their id on these lines; anybody else is text. */
  players?: ReadonlyMap<number, string>
  onOpenPlayer?: (userId: string, name: string) => void
}

const NAME = 112
const LINE_ROW = 22
const COLUMN = 30

/**
 * The replay's box score as of the step on screen: the line score, then each
 * side's batters in batting order and pitchers in the order they pitched, on
 * the scoring screen's dark green.
 */
export function ReplayBoxScore(props: ReplayBoxScoreProps): React.ReactElement {
  const { box } = props
  const theme = useTheme()
  const { fontScale } = useWindowDimensions()
  const figures = React.useRef<React.ComponentRef<typeof ScrollView>>(null)
  const text = (
    value: string | number,
    options: { width?: number; strong?: boolean; color?: string } = {}
  ): React.ReactElement => (
    <Text
      numberOfLines={1}
      style={{
        width: options.width ?? COLUMN,
        textAlign: options.width === NAME ? 'left' : 'center',
        color: options.color ?? surface.text,
        fontFamily:
          options.strong === true
            ? theme.semiBoldTextFont
            : theme.regularTextFont,
        fontSize: 12
      }}
    >
      {value}
    </Text>
  )
  const innings = Math.max(box.away.innings.length, box.home.innings.length)
  // Every row one fixed height in both halves, which is what keeps a name level
  // with its figures whatever its text measures.
  const lineCell = {
    height: scaledSize(LINE_ROW, fontScale),
    justifyContent: 'center'
  } as const
  const lineHead = {
    ...lineCell,
    borderBottomWidth: 1,
    borderBottomColor: surface.divider,
    paddingBottom: 3
  }
  const lineRow = (side: ReplaySide): React.ReactElement => (
    <View style={[lineCell, { flexDirection: 'row', alignItems: 'center' }]}>
      {Array.from({ length: innings }, (_, i) => (
        <React.Fragment key={i}>
          {text(side.innings[i] == null ? '' : String(side.innings[i]))}
        </React.Fragment>
      ))}
      {text(side.runs, { strong: true })}
      {text(side.hits)}
      {text(side.errors)}
    </View>
  )
  const heading = (
    title: string,
    label: string,
    columns: string[]
  ): React.ReactElement => (
    <View style={{ paddingTop: 12 }}>
      <Text
        style={{
          color: surface.activeText,
          fontFamily: theme.semiBoldTextFont,
          fontSize: 13,
          paddingBottom: 4
        }}
      >
        {title}
      </Text>
      <View
        style={{
          flexDirection: 'row',
          paddingBottom: 3,
          borderBottomWidth: 1,
          borderBottomColor: surface.divider
        }}
      >
        {text(label, { width: NAME, strong: true, color: surface.accent })}
        {columns.map(column => (
          <React.Fragment key={column}>
            {text(column, { color: surface.accent })}
          </React.Fragment>
        ))}
      </View>
    </View>
  )
  const row = (
    key: string,
    current: boolean,
    cells: React.ReactNode[]
  ): React.ReactElement => (
    <View
      key={key}
      testID={current ? 'replay-box-current' : undefined}
      style={{
        flexDirection: 'row',
        paddingVertical: 4,
        backgroundColor: current ? surface.active : surface.idle,
        borderBottomWidth: 1,
        borderBottomColor: surface.canvas
      }}
    >
      {cells.map((cell, index) => (
        <React.Fragment key={index}>{cell}</React.Fragment>
      ))}
    </View>
  )
  /** A line's name, which opens them when this reader may. */
  const nameCell = (
    id: number,
    name: string,
    shown = name
  ): React.ReactNode => {
    const userId = props.players?.get(id)
    const cell = text(shown, { width: NAME })
    const { onOpenPlayer } = props
    if (userId == null || onOpenPlayer == null) return cell
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${name}`}
        onPress={() => {
          onOpenPlayer(userId, name)
        }}
        // A taller target than its row, overhanging both sides.
        style={{ minHeight: 44, marginVertical: -11, justifyContent: 'center' }}
      >
        {cell}
      </Pressable>
    )
  }
  /**
   * A table's last line: its columns added up, under a name that is nobody,
   * so it is never the batter or the pitcher on screen.
   */
  const totalsRow = (
    key: string,
    cells: Array<string | number>
  ): React.ReactElement =>
    row(key, false, [
      text('Totals', { width: NAME, strong: true }),
      ...cells.map(cell => text(cell, { strong: true }))
    ])
  const team = (side: ReplaySide): React.ReactElement => {
    const hitting = battingTotals(side.batting)
    const throwing = pitchingTotals(side.pitching)
    return (
      <View key={side.name}>
        {heading(`${side.name} batting`, 'Batter', [
          'AB',
          'R',
          'H',
          'RBI',
          'BB',
          'K'
        ])}
        {side.batting.map(line =>
          row(`b${line.id}`, line.current, [
            nameCell(line.id, line.name, `${line.sub ? '  ' : ''}${line.name}`),
            text(line.ab),
            text(line.r),
            text(line.h),
            text(line.rbi),
            text(line.bb),
            text(line.k)
          ])
        )}
        {side.batting.length > 0 &&
          totalsRow(`b-totals-${side.name}`, [
            hitting.ab,
            hitting.r,
            hitting.h,
            hitting.rbi,
            hitting.bb,
            hitting.k
          ])}
        {heading(`${side.name} pitching`, 'Pitcher', [
          'IP',
          'H',
          'R',
          'ER',
          'BB',
          'K',
          'PC'
        ])}
        {side.pitching.map(line =>
          row(`p${line.id}`, line.current, [
            nameCell(line.id, line.name),
            text(line.ip),
            text(line.h),
            text(line.r),
            text(line.er),
            text(line.bb),
            text(line.k),
            text(line.pc)
          ])
        )}
        {side.pitching.length > 0 &&
          totalsRow(`p-totals-${side.name}`, [
            throwing.ip,
            throwing.h,
            throwing.r,
            throwing.er,
            throwing.bb,
            throwing.k,
            throwing.pc
          ])}
      </View>
    )
  }
  return (
    <ScrollView
      testID="replay-box-score"
      style={{ flex: 1, backgroundColor: surface.canvas }}
      contentContainerStyle={{
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: props.bottomInset ?? 88,
        alignItems: 'center'
      }}
    >
      {box.from != null && (
        <Text
          style={{
            alignSelf: 'stretch',
            textAlign: 'center',
            color: surface.secondaryText,
            fontFamily: theme.regularTextFont,
            fontSize: 12,
            paddingBottom: 6
          }}
        >
          {`Stats from the ${box.from.half} of the ${ordinal(box.from.inning)} — earlier innings were imported`}
        </Text>
      )}
      {/*
        The line score and the tables, each as wide as its widest row and
        centred. A long game's line score outgrows the side deck from five
        innings and a phone held upright from six: its team names stay where
        they are while the innings and R/H/E scroll beside them, rather than
        the runs being cut off.
      */}
      <View
        testID="replay-box-score-line"
        style={{ alignSelf: 'center', maxWidth: '100%', flexDirection: 'row' }}
      >
        <View>
          <View style={lineHead} />
          {(
            [
              ['away', box.away],
              ['home', box.home]
            ] as const
          ).map(([key, side]) => (
            <View key={key} style={lineCell}>
              {text(side.name, { width: NAME, strong: true })}
            </View>
          ))}
        </View>
        <ScrollView
          testID="replay-box-score-line-figures"
          ref={figures}
          horizontal
          // The inning being played and R, H and E, not the first innings.
          onContentSizeChange={() => {
            figures.current?.scrollToEnd({ animated: false })
          }}
          style={{ flexShrink: 1 }}
        >
          <View>
            <View
              style={[lineHead, { flexDirection: 'row', alignItems: 'center' }]}
            >
              {Array.from({ length: innings }, (_, i) => (
                <React.Fragment key={i}>
                  {text(i + 1, { color: surface.accent })}
                </React.Fragment>
              ))}
              {text('R', { color: surface.accent })}
              {text('H', { color: surface.accent })}
              {text('E', { color: surface.accent })}
            </View>
            {lineRow(box.away)}
            {lineRow(box.home)}
          </View>
        </ScrollView>
      </View>
      <View
        testID="replay-box-score-column"
        style={{ alignSelf: 'center', maxWidth: '100%' }}
      >
        {team(box.away)}
        {team(box.home)}
      </View>
    </ScrollView>
  )
}
