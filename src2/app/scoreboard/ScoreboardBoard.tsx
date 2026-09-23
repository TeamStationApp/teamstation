import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import LinearGradient from 'react-native-linear-gradient'

import {
  SCOREBOARD_BOARD_SIZE,
  type ScoreboardState
} from '../../common/scoreboard'
import { type ScoreboardTheme, scoreboardTheme } from './scoreboardTheme'

/**
 * The scoreboard as OBS and GS Director draw it over video: 1.0's
 * `src/client/Scoreboard.tsx`, copied. The same React Native components,
 * drawn on the web by react-native-web as 1.0's were, with 1.0's style
 * sheet, fonts and gradients unchanged, and its theme values copied into
 * `scoreboardTheme`.
 *
 * It draws the `state` prop, where 1.0 kept its own socket and state. 1.0's
 * demo switch and its "waiting for game data" card are gone: it draws the
 * board whatever `inGame` says, so a game that has not started still shows
 * its teams and score. The board itself is 1.0's, so a longer team name
 * widens it and the height stays the height of the rows.
 *
 * With no state at all it paints nothing but keeps an empty box of
 * `SCOREBOARD_BOARD_SIZE`, which is what a live page shows until its first
 * state arrives and what a quiet page shows once its board has closed.
 * Otherwise the page would measure as the whole web view.
 */
declare module 'react-native' {
  // react-native-web writes `dataSet` as `data-*` attributes, which is how
  // the tests and the pages' end-to-end checks find the board's parts.
  interface ViewProps {
    dataSet?: Record<string, string>
  }
  interface TextProps {
    dataSet?: Record<string, string>
  }
}

export interface ScoreboardBoardProps {
  /** What to draw; nothing but the empty root while it is undefined. */
  state?: ScoreboardState
}

export function ScoreboardBoard(
  props: ScoreboardBoardProps
): React.ReactElement {
  const { state } = props
  if (state == null) {
    return (
      <View dataSet={{ scoreboard: 'board', drawn: 'false' }} style={empty} />
    )
  }
  return <Scoreboard scoreState={state} />
}

/**
 * The box a page keeps while it has nothing to draw. 1.0 had no equivalent:
 * its page always drew a board or the waiting card.
 */
const empty = StyleSheet.create({
  root: {
    width: SCOREBOARD_BOARD_SIZE.width,
    height: SCOREBOARD_BOARD_SIZE.height
  }
}).root

const theme = scoreboardTheme

