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

  // Set transparent background for scoreboard (for OBS chroma key)
  useEffect(() => {
    const originalBodyBg = document.body.style.backgroundColor
    const originalHtmlBg = document.documentElement.style.backgroundColor

    document.body.style.backgroundColor = 'transparent'
    document.documentElement.style.backgroundColor = 'transparent'

    return () => {
      document.body.style.backgroundColor = originalBodyBg
      document.documentElement.style.backgroundColor = originalHtmlBg
    }
  }, [])

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
        {scoreState.batterName.trim() !== '' ||
        scoreState.pitcherName.trim() !== '' ? (
          <>
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
    paddingVertical: theme.rem(1.25),
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
    fontFamily: theme.secondaryTextFont
  },
  scoreBox: {
    backgroundColor: theme.scoreboardScoreBackground,
    width: theme.rem(4.5),
    height: theme.rem(4.25),
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
    marginLeft: theme.rem(2)
  },
  // Arrows and Outs Column
  arrowsOutsColumn: {
    alignItems: 'center',
    marginRight: theme.rem(2)
  },
  inningCount: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(1.75),
    fontWeight: 'bold',
    marginVertical: theme.rem(0.25),
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
    marginBottom: theme.rem(0.5)
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
    marginTop: theme.rem(0.5)
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
  // Bases - Rotated Container Approach
  basesRotatedContainer: {
    transform: [{ rotate: '45deg' }],
    width: theme.rem(4),
    height: theme.rem(3.5),
    justifyContent: 'center',
    alignItems: 'center'
  },
  basesGrid: {
    width: theme.rem(2.75),
    height: theme.rem(2.75),
    position: 'relative'
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
  },
  // No game styles
  noGameContainer: {
    padding: theme.rem(2.5),
    alignItems: 'center',
    justifyContent: 'center'
  },
  noGameText: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(1.5),
    fontWeight: 'bold',
    marginBottom: theme.rem(0.75),
    fontFamily: theme.secondaryTextFont
  },
  noGameSubtext: {
    color: theme.placeholderTextColor,
    fontSize: theme.rem(1),
    fontFamily: theme.secondaryTextFont
  }
}))

export default Scoreboard
