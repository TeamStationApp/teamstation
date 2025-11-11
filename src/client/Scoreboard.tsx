import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import LinearGradient from 'react-native-linear-gradient'
import { useParams } from 'react-router-dom'

import {
  asScoreState,
  type ScoreState,
  WS_RECONNECT_WAIT_MS
} from '../common/types'
import { clientConfig } from './clientConfig'
import { cacheStyles, useTheme } from './ThemeContext'
import type { Theme } from './types'

const showDemoBoard = true

const Scoreboard: React.FC = () => {
  const { eventId } = useParams<{ eventId: string }>()
  const theme = useTheme()
  const styles = getStyles(theme)
  const [scoreState, setScoreState] = useState<ScoreState>({
    inGame: false,
    pitcherName: '',
    batterName: '',
    batterNumber: 0,
    batterNumHits: 0,
    batterAtBats: 0,
    numPitches: 0,
    balls: 0,
    strikes: 0,
    outs: 0,
    base1: false,
    base2: false,
    base3: false,
    inning: 0,
    half: 'top',
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    homeScore: 10,
    awayScore: 0
  })

  useEffect(() => {
    if (eventId == null || eventId === '') {
      console.error('No eventId provided')
      return
    }

    let wsUrl: string
    // @ts-expect-error - __WEBPACK_DEV__ is injected by webpack DefinePlugin
    if (window.__WEBPACK_DEV__ === true) {
      // Development mode: use apiServer from clientConfig
      wsUrl = `${clientConfig.apiServer}/sockets/api/v1/scoreboard/${eventId}`
    } else {
      // Production mode: use window.location
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = window.location.host
      wsUrl = `${protocol}//${host}/sockets/api/v1/scoreboard/${eventId}`
    }

    let reconnectTimeout: NodeJS.Timeout | null = null
    let shouldReconnect = true

    const connect = (): void => {
      console.log('Connecting to Scoreboard WebSocket:', wsUrl)
      const ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        console.log('Scoreboard WebSocket connected')
      }

      ws.onmessage = event => {
        try {
          const rawData = JSON.parse(event.data)
          const newScoreState: ScoreState = asScoreState(rawData)
          console.log('Received scoreState update:', newScoreState)
          setScoreState(newScoreState)
        } catch (error) {
          console.error('Error parsing or validating WebSocket message:', error)
        }
      }

      ws.onerror = error => {
        console.error('Scoreboard WebSocket error:', error)
      }

      ws.onclose = () => {
        console.log('Scoreboard WebSocket disconnected')
        if (shouldReconnect) {
          console.log(`Reconnecting in ${WS_RECONNECT_WAIT_MS}ms...`)
          reconnectTimeout = setTimeout(() => {
            connect()
          }, WS_RECONNECT_WAIT_MS)
        }
      }
    }

    connect()

    // Cleanup on unmount
    return () => {
      shouldReconnect = false
      if (reconnectTimeout != null) {
        clearTimeout(reconnectTimeout)
      }
    }
  }, [eventId])

  if (!scoreState.inGame && !showDemoBoard) {
    return (
      <View style={styles.scoreboardContainer}>
        <View style={[styles.scoreboard, styles.noGameContainer]}>
          <Text style={styles.noGameText}>Waiting for game data...</Text>
          <Text style={styles.noGameSubtext}>
            Scoreboard will appear when a game starts
          </Text>
        </View>
      </View>
    )
  }

  return (
    <View style={styles.scoreboardContainer}>
      <View style={styles.scoreboard}>
        {/* Header Row: Batter abbreviation and inning */}
        <View style={styles.headerRow}>
          <Text style={styles.batterAbbrev}>
            {scoreState.batterName.toUpperCase()}
          </Text>
          <Text style={styles.batterAtBatsText}>
            {scoreState.batterNumHits}-{scoreState.batterAtBats}
          </Text>
        </View>

        {/* Separator line */}
        <View style={styles.separatorLine} />

        {/* Pitcher Row */}
        <View style={styles.pitcherRow}>
          <Text style={styles.pitcherName}>{scoreState.pitcherName}</Text>
          <Text style={styles.pitchCount}>P: {scoreState.numPitches}</Text>
        </View>

        {/* Separator line */}
        <View style={styles.separatorLine} />

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
                <Text style={styles.teamName}>{scoreState.awayTeam}</Text>
              </LinearGradient>
              <View style={styles.scoreBox}>
                <Text style={styles.scoreText}>{scoreState.awayScore}</Text>
              </View>
            </View>
            <View style={styles.teamRow}>
              <LinearGradient
                colors={theme.scoreboardTeamHomeGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.teamBox}
              >
                <Text style={styles.teamName}>{scoreState.homeTeam}</Text>
              </LinearGradient>
              <View style={styles.scoreBox}>
                <Text style={styles.scoreText}>{scoreState.homeScore}</Text>
              </View>
            </View>
          </View>

          {/* Right Side: Inning Arrows, Count, Outs, and Bases */}
          <View style={styles.rightSection}>
            {/* Inning Arrows and Outs */}
            <View style={styles.arrowsOutsColumn}>
              <View
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
              <Text style={styles.inningCount}>{scoreState.inning}</Text>
              <View
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

            {/* Count and Outs Dots */}
            <View style={styles.countOutsContainer}>
              <Text style={styles.countDisplay}>
                {scoreState.balls}-{scoreState.strikes}
              </Text>
              <View style={styles.outsDotsRow}>
                {[1, 2].map(out => (
                  <View
                    key={out}
                    style={[
                      styles.outDot,
                      out <= scoreState.outs && styles.outDotActive
                    ]}
                  />
                ))}
              </View>
            </View>

            {/* Bases Diamond */}
            <View style={styles.basesRotatedContainer}>
              <View style={styles.basesGrid}>
                {/* Second base - top center */}
                <View
                  style={[
                    styles.baseSquare,
                    styles.baseSecondPos,
                    scoreState.base2 && styles.baseSquareFilled
                  ]}
                />
                {/* First base - right */}
                <View
                  style={[
                    styles.baseSquare,
                    styles.baseFirstPos,
                    styles.baseSquareGray,
                    scoreState.base1 && styles.baseSquareFilled
                  ]}
                />
                {/* Third base - bottom left */}
                <View
                  style={[
                    styles.baseSquare,
                    styles.baseThirdPos,
                    styles.baseSquareGray,
                    scoreState.base3 && styles.baseSquareFilled
                  ]}
                />
              </View>
            </View>
          </View>
        </View>
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scoreboardContainer: {
    alignItems: 'flex-start',
    justifyContent: 'flex-start'
  },
  scoreboard: {
    backgroundColor: theme.scoreboardBackground,
    borderRadius: 12,
    padding: 8,
    shadowColor: theme.shadowColor,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
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
    paddingHorizontal: 8,
    paddingBottom: 4
  },
  batterAbbrev: {
    color: theme.primaryTextColor,
    fontSize: 20,
    fontWeight: 'bold',
    letterSpacing: 1,
    fontFamily: theme.secondaryTextFont
  },
  batterAtBatsText: {
    color: theme.primaryTextColor,
    fontSize: 20,
    fontWeight: 'bold',
    fontFamily: theme.secondaryTextFont
  },
  // Separator Line
  separatorLine: {
    height: 1,
    backgroundColor: theme.scoreboardSeparatorColor,
    marginHorizontal: 4
  },
  // Pitcher Row
  pitcherRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4
  },
  pitcherName: {
    color: theme.primaryTextColor,
    fontSize: 20,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    fontFamily: theme.secondaryTextFont
  },
  pitchCount: {
    color: theme.primaryTextColor,
    fontSize: 20,
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
    marginTop: 2,
    flexDirection: 'column',
    flex: 1
  },
  teamRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3
  },
  teamBox: {
    flex: 1,
    paddingVertical: 18,
    paddingHorizontal: 14,
    borderRadius: 6,
    marginRight: 4,
    borderWidth: 2,
    borderColor: theme.scoreboardOutlineGray
  },
  teamName: {
    color: theme.primaryTextColor,
    fontSize: 24,
    fontWeight: 'bold',
    fontFamily: theme.secondaryTextFont
  },
  scoreBox: {
    backgroundColor: theme.scoreboardScoreBackground,
    width: 70,
    height: 68,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center'
  },
  scoreText: {
    color: theme.scoreboardScoreText,
    fontSize: 48,
    fontWeight: 'bold',
    fontFamily: theme.secondaryTextFont
  },
  // Right Section
  rightSection: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 32
  },
  // Arrows and Outs Column
  arrowsOutsColumn: {
    alignItems: 'center',
    marginRight: 32
  },
  inningCount: {
    color: theme.primaryTextColor,
    fontSize: 28,
    fontWeight: 'bold',
    marginVertical: 4,
    fontFamily: theme.secondaryTextFont
  },
  // Arrow styles
  arrowOuterUp: {
    position: 'relative',
    width: 0,
    height: 0,
    borderLeftWidth: 14,
    borderRightWidth: 14,
    borderBottomWidth: 19,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginBottom: 8
  },

  arrowInnerUp: {
    position: 'absolute',
    top: 2.5,
    left: -11,
    width: 0,
    height: 0,
    borderLeftWidth: 11,
    borderRightWidth: 11,
    borderBottomWidth: 15,
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
    borderLeftWidth: 14,
    borderRightWidth: 14,
    borderTopWidth: 19,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginTop: 8
  },
  arrowInnerDown: {
    position: 'absolute',
    bottom: 2.5,
    left: -11,
    width: 0,
    height: 0,
    borderLeftWidth: 11,
    borderRightWidth: 11,
    borderTopWidth: 15,
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
    marginRight: 20
  },
  countDisplay: {
    color: theme.primaryTextColor,
    fontSize: 44,
    fontWeight: 'bold',
    marginBottom: 4,
    fontFamily: theme.secondaryTextFont
  },
  // Outs Dots Row (horizontal)
  outsDotsRow: {
    flexDirection: 'row',
    justifyContent: 'center'
  },
  outDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: theme.scoreboardOutlineGray,
    backgroundColor: theme.scoreboardBaseFill,
    marginHorizontal: 4
  },
  outDotActive: {
    backgroundColor: theme.activeColor,
    borderColor: theme.activeColor
  },
  // Bases - Rotated Container Approach
  basesRotatedContainer: {
    transform: [{ rotate: '45deg' }],
    width: 64,
    height: 56,
    justifyContent: 'center',
    alignItems: 'center'
  },
  basesGrid: {
    width: 42,
    height: 42,
    position: 'relative'
  },
  baseSquare: {
    width: 20,
    height: 20,
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
    left: 28
  },
  baseThirdPos: {
    top: 28,
    left: 0
  },
  baseSquareGray: {},
  baseSquareFilled: {
    backgroundColor: theme.activeColor,
    borderColor: theme.activeColor
  },
  // No game styles
  noGameContainer: {
    padding: 40,
    alignItems: 'center',
    justifyContent: 'center'
  },
  noGameText: {
    color: theme.primaryTextColor,
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 12,
    fontFamily: theme.secondaryTextFont
  },
  noGameSubtext: {
    color: theme.placeholderTextColor,
    fontSize: 16,
    fontFamily: theme.secondaryTextFont
  }
}))

export default Scoreboard
