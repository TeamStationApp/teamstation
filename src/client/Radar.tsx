import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { useParams } from 'react-router-dom'

import { asScoreState, WS_RECONNECT_WAIT_MS } from '../common/types'
import { clientConfig } from './clientConfig'
import { cacheStyles, useTheme } from './ThemeContext'
import type { Theme } from './types'

/**
 * Digit-width factor for Helvetica Neue Bold. Used so a 2- or 3-digit
 * speed fills ~90% of the measured readout width.
 */
const DIGIT_EM = 0.62
const MPH_SIZE_RATIO = 0.15
const EXIT_SIZE_RATIO = 0.38
const EXIT_LABEL_SIZE_RATIO = 0.11

const Radar: React.FC = () => {
  const { eventId } = useParams<{ eventId: string }>()
  const theme = useTheme()
  const styles = getStyles(theme)
  const [pitchSpeed, setPitchSpeed] = useState(0)
  const [exitVelocity, setExitVelocity] = useState(0)
  const [readoutWidth, setReadoutWidth] = useState(0)

  useEffect(() => {
    if (eventId == null || eventId === '') {
      console.error('No eventId provided')
      return
    }

    let wsUrl: string
    // @ts-expect-error - __WEBPACK_DEV__ is injected by webpack DefinePlugin
    if (window.__WEBPACK_DEV__ === true) {
      wsUrl = `${clientConfig.apiServer}/sockets/api/v1/scoreboard/${eventId}`
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = window.location.host
      wsUrl = `${protocol}//${host}/sockets/api/v1/scoreboard/${eventId}`
    }

    let reconnectTimeout: NodeJS.Timeout | null = null
    let shouldReconnect = true

    const connect = (): void => {
      console.log('Connecting to Radar WebSocket:', wsUrl)
      const ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        console.log('Radar WebSocket connected')
      }

      ws.onmessage = event => {
        try {
          const rawData = JSON.parse(event.data)
          const newScoreState = asScoreState(rawData)
          setPitchSpeed(newScoreState.pitchSpeed)
          setExitVelocity(newScoreState.exitVelocity)
        } catch (error) {
          console.error('Error parsing or validating WebSocket message:', error)
        }
      }

      ws.onerror = error => {
        console.error('Radar WebSocket error:', error)
      }

      ws.onclose = () => {
        console.log('Radar WebSocket disconnected')
        if (shouldReconnect) {
          console.log(`Reconnecting in ${WS_RECONNECT_WAIT_MS}ms...`)
          reconnectTimeout = setTimeout(() => {
            connect()
          }, WS_RECONNECT_WAIT_MS)
        }
      }
    }

    connect()

    return () => {
      shouldReconnect = false
      if (reconnectTimeout != null) {
        clearTimeout(reconnectTimeout)
      }
    }
  }, [eventId])

  const digits = String(pitchSpeed > 0 ? pitchSpeed : 88).length
  const fontSize =
    readoutWidth > 0 ? readoutWidth / Math.max(digits, 1) / DIGIT_EM : 0
  const mphSize = fontSize * MPH_SIZE_RATIO
  const exitSize = fontSize * EXIT_SIZE_RATIO
  const exitLabelSize = fontSize * EXIT_LABEL_SIZE_RATIO

  return (
    <View style={styles.container}>
      <View
        style={styles.readout}
        onLayout={event => {
          setReadoutWidth(event.nativeEvent.layout.width)
        }}
      >
        <MetricNumber
          value={pitchSpeed}
          fontSize={fontSize}
          color={theme.primaryTextColor}
          fontFamily={theme.secondaryTextFont}
          slotRatio={0.92}
        />
        <Text
          style={[
            styles.mph,
            {
              fontSize: mphSize,
              lineHeight: mphSize,
              // Half the leftover line-box gap under the pitch digits.
              marginTop: -fontSize * 0.04
            }
          ]}
        >
          MPH
        </Text>
        <View style={{ marginTop: fontSize * 0.22, width: '100%' }}>
          <MetricNumber
            value={exitVelocity}
            fontSize={exitSize}
            color={theme.primaryTextColor}
            fontFamily={theme.secondaryTextFont}
          />
        </View>
        <Text
          style={[
            styles.exitLabel,
            {
              fontSize: exitLabelSize,
              lineHeight: exitLabelSize * 1.2
            }
          ]}
        >
          Exit Velocity
        </Text>
      </View>
    </View>
  )
}

const MetricNumber: React.FC<{
  value: number
  fontSize: number
  color: string
  fontFamily: string
  slotRatio?: number
}> = ({ value, fontSize, color, fontFamily, slotRatio = 1.05 }) => {
  if (fontSize <= 0) {
    return <View />
  }
  const slotHeight = fontSize * slotRatio
  if (value > 0) {
    return (
      <Text
        style={{
          color,
          fontWeight: '700',
          fontFamily,
          textAlign: 'center',
          fontSize,
          lineHeight: slotHeight
        }}
        numberOfLines={1}
      >
        {value}
      </Text>
    )
  }
  return (
    <View
      style={{
        height: slotHeight,
        width: '100%',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <View
        style={{
          width: fontSize * 1.15,
          height: Math.max(4, fontSize * 0.07),
          backgroundColor: color,
          borderRadius: 2
        }}
      />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: '100%',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.backgroundColor
  },
  readout: {
    width: '90%',
    alignItems: 'center',
    justifyContent: 'center'
  },
  mph: {
    color: theme.primaryTextColor,
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    textAlign: 'center',
    marginTop: 0
  },
  exitLabel: {
    color: theme.primaryTextColor,
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    textAlign: 'center',
    marginTop: 0
  }
}))

export default Radar
