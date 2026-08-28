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

const Radar: React.FC = () => {
  const { eventId } = useParams<{ eventId: string }>()
  const theme = useTheme()
  const styles = getStyles(theme)
  const [pitchSpeed, setPitchSpeed] = useState(0)
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

  const visible = pitchSpeed > 0
  const digits = String(visible ? pitchSpeed : 88).length
  const fontSize =
    readoutWidth > 0 ? readoutWidth / Math.max(digits, 1) / DIGIT_EM : 0
  const mphSize = fontSize * MPH_SIZE_RATIO

  return (
    <View style={styles.container}>
      <View
        style={styles.readout}
        onLayout={event => {
          setReadoutWidth(event.nativeEvent.layout.width)
        }}
      >
        <Text
          style={[
            styles.speed,
            {
              fontSize,
              lineHeight: fontSize * 1.05,
              opacity: visible ? 1 : 0
            }
          ]}
          numberOfLines={1}
        >
          {visible ? pitchSpeed : 88}
        </Text>
        <Text
          style={[
            styles.mph,
            {
              fontSize: mphSize,
              lineHeight: mphSize * 1.2,
              opacity: visible ? 1 : 0
            }
          ]}
        >
          MPH
        </Text>
      </View>
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
  speed: {
    color: theme.primaryTextColor,
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    textAlign: 'center'
  },
  mph: {
    color: theme.primaryTextColor,
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    textAlign: 'center',
    marginTop: theme.rem(0.25)
  }
}))

export default Radar