function Scoreboard(props: {
  scoreState: ScoreboardState
}): React.ReactElement {
  const { scoreState } = props
  return (
    <View style={styles.scoreboardContainer}>
      <View
        dataSet={{ scoreboard: 'board', drawn: 'true' }}
        style={styles.scoreboard}
      >
        {scoreState.batterName.trim() !== '' ||
        scoreState.pitcherName.trim() !== '' ? (
          <>
            {/* Header Row: Batter abbreviation and inning */}
            <View style={styles.headerRow}>
              <Text
                dataSet={{ scoreboard: 'batter' }}
                style={styles.batterAbbrev}
              >
                {scoreState.batterName.toUpperCase()}
              </Text>
              <Text
                dataSet={{ scoreboard: 'batterLine' }}
                style={styles.batterAtBatsText}
              >
                {scoreState.batterNumHits}-{scoreState.batterAtBats}
              </Text>
            </View>

            {/* Separator line */}
            <View style={styles.separatorLine} />

            {/* Pitcher Row */}
            <View style={styles.pitcherRow}>
              <Text
                dataSet={{ scoreboard: 'pitcher' }}
                style={styles.pitcherName}
              >
                {scoreState.pitcherName}
              </Text>
              <Text
                dataSet={{ scoreboard: 'pitches' }}
                style={styles.pitchCount}
              >
                P: {scoreState.numPitches}
              </Text>
            </View>

            {/* Separator line */}
            <View style={styles.separatorLine} />
          </>
        ) : null}

        {/* Main Content Row */}
        <View style={styles.mainRow}>
          {/* Teams and Scores */}
          <View style={styles.teamsSection}>
            <View style={styles.teamRow}>
              <LinearGradient
                colors={theme.scoreboardTeamAwayGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.teamBox}
              >
                <Text
                  dataSet={{ scoreboard: 'awayTeam' }}
                  style={styles.teamName}
                >
                  {scoreState.awayTeam}
                </Text>
              </LinearGradient>
              <View style={styles.scoreBox}>
                <Text
                  dataSet={{ scoreboard: 'awayScore' }}
                  style={styles.scoreText}
                >
                  {scoreState.awayScore}
                </Text>
              </View>
            </View>
            <View style={styles.teamRow}>
              <LinearGradient
                colors={theme.scoreboardTeamHomeGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.teamBox}
              >
                <Text
                  dataSet={{ scoreboard: 'homeTeam' }}
                  style={styles.teamName}
                >
                  {scoreState.homeTeam}
                </Text>
              </LinearGradient>
              <View style={styles.scoreBox}>
                <Text
                  dataSet={{ scoreboard: 'homeScore' }}
                  style={styles.scoreText}
                >
                  {scoreState.homeScore}
                </Text>
              </View>
            </View>
          </View>

          {/* Right Side: Inning Arrows, Count, Outs, and Bases */}
          <View style={styles.rightSection}>
            {/* Inning Arrows and Outs */}
            <View style={styles.arrowsOutsColumn}>
              <View
                dataSet={{
                  scoreboard: 'top',
                  lit: String(scoreState.half === 'top')
                }}
                style={[
                  styles.arrowOuterUp,
                  scoreState.half === 'top'
                    ? styles.arrowOuterActiveUp
                    : styles.arrowOuterInactiveUp
                ]}
              >
                <View
                  style={[
                    styles.arrowInnerUp,
                    scoreState.half === 'top'
                      ? styles.arrowInnerActiveUp
                      : styles.arrowInnerInactiveUp
                  ]}
                />
              </View>
              <Text
                dataSet={{ scoreboard: 'inning' }}
                style={styles.inningCount}
              >
                {scoreState.inning}
              </Text>
              <View
                dataSet={{
                  scoreboard: 'bottom',
                  lit: String(scoreState.half === 'bottom')
                }}
                style={[
                  styles.arrowOuterDown,
                  scoreState.half === 'bottom'
                    ? styles.arrowOuterActiveDown
                    : styles.arrowOuterInactiveDown
                ]}
              >
                <View
                  style={[
                    styles.arrowInnerDown,
                    scoreState.half === 'bottom'
                      ? styles.arrowInnerActiveDown
                      : styles.arrowInnerInactiveDown
                  ]}
                />
              </View>
            </View>

            <View style={styles.inningCountSeparator} />

            {/* Count and Outs Dots */}
            <View style={styles.countOutsContainer}>
              <Text
                dataSet={{ scoreboard: 'count' }}
                style={styles.countDisplay}
              >
                {scoreState.balls}-{scoreState.strikes}
              </Text>
              <View style={styles.outsDotsRow}>
                {[1, 2].map(out => (
                  <View
                    key={out}
                    dataSet={{
                      scoreboard: 'out',
                      lit: String(out <= scoreState.outs)
                    }}
                    style={[
                      styles.outDot,
                      out <= scoreState.outs && styles.outDotActive
                    ]}
                  />
                ))}
              </View>
            </View>

            {/* Bases Diamond + Pitch Speed */}
            <View style={styles.basesAndSpeedColumn}>
              <View style={styles.basesRotatedContainer}>
                <View style={styles.basesGrid}>
                  {/* Second base - top center */}
                  <View
                    dataSet={{
                      scoreboard: 'base2',
                      lit: String(scoreState.base2)
                    }}
                    style={[
                      styles.baseSquare,
                      styles.baseSecondPos,
                      scoreState.base2 && styles.baseSquareFilled
                    ]}
                  />
                  {/* First base - right */}
                  <View
                    dataSet={{
                      scoreboard: 'base1',
                      lit: String(scoreState.base1)
                    }}
                    style={[
                      styles.baseSquare,
                      styles.baseFirstPos,
                      styles.baseSquareGray,
                      scoreState.base1 && styles.baseSquareFilled
                    ]}
                  />
                  {/* Third base - bottom left */}
                  <View
                    dataSet={{
                      scoreboard: 'base3',
                      lit: String(scoreState.base3)
                    }}
                    style={[
                      styles.baseSquare,
                      styles.baseThirdPos,
                      styles.baseSquareGray,
                      scoreState.base3 && styles.baseSquareFilled
                    ]}
                  />
                </View>
              </View>
              {/* Always render the pitch-speed slot so the bases diamond
                  above it doesn't reflow when the value transitions
                  to/from 0. The slot keeps its full footprint; only the
                  text becomes transparent when there's no live reading. */}
              <View
                dataSet={{
                  scoreboard: 'pitchSpeed',
                  lit: String(scoreState.pitchSpeed !== 0)
                }}
                style={[
                  styles.pitchSpeedContainer,
                  scoreState.pitchSpeed === 0 && styles.pitchSpeedHidden
                ]}
              >
                <Text style={styles.pitchSpeedNumber}>
                  {scoreState.pitchSpeed}
                </Text>
                <View style={styles.pitchSpeedLettersColumn}>
                  <Text style={styles.pitchSpeedLetter}>M</Text>
                  <Text style={styles.pitchSpeedLetter}>P</Text>
                  <Text style={styles.pitchSpeedLetter}>H</Text>
                </View>
              </View>
            </View>
          </View>
        </View>
      </View>
    </View>
  )
}

