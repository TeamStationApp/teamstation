import React, { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import LinearGradient from 'react-native-linear-gradient'

import {
  asScoreState,
  type ScoreState,
  WS_RECONNECT_WAIT_MS
} from '../common/types'
import { clientConfig } from './clientConfig'

const showDemoBoard = true

const BOARD_BACKGROUND = '#2d2d2d'
const OUTLINE_GRAY = '#606060'
const ACTIVE_RED = '#ef4444'
const BASE_FILL = '#383838'
const FONT_FAMILY = 'Helvetica Neue, Arial, sans-serif'

const Scoreboard: React.FC = () => {
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
    let wsUrl: string
    // @ts-expect-error - __WEBPACK_DEV__ is injected by webpack DefinePlugin
    if (window.__WEBPACK_DEV__ === true) {
      // Development mode: use apiServer from clientConfig
      wsUrl = `${clientConfig.apiServer}/sockets/api/v1/scoreboard`
    } else {
      // Production mode: use window.location
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = window.location.host
      wsUrl = `${protocol}//${host}/sockets/api/v1/scoreboard`
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
  }, [])

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
                colors={['#003087', '#3266ad']}
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
                colors={['#8B4513', '#DAA520']}
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

const styles = StyleSheet.create({
  scoreboardContainer: {
    alignItems: 'flex-start',
    justifyContent: 'flex-start'
  },
  scoreboard: {
    backgroundColor: BOARD_BACKGROUND,
    borderRadius: 12,
    padding: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    borderWidth: 2,
    borderColor: '#4d4d4d',
    fontFamily: FONT_FAMILY
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
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
    letterSpacing: 1,
    fontFamily: FONT_FAMILY
  },
  batterAtBatsText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
    fontFamily: FONT_FAMILY
  },
  // Separator Line
  separatorLine: {
    height: 1,
    backgroundColor: '#555',
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
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    fontFamily: FONT_FAMILY
  },
  pitchCount: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
    fontFamily: FONT_FAMILY
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
    borderColor: OUTLINE_GRAY
  },
  teamName: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
    fontFamily: FONT_FAMILY
  },
  scoreBox: {
    backgroundColor: '#fff',
    width: 70,
    height: 68,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center'
  },
  scoreText: {
    color: '#000',
    fontSize: 48,
    fontWeight: 'bold',
    fontFamily: FONT_FAMILY
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
    color: '#fff',
    fontSize: 28,
    fontWeight: 'bold',
    marginVertical: 4,
    fontFamily: FONT_FAMILY
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
    borderBottomColor: ACTIVE_RED
  },
  arrowOuterInactiveUp: {
    borderBottomColor: OUTLINE_GRAY
  },
  arrowInnerActiveUp: {
    borderBottomColor: ACTIVE_RED
  },
  arrowInnerInactiveUp: {
    borderBottomColor: BASE_FILL
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
    borderTopColor: ACTIVE_RED
  },
  arrowOuterInactiveDown: {
    borderTopColor: OUTLINE_GRAY
  },
  arrowInnerActiveDown: {
    borderTopColor: ACTIVE_RED
  },
  arrowInnerInactiveDown: {
    borderTopColor: BASE_FILL
  },
  // Count and Outs Container
  countOutsContainer: {
    alignItems: 'center',
    marginRight: 20
  },
  countDisplay: {
    color: '#fff',
    fontSize: 44,
    fontWeight: 'bold',
    marginBottom: 4,
    fontFamily: FONT_FAMILY
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
    borderColor: OUTLINE_GRAY,
    backgroundColor: BASE_FILL,
    marginHorizontal: 4
  },
  outDotActive: {
    backgroundColor: ACTIVE_RED,
    borderColor: ACTIVE_RED
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
    backgroundColor: BASE_FILL,
    borderWidth: 2,
    borderColor: OUTLINE_GRAY,
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
    backgroundColor: ACTIVE_RED,
    borderColor: ACTIVE_RED
  },
  // No game styles
  noGameContainer: {
    padding: 40,
    alignItems: 'center',
    justifyContent: 'center'
  },
  noGameText: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 12,
    fontFamily: FONT_FAMILY
  },
  noGameSubtext: {
    color: '#999',
    fontSize: 16,
    fontFamily: FONT_FAMILY
  }
})

export default Scoreboard
