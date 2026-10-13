import React from 'react'
import { ScrollView, Text, View } from 'react-native'

import type {
  ReplayBoxScore as Box,
  ReplaySide
} from '../../common/replay/replayBoxScore'
import { ordinal } from '../../common/scoring/lineup'
import { scoringSurface as surface } from '../theme/scoringSurface'
import { useTheme } from '../theme/ThemeContext'

export interface ReplayBoxScoreProps {
  box: Box
  /** Room left clear under the last row, for the pause button. */
  bottomInset?: number
}

const NAME = 112
const COLUMN = 30

/**
 * The replay's box score as of the step on screen: the line score, then each
 * side's batters in batting order and pitchers in the order they pitched, on
 * the scoring screen's dark green.
 */
export function ReplayBoxScore(props: ReplayBoxScoreProps): React.ReactElement {
  const { box } = props
  const theme = useTheme()
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
  const lineRow = (side: ReplaySide): React.ReactElement => (
    <View style={{ flexDirection: 'row', paddingVertical: 3 }}>
      {text(side.name, { width: NAME, strong: true })}
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
    cells: React.ReactElement[]
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
  const team = (side: ReplaySide): React.ReactElement => (
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
          text(`${line.sub ? '  ' : ''}${line.name}`, { width: NAME }),
          text(line.ab),
          text(line.r),
          text(line.h),
          text(line.rbi),
          text(line.bb),
          text(line.k)
        ])
      )}
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
          text(line.name, { width: NAME }),
          text(line.ip),
          text(line.h),
          text(line.r),
          text(line.er),
          text(line.bb),
          text(line.k),
          text(line.pc)
        ])
      )}
    </View>
  )
  return (
    <ScrollView
      testID="replay-box-score"
      style={{ flex: 1, backgroundColor: surface.canvas }}
      contentContainerStyle={{
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: props.bottomInset ?? 88
      }}
    >
      {box.from != null && (
        <Text
          style={{
            color: surface.secondaryText,
            fontFamily: theme.regularTextFont,
            fontSize: 12,
            paddingBottom: 6
          }}
        >
          {`Stats from the ${box.from.half} of the ${ordinal(box.from.inning)} — earlier innings were imported`}
        </Text>
      )}
      <View
        style={{
          flexDirection: 'row',
          borderBottomWidth: 1,
          borderBottomColor: surface.divider,
          paddingBottom: 3
        }}
      >
        {text('', { width: NAME })}
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
      {team(box.away)}
      {team(box.home)}
    </ScrollView>
  )
}
