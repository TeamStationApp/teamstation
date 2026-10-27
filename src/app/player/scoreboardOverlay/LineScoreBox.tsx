import React from 'react'
import { StyleSheet, Text, View } from 'react-native'

import type { BoardLine } from '../../../common/scoring/boardLineTypes'
import { scoreboardTheme } from '../../scoreboard/scoreboardTheme'
import type { Rect } from '../controlGeometry'
import {
  currentInning,
  inningText,
  LINE_BORDER,
  LINE_BOX_HEIGHT,
  LINE_INNING_WIDTH,
  LINE_NAME_WIDTH,
  LINE_PAD,
  LINE_ROW,
  LINE_SIDE,
  LINE_TOTAL_WIDTH,
  lineBoxHeight,
  lineColumns,
  totalText
} from './lineScoreLayout'

/** Before the game's first step: nobody has scored, hit or erred. */
const NOTHING_YET: BoardLine = {
  away: { innings: [], r: 0, h: 0, e: 0 },
  home: { innings: [], r: 0, h: 0, e: 0 }
}

export interface LineScoreBoxProps {
  /** Where the box goes, in the player's coordinates. */
  rect: Rect
  /** The line at the playhead; null before the game's first step. */
  line: BoardLine | null
  teams: { away: string; home: string }
  /** The step's time, for the tests; null before the first step. */
  at: number | null
}

/**
 * The game's line score beside the board: one row a side, the runs in each
 * inning so far, then R, H and E, in the board's own dark palette, drawn at
 * its own units (`lineScoreLayout.ts`) and scaled into `rect` as the board
 * is scaled: as tall as six innings make it at its width
 * (`LINE_BOX_WIDTH`). The names stay on the left, taking what the innings so
 * far leave — the most in the first inning — and the totals on the right;
 * the innings in between are the latest six. R is bold: it is the score.
 *
 * Before the game's first step it is the zeroed line. It takes no touches.
 * `line-score-box`, `data-innings` (the innings shown) and `data-at` are for
 * the tests.
 */
export function LineScoreBox(
  props: LineScoreBoxProps
): React.ReactElement | null {
  const { rect, teams, at } = props
  if (!(rect.w > 0 && rect.h > 0)) return null
  const line = props.line ?? NOTHING_YET
  const scale = rect.h / LINE_BOX_HEIGHT
  const width = rect.w / scale
  // Shorter than six innings' shape at its width (one or two angles), the
  // box shows every inning its width holds.
  const compact = rect.h < lineBoxHeight(rect.w) - 0.5
  const innings = lineColumns(
    width,
    currentInning(line),
    compact ? Infinity : undefined
  )
  const row = (
    label: string,
    cells: string[],
    totals: [string, string, string],
    head: boolean
  ): React.ReactElement => (
    <View style={[styles.row, head ? styles.headRow : null]}>
      <Text numberOfLines={1} style={[styles.name, head ? styles.head : null]}>
        {label}
      </Text>
      <View style={styles.innings}>
        {cells.map((cell, index) => (
          <Text
            key={innings[index]}
            style={[styles.cell, head ? styles.head : null]}
          >
            {cell}
          </Text>
        ))}
      </View>
      {totals.map((total, index) => (
        <Text
          key={index}
          style={[
            styles.total,
            head ? styles.head : null,
            index === 0 ? styles.runs : null
          ]}
        >
          {total}
        </Text>
      ))}
    </View>
  )
  const side = (which: 'away' | 'home'): React.ReactElement =>
    row(
      teams[which],
      innings.map(inning => inningText(line[which].innings[inning - 1])),
      [
        String(line[which].r),
        totalText(line[which].h),
        totalText(line[which].e)
      ],
      false
    )
  return (
    <View
      testID="line-score-box"
      dataSet={{ innings: JSON.stringify(innings), at: String(at ?? '') }}
      pointerEvents="none"
      style={[
        styles.box,
        { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
      ]}
    >
      <View
        style={[
          styles.panel,
          {
            width,
            // Scaled about its top-left corner: a transform scales about the
            // middle, so it is moved back by what that costs first.
            transform: [
              { translateX: (-width * (1 - scale)) / 2 },
              { translateY: (-LINE_BOX_HEIGHT * (1 - scale)) / 2 },
              { scale }
            ]
          }
        ]}
      >
        {row('', innings.map(String), ['R', 'H', 'E'], true)}
        {side('away')}
        {side('home')}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  box: { position: 'absolute', overflow: 'hidden' },
  panel: {
    height: LINE_BOX_HEIGHT,
    paddingVertical: LINE_PAD,
    paddingHorizontal: LINE_SIDE,
    backgroundColor: scoreboardTheme.scoreboardBackground,
    borderColor: scoreboardTheme.scoreboardBorderColor,
    borderWidth: LINE_BORDER,
    borderRadius: scoreboardTheme.rem(0.75)
  },
  row: {
    height: LINE_ROW,
    flexDirection: 'row',
    alignItems: 'center'
  },
  headRow: {
    backgroundColor: scoreboardTheme.scoreboardBaseFill,
    borderRadius: scoreboardTheme.rem(0.25)
  },
  // The names take what the innings so far leave: the whole box less the
  // totals in the first inning, and an inning's width less with each one
  // after, down to this from the sixth. Only then is a long one cut short.
  name: {
    flex: 1,
    minWidth: LINE_NAME_WIDTH,
    paddingLeft: 6,
    color: scoreboardTheme.primaryTextColor,
    fontFamily: scoreboardTheme.secondaryTextFont,
    fontSize: 28,
    fontWeight: '600'
  },
  innings: { flexDirection: 'row' },
  cell: {
    width: LINE_INNING_WIDTH,
    textAlign: 'center',
    color: scoreboardTheme.primaryTextColor,
    fontFamily: scoreboardTheme.secondaryTextFont,
    fontSize: 28
  },
  total: {
    width: LINE_TOTAL_WIDTH,
    textAlign: 'center',
    color: scoreboardTheme.primaryTextColor,
    fontFamily: scoreboardTheme.secondaryTextFont,
    fontSize: 28
  },
  runs: { fontWeight: 'bold' },
  head: { opacity: 0.7, fontWeight: '600', fontSize: 22 }
})
