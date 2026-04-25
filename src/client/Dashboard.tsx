import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { useParams } from 'react-router-dom'

import {
  asAutoStateMessage,
  asOverrideUpdateMessage,
  type DashboardOverrides,
  WS_RECONNECT_WAIT_MS
} from '../common/types'
import { clientConfig } from './clientConfig'
import { cacheStyles, useTheme } from './ThemeContext'
import type { Theme } from './types'

const Dashboard: React.FC = () => {
  const { eventId } = useParams<{ eventId: string }>()
  const theme = useTheme()
  const styles = getStyles(theme)
  const [overrideEnabled, setOverrideEnabled] = useState(false)

  // Refs to track current values (for use in WebSocket callbacks)
  const overrideEnabledRef = useRef(false)

  const [overrideBalls, setOverrideBalls] = useState(0)
  const [overrideStrikes, setOverrideStrikes] = useState(0)
  const [overrideOuts, setOverrideOuts] = useState(0)
  const [autoBalls, setAutoBalls] = useState(0)
  const [autoStrikes, setAutoStrikes] = useState(0)
  const [autoOuts, setAutoOuts] = useState(0)
  const [overrideBasesEnabled, setOverrideBasesEnabled] = useState(false)
  const [autoBase1, setAutoBase1] = useState(false)
  const [autoBase2, setAutoBase2] = useState(false)
  const [autoBase3, setAutoBase3] = useState(false)
  const [overrideBase1, setOverrideBase1] = useState(false)
  const [overrideBase2, setOverrideBase2] = useState(false)
  const [overrideBase3, setOverrideBase3] = useState(false)
  const overrideBasesEnabledRef = useRef(false)

  // Team overrides
  const [overrideTeamEnabled, setOverrideTeamEnabled] = useState(false)
  const [autoHomeTeam, setAutoHomeTeam] = useState('')
  const [autoAwayTeam, setAutoAwayTeam] = useState('')
  const [overrideHomeTeam, setOverrideHomeTeam] = useState('')
  const [overrideAwayTeam, setOverrideAwayTeam] = useState('')
  const overrideTeamEnabledRef = useRef(false)

  // Score overrides
  const [overrideScoreEnabled, setOverrideScoreEnabled] = useState(false)
  const [autoHomeScore, setAutoHomeScore] = useState(0)
  const [autoAwayScore, setAutoAwayScore] = useState(0)
  const [overrideHomeScore, setOverrideHomeScore] = useState(0)
  const [overrideAwayScore, setOverrideAwayScore] = useState(0)
  const overrideScoreEnabledRef = useRef(false)

  // Inning state
  const [autoInning, setAutoInning] = useState(1)
  const [autoHalf, setAutoHalf] = useState<'top' | 'bottom' | 'mid'>('top')
  const [overrideInningEnabled, setOverrideInningEnabled] = useState(false)
  const [overrideInning, setOverrideInning] = useState(1)
  const [overrideHalf, setOverrideHalf] = useState<'top' | 'bottom' | 'mid'>(
    'top'
  )
  const overrideInningEnabledRef = useRef(false)

  // Number picker state
  const [showScorePicker, setShowScorePicker] = useState<
    'home' | 'away' | 'inning' | null
  >(null)
  const [pickerPosition, setPickerPosition] = useState({ x: 0, y: 0 })

  const wsRef = useRef<WebSocket | null>(null)
  const isReceivingMessageRef = useRef(false)
  const pickerScrollRef = useRef<any>(null)

  // Keep refs in sync with state
  useEffect(() => {
    overrideEnabledRef.current = overrideEnabled
  }, [overrideEnabled])

  useEffect(() => {
    overrideBasesEnabledRef.current = overrideBasesEnabled
  }, [overrideBasesEnabled])

  useEffect(() => {
    overrideTeamEnabledRef.current = overrideTeamEnabled
  }, [overrideTeamEnabled])

  useEffect(() => {
    overrideScoreEnabledRef.current = overrideScoreEnabled
  }, [overrideScoreEnabled])

  useEffect(() => {
    overrideInningEnabledRef.current = overrideInningEnabled
  }, [overrideInningEnabled])

  const incrementBalls = (): void => {
    if (!overrideEnabled) setOverrideEnabled(true)
    if (overrideBalls < 3) setOverrideBalls(overrideBalls + 1)
  }

  const incrementStrikes = (): void => {
    if (!overrideEnabled) setOverrideEnabled(true)
    if (overrideStrikes < 2) setOverrideStrikes(overrideStrikes + 1)
  }

  const incrementOuts = (): void => {
    if (!overrideEnabled) setOverrideEnabled(true)
    if (overrideOuts < 2) setOverrideOuts(overrideOuts + 1)
  }

  const clearBalls = (): void => {
    if (!overrideEnabled) setOverrideEnabled(true)
    setOverrideBalls(0)
  }

  const clearStrikes = (): void => {
    if (!overrideEnabled) setOverrideEnabled(true)
    setOverrideStrikes(0)
  }

  const clearOuts = (): void => {
    if (!overrideEnabled) setOverrideEnabled(true)
    setOverrideOuts(0)
  }

  const toggleBase1 = (): void => {
    setOverrideBasesEnabled(true)
    setOverrideBase1(!overrideBase1)
  }

  const toggleBase2 = (): void => {
    setOverrideBasesEnabled(true)
    setOverrideBase2(!overrideBase2)
  }

  const toggleBase3 = (): void => {
    setOverrideBasesEnabled(true)
    setOverrideBase3(!overrideBase3)
  }

  const handleTopArrowPress = (): void => {
    setOverrideInningEnabled(true)
    if (overrideHalf === 'top') {
      // If already top, switch to mid
      setOverrideHalf('mid')
    } else {
      setOverrideHalf('top')
    }
  }

  const handleBottomArrowPress = (): void => {
    setOverrideInningEnabled(true)
    if (overrideHalf === 'bottom') {
      // If already bottom, switch to mid
      setOverrideHalf('mid')
    } else {
      setOverrideHalf('bottom')
    }
  }

  const handleInningNumberPress = (): void => {
    setOverrideInningEnabled(true)
    setOverrideInning(overrideInning + 1)
  }

  const handleInningNumberLongPress = (event: {
    nativeEvent: { pageX: number; pageY: number }
  }): void => {
    setOverrideInningEnabled(true)
    const nativeEvent = event.nativeEvent
    setPickerPosition({ x: nativeEvent.pageX, y: nativeEvent.pageY })
    setShowScorePicker('inning' as any)
  }

  const handleReset = (): void => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'reset' }))
      console.log('Sent reset request for current session')
    }
  }

  // Function to send overrides to server
  const sendOverrides = useCallback((): void => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const overrides: DashboardOverrides = {
        overrideCountEnabled: overrideEnabled,
        overrideBasesEnabled,
        overrideTeamEnabled,
        overrideScoreEnabled,
        overrideInningEnabled,
        overrideCount: undefined,
        overrideBases: undefined,
        overrideTeam: undefined,
        overrideScore: undefined,
        overrideInning: undefined
      }

      if (overrideEnabled) {
        overrides.overrideCount = {
          balls: overrideBalls,
          strikes: overrideStrikes,
          outs: overrideOuts
        }
      }

      if (overrideBasesEnabled) {
        overrides.overrideBases = {
          base1: overrideBase1,
          base2: overrideBase2,
          base3: overrideBase3
        }
      }

      if (overrideTeamEnabled) {
        overrides.overrideTeam = {
          homeTeam: overrideHomeTeam,
          awayTeam: overrideAwayTeam
        }
      }

      if (overrideScoreEnabled) {
        overrides.overrideScore = {
          homeScore: overrideHomeScore,
          awayScore: overrideAwayScore
        }
      }

      if (overrideInningEnabled) {
        overrides.overrideInning = {
          inning: overrideInning,
          half: overrideHalf
        }
      }

      wsRef.current.send(JSON.stringify(overrides))
      console.log('Sent overrides:', overrides)
    }
  }, [
    overrideBalls,
    overrideStrikes,
    overrideOuts,
    overrideEnabled,
    overrideBasesEnabled,
    overrideBase1,
    overrideBase2,
    overrideBase3,
    overrideTeamEnabled,
    overrideHomeTeam,
    overrideAwayTeam,
    overrideScoreEnabled,
    overrideHomeScore,
    overrideAwayScore,
    overrideInningEnabled,
    overrideInning,
    overrideHalf
  ])

  // WebSocket connection with auto-reconnect
  useEffect(() => {
    if (eventId == null || eventId === '') {
      console.error('No eventId provided')
      return
    }

    let wsUrl: string
    // @ts-expect-error - __WEBPACK_DEV__ is injected by webpack DefinePlugin
    if (window.__WEBPACK_DEV__ === true) {
      // Development mode: use apiServer from clientConfig
      wsUrl = `${clientConfig.apiServer}/sockets/api/v1/dashboard/${eventId}`
    } else {
      // Production mode: use window.location
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = window.location.host
      wsUrl = `${protocol}//${host}/sockets/api/v1/dashboard/${eventId}`
    }

    let reconnectTimeout: NodeJS.Timeout | null = null
    let shouldReconnect = true

    const connect = (): void => {
      console.log('Connecting to Dashboard WebSocket:', wsUrl)
      const ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        console.log('Dashboard WebSocket connected')
      }

      ws.onmessage = event => {
        try {
          isReceivingMessageRef.current = true
          const rawData = JSON.parse(event.data)
          const messageType = rawData.type

          if (messageType === 'autoState') {
            const message = asAutoStateMessage(rawData)
            const autoState = message.data
            console.log(
              'Received autoState:',
              JSON.stringify(autoState, null, 2)
            )

            // Always update auto values with autoState
            setAutoBalls(autoState.balls)
            setAutoStrikes(autoState.strikes)
            setAutoOuts(autoState.outs)
            setAutoBase1(autoState.base1)
            setAutoBase2(autoState.base2)
            setAutoBase3(autoState.base3)
            setAutoHomeTeam(autoState.homeTeam)
            setAutoAwayTeam(autoState.awayTeam)
            setAutoHomeScore(autoState.homeScore)
            setAutoAwayScore(autoState.awayScore)
            setAutoInning(autoState.inning)
            setAutoHalf(autoState.half)

            // ONLY update override values if override is disabled (not sticky)
            if (!overrideEnabledRef.current) {
              setOverrideBalls(autoState.balls)
              setOverrideStrikes(autoState.strikes)
              setOverrideOuts(autoState.outs)
            }

            if (!overrideBasesEnabledRef.current) {
              setOverrideBase1(autoState.base1)
              setOverrideBase2(autoState.base2)
              setOverrideBase3(autoState.base3)
            }

            if (!overrideTeamEnabledRef.current) {
              setOverrideHomeTeam(autoState.homeTeam)
              setOverrideAwayTeam(autoState.awayTeam)
            }

            if (!overrideScoreEnabledRef.current) {
              setOverrideHomeScore(autoState.homeScore)
              setOverrideAwayScore(autoState.awayScore)
            }

            if (!overrideInningEnabledRef.current) {
              setOverrideInning(autoState.inning)
              setOverrideHalf(autoState.half)
            }
          } else if (messageType === 'overrideUpdate') {
            const message = asOverrideUpdateMessage(rawData)
            const overrides = message.data
            console.log(
              'Received override update from another dashboard:',
              overrides
            )

            // Update toggle states
            setOverrideEnabled(overrides.overrideCountEnabled)
            setOverrideBasesEnabled(overrides.overrideBasesEnabled)
            setOverrideTeamEnabled(overrides.overrideTeamEnabled)
            setOverrideScoreEnabled(overrides.overrideScoreEnabled)
            setOverrideInningEnabled(overrides.overrideInningEnabled)

            // Update override count if present
            if (overrides.overrideCount != null) {
              setOverrideBalls(overrides.overrideCount.balls)
              setOverrideStrikes(overrides.overrideCount.strikes)
              setOverrideOuts(overrides.overrideCount.outs)
            }
            if (overrides.overrideBases != null) {
              setOverrideBase1(overrides.overrideBases.base1)
              setOverrideBase2(overrides.overrideBases.base2)
              setOverrideBase3(overrides.overrideBases.base3)
            }
            if (overrides.overrideTeam != null) {
              setOverrideHomeTeam(overrides.overrideTeam.homeTeam)
              setOverrideAwayTeam(overrides.overrideTeam.awayTeam)
            }
            if (overrides.overrideScore != null) {
              setOverrideHomeScore(overrides.overrideScore.homeScore)
              setOverrideAwayScore(overrides.overrideScore.awayScore)
            }
            if (overrides.overrideInning != null) {
              setOverrideInning(overrides.overrideInning.inning)
              setOverrideHalf(overrides.overrideInning.half)
            }
          }
        } catch (error) {
          console.error('Error parsing or validating WebSocket message:', error)
        } finally {
          // Reset the flag after all state updates have been queued
          setTimeout(() => {
            isReceivingMessageRef.current = false
          }, 0)
        }
      }

      ws.onerror = error => {
        console.error('Dashboard WebSocket error:', error)
      }

      ws.onclose = () => {
        console.log('Dashboard WebSocket disconnected')
        if (shouldReconnect) {
          console.log(`Reconnecting in ${WS_RECONNECT_WAIT_MS}ms...`)
          reconnectTimeout = setTimeout(() => {
            connect()
          }, WS_RECONNECT_WAIT_MS)
        }
      }

      wsRef.current = ws
    }

    connect()

    return () => {
      shouldReconnect = false
      if (reconnectTimeout != null) {
        clearTimeout(reconnectTimeout)
      }
      wsRef.current?.close()
    }
  }, [eventId]) // Reconnect when eventId changes

  // Send overrides when values change and override is enabled
  useEffect(() => {
    // Don't send if we're currently processing a WebSocket message
    // This prevents feedback loops
    if (!isReceivingMessageRef.current) {
      sendOverrides()
    }
  }, [
    overrideBalls,
    overrideStrikes,
    overrideOuts,
    overrideEnabled,
    overrideBasesEnabled,
    overrideBase1,
    overrideBase2,
    overrideBase3,
    overrideTeamEnabled,
    overrideHomeTeam,
    overrideAwayTeam,
    overrideScoreEnabled,
    overrideHomeScore,
    overrideAwayScore,
    overrideInningEnabled,
    overrideInning,
    overrideHalf,
    sendOverrides
  ])

  // Number picker component
  const renderNumberPicker = (): React.ReactNode => {
    if (showScorePicker == null) return null

    const handleScoreSelect = (value: number): void => {
      if (showScorePicker === 'home') {
        setOverrideHomeScore(value)
        setOverrideScoreEnabled(true)
      } else if (showScorePicker === 'away') {
        setOverrideAwayScore(value)
        setOverrideScoreEnabled(true)
      } else if (showScorePicker === 'inning') {
        setOverrideInning(value)
        setOverrideInningEnabled(true)
      }
      setShowScorePicker(null)
    }

    const numbers = Array.from({ length: 21 }, (_, i) => i)
    const currentScore =
      showScorePicker === 'home'
        ? overrideHomeScore
        : showScorePicker === 'away'
          ? overrideAwayScore
          : overrideInning
    const centerIndex = numbers.indexOf(currentScore)

    // Calculate item height: paddingVertical (8*2=16) + fontSize (approx 32) = ~48px
    const itemHeight = 48
    // Offset so current value appears at tap position
    const idealTopOffset = pickerPosition.y - centerIndex * itemHeight - 24
    // Constrain to viewport bounds (min 20px from top, ensure picker container fits)
    const topOffset = Math.max(
      20,
      Math.min(idealTopOffset, window.innerHeight - 270)
    )

    // Calculate how much we need to scroll the picker container
    const scrollOffset = Math.max(0, centerIndex * itemHeight - 100)

    return (
      <Pressable
        style={styles.pickerOverlay}
        onPress={() => {
          setShowScorePicker(null)
        }}
      >
        <ScrollView
          ref={pickerScrollRef}
          style={[
            styles.pickerContainer,
            { left: pickerPosition.x - 50, top: topOffset }
          ]}
          onLayout={() => {
            // Scroll to show current value after layout
            if (pickerScrollRef.current?.scrollTo != null) {
              pickerScrollRef.current.scrollTo({
                y: scrollOffset,
                animated: false
              })
            }
          }}
        >
          {numbers.map((num, index) => {
            const distance = Math.abs(index - centerIndex)
            const opacity = Math.max(0.3, 1 - distance * 0.2)
            const fontSize = distance === 0 ? 32 : 24
            const fontWeight = distance === 0 ? '700' : '400'

            return (
              <Pressable
                key={num}
                style={[
                  styles.pickerItem,
                  distance === 0 && styles.pickerItemSelected
                ]}
                onPress={() => {
                  handleScoreSelect(num)
                }}
              >
                <Text
                  style={[
                    styles.pickerItemText,
                    {
                      opacity,
                      fontSize,
                      fontWeight: fontWeight as
                        | '400'
                        | '700'
                        | '100'
                        | '200'
                        | '300'
                        | '500'
                        | '600'
                        | '800'
                        | '900'
                        | 'normal'
                        | 'bold'
                    }
                  ]}
                >
                  {num}
                </Text>
              </Pressable>
            )
          })}
        </ScrollView>
      </Pressable>
    )
  }

  // Team score row renderer
  const renderTeamScoreRow = (
    autoTeam: string,
    autoScore: number,
    overrideTeam: string,
    overrideScore: number,
    isHome: boolean
  ): React.ReactNode => {
    return (
      <View style={styles.teamScoreRow}>
        <View
          style={[
            styles.teamNameContainer,
            overrideTeamEnabled && styles.teamNameContainerActive
          ]}
        >
          <Text
            style={[
              styles.superscriptInField,
              overrideTeamEnabled && styles.superscriptInFieldActive
            ]}
          >
            {autoTeam}
          </Text>
          <TextInput
            value={overrideTeamEnabled ? overrideTeam : ''}
            onChange={e => {
              setOverrideTeamEnabled(true)
              if (isHome) {
                setOverrideHomeTeam(e.nativeEvent.text)
              } else {
                setOverrideAwayTeam(e.nativeEvent.text)
              }
            }}
            style={styles.teamNameInput}
            placeholder={autoTeam}
            placeholderTextColor={theme.dashboardSuperscript}
          />
          <Pressable
            style={styles.xButtonInField}
            onPress={() => {
              // Turn off team override for BOTH teams
              setOverrideTeamEnabled(false)
              setOverrideHomeTeam(autoHomeTeam)
              setOverrideAwayTeam(autoAwayTeam)
            }}
          >
            <Text style={styles.xButtonText}>✕</Text>
          </Pressable>
        </View>
        <Pressable
          style={[
            styles.scoreContainer,
            overrideScoreEnabled && styles.scoreContainerActive
          ]}
          onPress={e => {
            setOverrideScoreEnabled(true)
            if (isHome) {
              setOverrideHomeScore(overrideHomeScore + 1)
            } else {
              setOverrideAwayScore(overrideAwayScore + 1)
            }
          }}
          onLongPress={e => {
            const nativeEvent = e.nativeEvent as unknown as {
              pageX: number
              pageY: number
            }
            setPickerPosition({ x: nativeEvent.pageX, y: nativeEvent.pageY })
            setShowScorePicker(isHome ? 'home' : 'away')
          }}
        >
          <Text
            style={[
              styles.superscriptInField,
              overrideScoreEnabled && styles.superscriptInFieldActive
            ]}
          >
            {autoScore.toString()}
          </Text>
          <Text style={styles.scoreText}>{overrideScore}</Text>
          <Pressable
            style={styles.xButtonInField}
            onPress={() => {
              // Turn off score override for BOTH teams
              setOverrideScoreEnabled(false)
              setOverrideHomeScore(autoHomeScore)
              setOverrideAwayScore(autoAwayScore)
            }}
          >
            <Text style={styles.xButtonText}>✕</Text>
          </Pressable>
        </Pressable>
      </View>
    )
  }

  const getInnerDiamondStyle = (
    overrideEnabled: boolean,
    autoBase: boolean
  ): object => {
    if (!overrideEnabled) {
      return {}
    }
    if (autoBase) {
      return styles.innerDiamondDarkened
    } else {
      return styles.innerDiamondDisabled
    }
  }

  const renderCountRow = (
    label: string,
    count: number,
    autoCount: number,
    maxCount: number,
    circleColor: string,
    onIncrement: () => void,
    onClear: () => void
  ): React.ReactNode => {
    return (
      <View style={styles.countRow}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Pressable style={styles.circleContainer} onPress={onIncrement}>
          <View style={styles.circlesGroup}>
            {Array.from({ length: maxCount }).map((_, index) => {
              const outerColor = overrideEnabled
                ? index < count
                  ? circleColor
                  : '#4a4a4a'
                : '#555'

              // Darken the autostate color when override is enabled
              const getInnerColor = (): string => {
                if (index >= autoCount) return '#2a2a2a'

                if (overrideEnabled) {
                  // Darken the color significantly by multiplying by 0.4
                  const hex = circleColor.replace('#', '')
                  const num = parseInt(hex, 16)
                  const r = Math.floor(((num >> 16) & 0xff) * 0.7)
                  const g = Math.floor(((num >> 8) & 0xff) * 0.7)
                  const b = Math.floor((num & 0xff) * 0.7)
                  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
                }

                return circleColor
              }

              const innerColor = getInnerColor()
              return (
                <View key={index} style={styles.circleWrapper}>
                  <View
                    style={[
                      styles.circle,
                      {
                        backgroundColor: outerColor
                      }
                    ]}
                  />
                  <View
                    style={[
                      styles.innerCircle,
                      {
                        backgroundColor: innerColor
                      }
                    ]}
                  />
                </View>
              )
            })}
          </View>
        </Pressable>
        <Pressable style={styles.clearButton} onPress={onClear}>
          <Text style={styles.clearButtonText}>C</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <View style={styles.dashboardContainer}>
      {renderNumberPicker()}
      <View style={styles.teamScoreCard}>
        {renderTeamScoreRow(
          autoAwayTeam,
          autoAwayScore,
          overrideAwayTeam,
          overrideAwayScore,
          false
        )}
        {renderTeamScoreRow(
          autoHomeTeam,
          autoHomeScore,
          overrideHomeTeam,
          overrideHomeScore,
          true
        )}
      </View>
      <View style={styles.cardsRow}>
        {/* Inning Card */}
        <View
          style={[
            styles.inningCard,
            overrideInningEnabled && styles.inningCardActive
          ]}
        >
          <Pressable
            style={styles.xButtonInningCard}
            onPress={() => {
              setOverrideInningEnabled(false)
              setOverrideInning(autoInning)
              setOverrideHalf(autoHalf)
            }}
          >
            <Text style={styles.xButtonText}>✕</Text>
          </Pressable>
          {/* Mini auto inning display */}
          <View
            style={[
              styles.miniInningContainer,
              overrideInningEnabled && styles.miniInningContainerActive
            ]}
          >
            <View style={styles.miniArrowsOutsColumn}>
              <View
                style={[
                  styles.miniArrowOuterUp,
                  autoHalf === 'top'
                    ? styles.arrowOuterActiveUp
                    : styles.arrowOuterInactiveUp
                ]}
              >
                <View
                  style={[
                    styles.miniArrowInnerUp,
                    autoHalf === 'top'
                      ? styles.arrowInnerActiveUp
                      : styles.arrowInnerInactiveUp
                  ]}
                />
              </View>
              <Text style={styles.miniInningCount}>{autoInning}</Text>
              <View
                style={[
                  styles.miniArrowOuterDown,
                  autoHalf === 'bottom'
                    ? styles.arrowOuterActiveDown
                    : styles.arrowOuterInactiveDown
                ]}
              >
                <View
                  style={[
                    styles.miniArrowInnerDown,
                    autoHalf === 'bottom'
                      ? styles.arrowInnerActiveDown
                      : styles.arrowInnerInactiveDown
                  ]}
                />
              </View>
            </View>
          </View>
          <View style={styles.arrowsOutsColumn}>
            <Pressable onPress={handleTopArrowPress}>
              <View
                style={[
                  styles.arrowOuterUp,
                  overrideHalf === 'top'
                    ? styles.arrowOuterActiveUp
                    : styles.arrowOuterInactiveUp
                ]}
              >
                <View
                  style={[
                    styles.arrowInnerUp,
                    overrideHalf === 'top'
                      ? styles.arrowInnerActiveUp
                      : styles.arrowInnerInactiveUp
                  ]}
                />
              </View>
            </Pressable>
            <Pressable
              onPress={handleInningNumberPress}
              onLongPress={handleInningNumberLongPress}
            >
              <Text style={styles.inningCount}>{overrideInning}</Text>
            </Pressable>
            <Pressable onPress={handleBottomArrowPress}>
              <View
                style={[
                  styles.arrowOuterDown,
                  overrideHalf === 'bottom'
                    ? styles.arrowOuterActiveDown
                    : styles.arrowOuterInactiveDown
                ]}
              >
                <View
                  style={[
                    styles.arrowInnerDown,
                    overrideHalf === 'bottom'
                      ? styles.arrowInnerActiveDown
                      : styles.arrowInnerInactiveDown
                  ]}
                />
              </View>
            </Pressable>
          </View>
        </View>
        {/* Bases Card */}
        <View
          style={[
            styles.basesCard,
            overrideBasesEnabled && styles.basesCardActive
          ]}
        >
          <Pressable
            style={styles.xButtonBasesCard}
            onPress={() => {
              setOverrideBasesEnabled(false)
              setOverrideBase1(autoBase1)
              setOverrideBase2(autoBase2)
              setOverrideBase3(autoBase3)
            }}
          >
            <Text style={styles.xButtonText}>✕</Text>
          </Pressable>
          <View style={styles.diamondsContainer}>
            <View style={styles.diamondRow}>
              <View style={styles.diamondWrapper}>
                <Pressable
                  style={[
                    styles.diamond,
                    overrideBasesEnabled && overrideBase2
                      ? styles.diamondFilled
                      : {}
                  ]}
                  onPress={toggleBase2}
                />
                {(autoBase2 ||
                  (overrideBasesEnabled && autoBase2 !== overrideBase2)) && (
                  <View
                    style={[
                      styles.innerDiamond,
                      getInnerDiamondStyle(overrideBasesEnabled, autoBase2),
                      styles.innerDiamondNonInteractive
                    ]}
                  />
                )}
              </View>
              <View style={styles.diamondWrapper}>
                <Pressable
                  style={[
                    styles.diamond,
                    overrideBasesEnabled && overrideBase1
                      ? styles.diamondFilled
                      : {}
                  ]}
                  onPress={toggleBase1}
                />
                {(autoBase1 ||
                  (overrideBasesEnabled && autoBase1 !== overrideBase1)) && (
                  <View
                    style={[
                      styles.innerDiamond,
                      getInnerDiamondStyle(overrideBasesEnabled, autoBase1),
                      styles.innerDiamondNonInteractive
                    ]}
                  />
                )}
              </View>
            </View>
            <View style={styles.diamondRowLeftAlign}>
              <View style={styles.diamondWrapper}>
                <Pressable
                  style={[
                    styles.diamond,
                    overrideBasesEnabled && overrideBase3
                      ? styles.diamondFilled
                      : {}
                  ]}
                  onPress={toggleBase3}
                />
                {(autoBase3 ||
                  (overrideBasesEnabled && autoBase3 !== overrideBase3)) && (
                  <View
                    style={[
                      styles.innerDiamond,
                      getInnerDiamondStyle(overrideBasesEnabled, autoBase3),
                      styles.innerDiamondNonInteractive
                    ]}
                  />
                )}
              </View>
            </View>
          </View>
        </View>
      </View>
      <View
        style={[styles.dashboard, overrideEnabled && styles.dashboardActive]}
      >
        <Pressable
          style={styles.xButtonDashboard}
          onPress={() => {
            setOverrideEnabled(false)
            setOverrideBalls(autoBalls)
            setOverrideStrikes(autoStrikes)
            setOverrideOuts(autoOuts)
          }}
        >
          <Text style={styles.xButtonText}>✕</Text>
        </Pressable>
        {renderCountRow(
          'B',
          overrideBalls,
          autoBalls,
          3,
          theme.dashboardCircleGreen,
          incrementBalls,
          clearBalls
        )}
        {renderCountRow(
          'S',
          overrideStrikes,
          autoStrikes,
          2,
          theme.dashboardCircleOrange,
          incrementStrikes,
          clearStrikes
        )}
        {renderCountRow(
          'O',
          overrideOuts,
          autoOuts,
          2,
          theme.dashboardCircleRed,
          incrementOuts,
          clearOuts
        )}
      </View>
      <Pressable style={styles.resetButton} onPress={handleReset}>
        <Text style={styles.resetButtonText}>Reset Game State</Text>
      </Pressable>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  dashboardContainer: {
    display: 'flex',
    justifyContent: 'flex-start',
    alignItems: 'flex-start',
    minHeight: 1000,
    backgroundColor: theme.backgroundColor,
    padding: theme.rem(1)
  },
  teamScoreCard: {
    backgroundColor: theme.cardBackgroundDark,
    borderRadius: theme.rem(1.25),
    marginTop: theme.rem(0.5),
    paddingVertical: theme.rem(1),
    paddingHorizontal: theme.rem(1.25),
    shadowColor: theme.shadowColor,
    shadowOffset: { width: 0, height: theme.rem(0.25) },
    shadowOpacity: 0.3,
    shadowRadius: theme.rem(1.25),
    elevation: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.rem(1),
    width: '100%',
    maxWidth: 600
  },
  teamScoreRow: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.75),
    justifyContent: 'space-between'
  },
  teamNameContainer: {
    flex: 1,
    minHeight: theme.rem(3),
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.rem(0.5),
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.5),
    paddingRight: theme.rem(3),
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.5),
    position: 'relative',
    marginRight: theme.rem(0.75)
  },
  teamNameContainerActive: {
    backgroundColor: theme.dashboardOverrideBackground
  },
  teamNameInput: {
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.primaryTextColor,
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    borderWidth: 0,
    width: '100%',
    paddingLeft: 0,
    transform: [{ translateY: theme.rem(0.5) }]
  },
  scoreContainer: {
    minWidth: theme.rem(6.25),
    minHeight: theme.rem(3),
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.rem(0.5),
    paddingHorizontal: theme.rem(1),
    paddingVertical: theme.rem(0.5),
    paddingRight: theme.rem(3),
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(0.5),
    position: 'relative',
    flexShrink: 0
  },
  scoreContainerActive: {
    backgroundColor: theme.dashboardOverrideBackground
  },
  scoreText: {
    fontSize: theme.rem(1.75),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.primaryTextColor
  },
  superscript: {
    fontSize: theme.rem(0.75),
    fontWeight: '400',
    color: theme.dashboardSuperscript,
    position: 'absolute',
    top: theme.rem(0.25),
    left: theme.rem(0.25)
  },
  superscriptInField: {
    fontSize: theme.rem(0.75),
    fontWeight: '400',
    color: theme.dashboardSuperscript,
    position: 'absolute',
    top: theme.rem(0.5),
    left: theme.rem(0.75),
    zIndex: 1
  },
  superscriptInFieldActive: {
    color: theme.primaryTextColor
  },
  xButtonInField: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.buttonGrayColor,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'absolute',
    right: theme.rem(0.5),
    top: '50%',
    marginTop: theme.rem(-1)
  },
  xButtonText: {
    fontSize: theme.rem(1),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.primaryTextColor
  },
  pickerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.overlayBackgroundColor,
    zIndex: 1000,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  pickerContainer: {
    position: 'absolute',
    width: theme.rem(6.25),
    maxHeight: theme.rem(15.75),
    backgroundColor: theme.cardBackgroundDark,
    borderRadius: theme.rem(0.75),
    padding: theme.rem(0.5),
    shadowColor: theme.shadowColor,
    shadowOffset: { width: 0, height: theme.rem(0.25) },
    shadowOpacity: 0.5,
    shadowRadius: theme.rem(1.25),
    overflow: 'scroll'
  },
  pickerItem: {
    paddingVertical: theme.rem(0.5),
    paddingHorizontal: theme.rem(0.75),
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  pickerItemSelected: {
    backgroundColor: theme.secondaryButtonColor,
    borderRadius: theme.rem(0.5)
  },
  pickerItemText: {
    color: theme.primaryTextColor,
    fontFamily: theme.secondaryTextFont,
    textAlign: 'center'
  },
  dashboard: {
    backgroundColor: theme.cardBackgroundDark,
    borderRadius: theme.rem(1.25),
    marginTop: theme.rem(1),
    paddingVertical: theme.rem(1),
    paddingHorizontal: theme.rem(1.25),
    shadowColor: theme.shadowColor,
    shadowOffset: { width: 0, height: theme.rem(0.25) },
    shadowOpacity: 0.3,
    shadowRadius: theme.rem(1.25),
    elevation: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.rem(0.5),
    width: '100%',
    maxWidth: 600,
    position: 'relative'
  },
  dashboardActive: {
    backgroundColor: theme.dashboardOverrideBackground
  },
  xButtonDashboard: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.buttonGrayColor,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'absolute',
    right: theme.rem(0.5),
    top: theme.rem(0.5),
    zIndex: 10
  },
  overrideToggleContainer: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: theme.rem(0.5),
    paddingHorizontal: theme.rem(1),
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.rem(0.75),
    marginBottom: theme.rem(0.5)
  },
  overrideToggle: {
    width: '100%',
    height: theme.rem(3),
    borderRadius: theme.rem(0.75),
    backgroundColor: theme.inactiveBackgroundColor,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: theme.dashboardOutlineGray
  },
  overrideToggleText: {
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.primaryTextColor
  },
  countRow: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 0,
    paddingLeft: theme.rem(0.5),
    paddingRight: theme.rem(1.75),
    justifyContent: 'space-between'
  },
  rowLabel: {
    fontSize: theme.rem(2.25),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.primaryTextColor,
    minWidth: theme.rem(3),
    flexShrink: 0
  },
  circleContainer: {
    flex: 1,
    display: 'flex',
    justifyContent: 'center'
  },
  circlesGroup: {
    display: 'flex',
    flexDirection: 'row',
    gap: theme.rem(0.75),
    justifyContent: 'flex-start'
  },
  circleWrapper: {
    position: 'relative',
    width: theme.rem(3),
    height: theme.rem(3),
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  circle: {
    position: 'absolute',
    width: theme.rem(3),
    height: theme.rem(3),
    borderRadius: theme.rem(1.5),
    borderWidth: 2,
    borderColor: theme.dashboardOutlineGray
  },
  innerCircle: {
    position: 'absolute',
    width: theme.rem(1.5),
    height: theme.rem(1.5),
    borderRadius: theme.rem(0.75),
    borderWidth: 0
  },
  clearButton: {
    width: theme.rem(3.25),
    height: theme.rem(3.25),
    borderRadius: theme.rem(0.75),
    backgroundColor: theme.clearButtonColor,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: theme.rem(0.5),
    flexShrink: 0
  },
  clearButtonText: {
    fontSize: theme.rem(1.75),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.scoreboardScoreText
  },
  cardsRow: {
    display: 'flex',
    flexDirection: 'row',
    gap: theme.rem(1),
    width: '100%',
    maxWidth: 600,
    marginTop: theme.rem(1)
  },
  inningCard: {
    flex: 1,
    paddingVertical: theme.rem(0.75),
    paddingHorizontal: theme.rem(1.25),
    backgroundColor: theme.cardBackgroundDark,
    borderRadius: theme.rem(0.75),
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative'
  },
  inningCardActive: {
    backgroundColor: theme.dashboardOverrideBackground
  },
  xButtonInningCard: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.buttonGrayColor,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'absolute',
    right: theme.rem(0.5),
    top: theme.rem(0.5),
    zIndex: 10
  },
  basesCard: {
    flex: 2,
    paddingVertical: theme.rem(0.75),
    paddingHorizontal: theme.rem(1.25),
    backgroundColor: theme.cardBackgroundDark,
    borderRadius: theme.rem(0.75),
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: theme.rem(0.75),
    position: 'relative'
  },
  basesCardActive: {
    backgroundColor: theme.dashboardOverrideBackground
  },
  xButtonBasesCard: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.buttonGrayColor,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'absolute',
    right: theme.rem(0.5),
    top: theme.rem(0.5),
    zIndex: 10
  },
  basesCardHeader: {
    width: '100%',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  basesToggleButton: {
    width: '100%',
    height: theme.rem(3),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.inactiveBackgroundColor,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.dashboardOutlineGray
  },
  basesToggleButtonText: {
    fontSize: theme.rem(1),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.primaryTextColor
  },
  diamondsContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    marginTop: theme.rem(1.5),
    gap: theme.rem(0.5),
    transform: [{ rotate: '45deg' }]
  },
  diamondRow: {
    display: 'flex',
    flexDirection: 'row',
    gap: theme.rem(0.5),
    justifyContent: 'flex-start'
  },
  diamondRowLeftAlign: {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'flex-start'
  },
  diamondWrapper: {
    position: 'relative',
    width: theme.rem(4),
    height: theme.rem(4),
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  diamond: {
    position: 'absolute',
    width: theme.rem(3),
    height: theme.rem(3),
    backgroundColor: 'transparent',
    borderWidth: 3,
    borderColor: theme.buttonGrayColor
  },
  diamondFilled: {
    backgroundColor: theme.activeColor,
    borderColor: theme.activeColor
  },
  innerDiamond: {
    position: 'absolute',
    width: theme.rem(1.25),
    height: theme.rem(1.25),
    backgroundColor: theme.activeColor
  },
  innerDiamondDarkened: {
    backgroundColor: theme.dashboardDarkBaseRed
  },
  innerDiamondDisabled: {
    backgroundColor: theme.inactiveBackgroundColor
  },
  innerDiamondNonInteractive: {
    pointerEvents: 'none'
  },
  // Inning card styles (from Scoreboard)
  arrowsOutsColumn: {
    alignItems: 'center'
  },
  inningCount: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(3),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    marginVertical: theme.rem(0.5)
  },
  arrowOuterUp: {
    position: 'relative',
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1.25),
    borderRightWidth: theme.rem(1.25),
    borderBottomWidth: theme.rem(1.75),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginBottom: theme.rem(0.5)
  },
  arrowInnerUp: {
    position: 'absolute',
    top: theme.rem(0.21875),
    left: theme.rem(-1),
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1),
    borderRightWidth: theme.rem(1),
    borderBottomWidth: theme.rem(1.375),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent'
  },
  arrowOuterActiveUp: {
    borderBottomColor: theme.activeColor
  },
  arrowOuterInactiveUp: {
    borderBottomColor: theme.dashboardOutlineGray
  },
  arrowInnerActiveUp: {
    borderBottomColor: theme.activeColor
  },
  arrowInnerInactiveUp: {
    borderBottomColor: theme.dashboardBaseFill
  },
  arrowOuterDown: {
    position: 'relative',
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1.25),
    borderRightWidth: theme.rem(1.25),
    borderTopWidth: theme.rem(1.75),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginTop: theme.rem(0.5)
  },
  arrowInnerDown: {
    position: 'absolute',
    bottom: theme.rem(0.21875),
    left: theme.rem(-1),
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1),
    borderRightWidth: theme.rem(1),
    borderTopWidth: theme.rem(1.375),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent'
  },
  arrowOuterActiveDown: {
    borderTopColor: theme.activeColor
  },
  arrowOuterInactiveDown: {
    borderTopColor: theme.dashboardOutlineGray
  },
  arrowInnerActiveDown: {
    borderTopColor: theme.activeColor
  },
  arrowInnerInactiveDown: {
    borderTopColor: theme.dashboardBaseFill
  },
  // Mini inning display (15% scale)
  miniInningContainer: {
    position: 'absolute',
    top: theme.rem(0.5),
    left: theme.rem(0.5),
    transform: [{ scale: 0.4 }],
    transformOrigin: 'top left',
    opacity: 0.6
  },
  miniInningContainerActive: {
    opacity: 1
  },
  miniArrowsOutsColumn: {
    alignItems: 'center'
  },
  miniInningCount: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(3),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    marginVertical: theme.rem(0.5)
  },
  miniArrowOuterUp: {
    position: 'relative',
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1.25),
    borderRightWidth: theme.rem(1.25),
    borderBottomWidth: theme.rem(1.75),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginBottom: theme.rem(0.5)
  },
  miniArrowInnerUp: {
    position: 'absolute',
    top: theme.rem(0.21875),
    left: theme.rem(-1),
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1),
    borderRightWidth: theme.rem(1),
    borderBottomWidth: theme.rem(1.375),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent'
  },
  miniArrowOuterDown: {
    position: 'relative',
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1.25),
    borderRightWidth: theme.rem(1.25),
    borderTopWidth: theme.rem(1.75),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginTop: theme.rem(0.5)
  },
  miniArrowInnerDown: {
    position: 'absolute',
    bottom: theme.rem(0.21875),
    left: theme.rem(-1),
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1),
    borderRightWidth: theme.rem(1),
    borderTopWidth: theme.rem(1.375),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent'
  },
  resetButton: {
    width: '100%',
    maxWidth: 600,
    marginTop: theme.rem(1),
    paddingVertical: theme.rem(1),
    paddingHorizontal: theme.rem(1.25),
    borderRadius: theme.rem(0.75),
    backgroundColor: theme.dashboardCircleOrange,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: theme.shadowColor,
    shadowOffset: { width: 0, height: theme.rem(0.25) },
    shadowOpacity: 0.3,
    shadowRadius: theme.rem(1.25),
    elevation: 8
  },
  resetButtonText: {
    fontSize: theme.rem(1.25),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.scoreboardScoreText
  }
}))

export default Dashboard