/**
 * 1.0's `getStyles`, without the styles of the card it no longer draws.
 * Its type is the style sheet it makes, which is too long to write out.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const getStyles = (theme: ScoreboardTheme) => {
  const teamScoreBoxHeight = theme.rem(3.5)
  // Horizontal gap: score → inning, inning column → vertical line, and line
  // → balls/strikes (rightSection.marginLeft, arrowsOutsColumn.marginRight,
  // inningCountSeparator.marginRight).
  const gapScoreToInning = theme.rem(1)
  return StyleSheet.create({
    scoreboardContainer: {
      alignItems: 'flex-start',
      justifyContent: 'flex-start'
    },
    scoreboard: {
      backgroundColor: theme.scoreboardBackground,
      borderRadius: theme.rem(0.75),
      padding: theme.rem(0.5),
      shadowColor: theme.shadowColor,
      shadowOffset: { width: 0, height: theme.rem(0.25) },
      shadowOpacity: 0.3,
      shadowRadius: theme.rem(0.5),
      elevation: 8,
      borderWidth: 2,
      borderColor: theme.scoreboardBorderColor,
      fontFamily: theme.secondaryTextFont
    },
    // Header Row
    headerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.rem(0.5),
      paddingBottom: theme.rem(0.25)
    },
    batterAbbrev: {
      color: theme.primaryTextColor,
      fontSize: theme.rem(1.25),
      fontWeight: 'bold',
      letterSpacing: 1,
      fontFamily: theme.secondaryTextFont
    },
    batterAtBatsText: {
      color: theme.primaryTextColor,
      fontSize: theme.rem(1.25),
      fontWeight: 'bold',
      fontFamily: theme.secondaryTextFont
    },
    // Separator Line
    separatorLine: {
      height: 1,
      backgroundColor: theme.scoreboardSeparatorColor,
      marginHorizontal: theme.rem(0.25)
    },
    // Same 1px thickness and color as separatorLine; vertical between inning
    // column and balls/strikes.
    inningCountSeparator: {
      width: 1,
      alignSelf: 'stretch',
      backgroundColor: theme.scoreboardSeparatorColor,
      marginLeft: 0,
      marginRight: gapScoreToInning
    },
    // Pitcher Row
    pitcherRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.rem(0.5),
      paddingVertical: theme.rem(0.25)
    },
    pitcherName: {
      color: theme.primaryTextColor,
      fontSize: theme.rem(1.25),
      fontWeight: 'bold',
      textTransform: 'uppercase',
      fontFamily: theme.secondaryTextFont
    },
    pitchCount: {
      color: theme.primaryTextColor,
      fontSize: theme.rem(1.25),
      fontWeight: 'bold',
      fontFamily: theme.secondaryTextFont
    },
    // Main Row
    mainRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between'
    },
    // Teams Section
    teamsSection: {
      marginTop: 1,
      flexDirection: 'column',
      flex: 1
    },
    teamRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 1.5
    },
    teamBox: {
      flex: 1,
      height: teamScoreBoxHeight,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: theme.rem(1),
      borderRadius: theme.rem(0.5),
      marginRight: theme.rem(0.25),
      borderWidth: 2,
      borderColor: theme.scoreboardOutlineGray
    },
    teamName: {
      color: theme.primaryTextColor,
      fontSize: theme.rem(1.5),
      fontWeight: 'bold',
      textAlign: 'center',
      fontFamily: theme.secondaryTextFont
    },
    scoreBox: {
      backgroundColor: theme.scoreboardScoreBackground,
      width: theme.rem(4.5),
      height: teamScoreBoxHeight,
      borderRadius: theme.rem(0.25),
      alignItems: 'center',
      justifyContent: 'center'
    },
    scoreText: {
      color: theme.scoreboardScoreText,
      fontSize: theme.rem(3),
      fontWeight: 'bold',
      fontFamily: theme.secondaryTextFont
    },
    // Right Section
    rightSection: {
      flexDirection: 'row',
      alignItems: 'center',
      marginLeft: gapScoreToInning
    },
    // Arrows and Outs Column
    arrowsOutsColumn: {
      alignItems: 'center',
      marginRight: gapScoreToInning
    },
    inningCount: {
      color: theme.primaryTextColor,
      fontSize: theme.rem(2.25),
      fontWeight: 'bold',
      marginVertical: theme.rem(0.0625),
      fontFamily: theme.secondaryTextFont
    },
    // Arrow styles
    arrowOuterUp: {
      position: 'relative',
      width: 0,
      height: 0,
      borderLeftWidth: theme.rem(0.875),
      borderRightWidth: theme.rem(0.875),
      borderBottomWidth: theme.rem(1.1875),
      borderLeftColor: 'transparent',
      borderRightColor: 'transparent',
      marginBottom: theme.rem(0.125)
    },

    arrowInnerUp: {
      position: 'absolute',
      top: theme.rem(0.15625),
      left: theme.rem(-0.6875),
      width: 0,
      height: 0,
      borderLeftWidth: theme.rem(0.6875),
      borderRightWidth: theme.rem(0.6875),
      borderBottomWidth: theme.rem(0.9375),
      borderLeftColor: 'transparent',
      borderRightColor: 'transparent'
    },
    arrowOuterActiveUp: {
      borderBottomColor: theme.activeColor
    },
    arrowOuterInactiveUp: {
      borderBottomColor: theme.scoreboardOutlineGray
    },
    arrowInnerActiveUp: {
      borderBottomColor: theme.activeColor
    },
    arrowInnerInactiveUp: {
      borderBottomColor: theme.scoreboardBaseFill
    },
    arrowOuterDown: {
      position: 'relative',
      width: 0,
      height: 0,
      borderLeftWidth: theme.rem(0.875),
      borderRightWidth: theme.rem(0.875),
      borderTopWidth: theme.rem(1.1875),
      borderLeftColor: 'transparent',
      borderRightColor: 'transparent',
      marginTop: theme.rem(0.125)
    },
    arrowInnerDown: {
      position: 'absolute',
      bottom: theme.rem(0.15625),
      left: theme.rem(-0.6875),
      width: 0,
      height: 0,
      borderLeftWidth: theme.rem(0.6875),
      borderRightWidth: theme.rem(0.6875),
      borderTopWidth: theme.rem(0.9375),
      borderLeftColor: 'transparent',
      borderRightColor: 'transparent'
    },
    arrowOuterActiveDown: {
      borderTopColor: theme.activeColor
    },
    arrowOuterInactiveDown: {
      borderTopColor: theme.scoreboardOutlineGray
    },
    arrowInnerActiveDown: {
      borderTopColor: theme.activeColor
    },
    arrowInnerInactiveDown: {
      borderTopColor: theme.scoreboardBaseFill
    },
    // Count and Outs Container
    countOutsContainer: {
      alignItems: 'center',
      marginRight: theme.rem(1.25)
    },
    countDisplay: {
      color: theme.primaryTextColor,
      fontSize: theme.rem(2.75),
      fontWeight: 'bold',
      marginBottom: theme.rem(0.25),
      fontFamily: theme.secondaryTextFont
    },
    // Outs Dots Row (horizontal)
    outsDotsRow: {
      flexDirection: 'row',
      justifyContent: 'center'
    },
    outDot: {
      width: theme.rem(1.25),
      height: theme.rem(1.25),
      borderRadius: theme.rem(0.75),
      borderWidth: 2,
      borderColor: theme.scoreboardOutlineGray,
      backgroundColor: theme.scoreboardBaseFill,
      marginHorizontal: theme.rem(0.25)
    },
    outDotActive: {
      backgroundColor: theme.activeColor,
      borderColor: theme.activeColor
    },
    // Bases + Pitch Speed column
    basesAndSpeedColumn: {
      alignItems: 'center',
      justifyContent: 'flex-start'
    },
    // Bases - Rotated Container Approach
    basesRotatedContainer: {
      transform: [{ rotate: '45deg' }],
      width: theme.rem(4),
      height: theme.rem(2.75),
      justifyContent: 'center',
      alignItems: 'center',
      marginTop: theme.rem(1)
    },
    basesGrid: {
      width: theme.rem(2.75),
      height: theme.rem(2.75),
      position: 'relative'
    },
    // Pitch Speed (below bases): number + vertical "M","P","H" to the right
    pitchSpeedContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: theme.rem(0.25)
    },
    pitchSpeedNumber: {
      color: theme.primaryTextColor,
      fontSize: theme.rem(2.75),
      fontWeight: 'bold',
      lineHeight: theme.rem(2.75),
      fontFamily: theme.secondaryTextFont
    },
    pitchSpeedLettersColumn: {
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: theme.rem(0.25)
    },
    pitchSpeedLetter: {
      color: theme.primaryTextColor,
      fontSize: theme.rem(0.75),
      fontWeight: 'bold',
      lineHeight: theme.rem(0.8),
      fontFamily: theme.secondaryTextFont
    },
    // Layout-preserving "hidden" state for the pitch-speed slot: the View
    // still occupies its full size (so the bases above don't reflow when
    // the speed clears to 0), but renders nothing visible. Aria-hide via
    // `accessibilityElementsHidden` would be appropriate on a native UI;
    // on web/OBS chroma-key this is purely visual.
    pitchSpeedHidden: {
      opacity: 0
    },
    baseSquare: {
      width: theme.rem(1.25),
      height: theme.rem(1.25),
      backgroundColor: theme.scoreboardBaseFill,
      borderWidth: 2,
      borderColor: theme.scoreboardOutlineGray,
      position: 'absolute'
    },
    // Position each base
    baseSecondPos: {
      top: 0,
      left: 0
    },
    baseFirstPos: {
      top: 0,
      left: theme.rem(1.75)
    },
    baseThirdPos: {
      top: theme.rem(1.75),
      left: 0
    },
    baseSquareGray: {},
    baseSquareFilled: {
      backgroundColor: theme.activeColor,
      borderColor: theme.activeColor
    }
  })
}

export const styles = getStyles(scoreboardTheme)
