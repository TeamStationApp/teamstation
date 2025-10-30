import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import {
  asAutoStateMessage,
  asOverrideUpdateMessage,
  type DashboardOverrides,
  WS_RECONNECT_WAIT_MS
} from '../common/types'

const Dashboard: React.FC = () => {
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
  const wsRef = useRef<WebSocket | null>(null)

  // Keep refs in sync with state
  useEffect(() => {
    overrideEnabledRef.current = overrideEnabled
  }, [overrideEnabled])

  useEffect(() => {
    overrideBasesEnabledRef.current = overrideBasesEnabled
  }, [overrideBasesEnabled])

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

  // Function to send overrides to server
  const sendOverrides = useCallback((): void => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const overrides: DashboardOverrides = {
        overrideCountEnabled: overrideEnabled,
        overrideBasesEnabled,
        overrideCount: undefined,
        overrideBases: undefined
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
    overrideBase3
  ])

  // WebSocket connection with auto-reconnect
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const wsUrl = `${protocol}//${host}/sockets/api/v1/dashboard`

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
          }
        } catch (error) {
          console.error('Error parsing or validating WebSocket message:', error)
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
  }, []) // Empty deps - only connect once on mount

  // Send overrides when values change and override is enabled
  useEffect(() => {
    sendOverrides()
  }, [
    overrideBalls,
    overrideStrikes,
    overrideOuts,
    overrideEnabled,
    overrideBasesEnabled,
    overrideBase1,
    overrideBase2,
    overrideBase3,
    sendOverrides
  ])

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
      <View style={styles.dashboard}>
        <Pressable
          style={[
            styles.overrideToggle,
            overrideEnabled ? styles.overrideToggleActive : null
          ]}
          onPress={() => {
            setOverrideEnabled(!overrideEnabled)
          }}
        >
          <Text style={styles.overrideToggleText}>
            {overrideEnabled ? 'Override Counts ON' : 'Override Counts OFF'}
          </Text>
        </Pressable>
        {renderCountRow(
          'B',
          overrideBalls,
          autoBalls,
          3,
          '#22c55e',
          incrementBalls,
          clearBalls
        )}
        {renderCountRow(
          'S',
          overrideStrikes,
          autoStrikes,
          2,
          '#ef4444',
          incrementStrikes,
          clearStrikes
        )}
        {renderCountRow(
          'O',
          overrideOuts,
          autoOuts,
          2,
          '#ef4444',
          incrementOuts,
          clearOuts
        )}
      </View>
      <View style={styles.basesCard}>
        <View style={styles.basesCardHeader}>
          <Pressable
            style={[
              styles.basesToggleButton,
              overrideBasesEnabled && styles.basesToggleButtonActive
            ]}
            onPress={() => {
              setOverrideBasesEnabled(!overrideBasesEnabled)
            }}
          >
            <Text style={styles.basesToggleButtonText}>
              {overrideBasesEnabled
                ? 'Override Bases ON'
                : 'Override Bases OFF'}
            </Text>
          </Pressable>
        </View>
        <View style={styles.diamondsContainer}>
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
                  overrideBasesEnabled && !autoBase2 && overrideBase2
                    ? styles.innerDiamondDisabled
                    : overrideBasesEnabled && autoBase2 && overrideBase2
                      ? styles.innerDiamondDarkened
                      : overrideBasesEnabled && autoBase2 !== overrideBase2
                        ? styles.innerDiamondDarkened
                        : {},
                  styles.innerDiamondNonInteractive
                ]}
              />
            )}
          </View>
          <View style={styles.diamondRow}>
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
                    overrideBasesEnabled && !autoBase3 && overrideBase3
                      ? styles.innerDiamondDisabled
                      : overrideBasesEnabled && autoBase3 && overrideBase3
                        ? styles.innerDiamondDarkened
                        : overrideBasesEnabled && autoBase3 !== overrideBase3
                          ? styles.innerDiamondDarkened
                          : {},
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
                    overrideBasesEnabled && !autoBase1 && overrideBase1
                      ? styles.innerDiamondDisabled
                      : overrideBasesEnabled && autoBase1 && overrideBase1
                        ? styles.innerDiamondDarkened
                        : overrideBasesEnabled && autoBase1 !== overrideBase1
                          ? styles.innerDiamondDarkened
                          : {},
                    styles.innerDiamondNonInteractive
                  ]}
                />
              )}
            </View>
          </View>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  dashboardContainer: {
    display: 'flex',
    justifyContent: 'flex-start',
    alignItems: 'flex-start',
    minHeight: 1000,
    backgroundColor: '#1a1a1a',
    padding: 16
  },
  dashboard: {
    backgroundColor: '#2d2d2d',
    borderRadius: 20,
    marginTop: 64,
    paddingVertical: 16,
    paddingHorizontal: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    width: '100%',
    maxWidth: 600
  },
  overrideToggleContainer: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: '#3d3d3d',
    borderRadius: 12,
    marginBottom: 8
  },
  overrideToggle: {
    width: '100%',
    height: 50,
    borderRadius: 12,
    backgroundColor: '#4a4a4a',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#555'
  },
  overrideToggleActive: {
    backgroundColor: '#22c55e',
    borderColor: '#22c55e'
  },
  overrideToggleText: {
    fontSize: 24,
    fontWeight: '700',
    color: 'white'
  },
  countRow: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 0,
    paddingHorizontal: 8,
    justifyContent: 'space-between'
  },
  rowLabel: {
    fontSize: 36,
    fontWeight: '700',
    color: 'white',
    minWidth: 45,
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
    gap: 12,
    justifyContent: 'flex-start'
  },
  circleWrapper: {
    position: 'relative',
    width: 45,
    height: 45,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  circle: {
    position: 'absolute',
    width: 45,
    height: 45,
    borderRadius: 22.5,
    borderWidth: 2,
    borderColor: '#555'
  },
  innerCircle: {
    position: 'absolute',
    width: 22.5,
    height: 22.5,
    borderRadius: 11.25,
    borderWidth: 0
  },
  clearButton: {
    width: 52,
    height: 52,
    borderRadius: 12,
    backgroundColor: '#999',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
    flexShrink: 0
  },
  clearButtonText: {
    fontSize: 27,
    fontWeight: '700',
    color: '#000'
  },
  basesCard: {
    marginTop: 16,
    paddingVertical: 20,
    paddingHorizontal: 20,
    backgroundColor: '#2d2d2d',
    borderRadius: 12,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    maxWidth: 600
  },
  basesCardHeader: {
    width: '100%',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  basesToggleButton: {
    width: '100%',
    height: 50,
    borderRadius: 8,
    backgroundColor: '#4a4a4a',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#555'
  },
  basesToggleButtonActive: {
    backgroundColor: '#22c55e',
    borderColor: '#22c55e'
  },
  basesToggleButtonText: {
    fontSize: 24,
    fontWeight: '700',
    color: 'white'
  },
  diamondsContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 20
  },
  diamondRow: {
    display: 'flex',
    flexDirection: 'row',
    gap: 40,
    justifyContent: 'center'
  },
  diamondWrapper: {
    position: 'relative',
    width: 60,
    height: 60,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  diamond: {
    position: 'absolute',
    width: 50,
    height: 50,
    backgroundColor: 'transparent',
    borderWidth: 3,
    borderColor: '#666',
    transform: [{ rotate: '45deg' }]
  },
  diamondFilled: {
    backgroundColor: '#ef4444',
    borderColor: '#ef4444'
  },
  innerDiamond: {
    position: 'absolute',
    width: 20,
    height: 20,
    backgroundColor: '#ef4444',
    transform: [{ rotate: '45deg' }]
  },
  innerDiamondDarkened: {
    backgroundColor: '#801010'
  },
  innerDiamondDisabled: {
    backgroundColor: '#4a4a4a'
  },
  innerDiamondNonInteractive: {
    pointerEvents: 'none'
  }
})

export default Dashboard
