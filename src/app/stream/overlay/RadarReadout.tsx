import React, { useEffect, useState } from 'react'
import { StyleSheet, Text } from 'react-native'

import type { RadarDevice, RadarState } from '../phoneStreamClient'
import { RADAR, WHITE } from './overlayTheme'

/** A reading older than this shows as a dash, as Cameraman's does. */
export const READING_SHOWN_MS = 5000

/**
 * The radar whose speeds show: the connected one with the latest reading,
 * else the first connected one, else the first paired.
 */
function shownRadar(devices: RadarDevice[]): RadarDevice | undefined {
  const connected = devices.filter(device => device.connection === 'connected')
  const latest = [...connected].sort(
    (a, b) => (b.readingAt ?? -Infinity) - (a.readingAt ?? -Infinity)
  )[0]
  return latest ?? devices[0]
}

/**
 * `⚡85% 72/–`: the radar's battery, then pitch speed and exit velocity in
 * mph, each a dash once its reading is five seconds old. Null when no radar is
 * paired, and then nothing is drawn.
 */
export function radarReadout(
  state: RadarState | null,
  now: number
): string | null {
  if (state?.enabled !== true) return null
  const device = shownRadar(state.devices)
  if (device == null) return null
  const fresh =
    device.readingAt != null && now - device.readingAt < READING_SHOWN_MS
  const side = (mph: number | null): string =>
    fresh && mph != null ? String(Math.round(mph)) : '–'
  const speeds = `${side(device.pitchMph)}/${side(device.exitMph)}`
  return device.batteryPercent == null
    ? speeds
    : `⚡${Math.round(device.batteryPercent)}% ${speeds}`
}

export interface RadarReadoutProps {
  radar: RadarState | null
  /** The safe area's bottom and right, which the insets are measured from. */
  bottom: number
  right: number
  /** The clock, for a test. */
  now?: () => number
}

/** The paired radar's speeds, at the bottom right beside the zoom rail. */
export function RadarReadout(
  props: RadarReadoutProps
): React.ReactElement | null {
  const { radar, bottom, right, now = Date.now } = props
  // Read again each second, so a speed turns to a dash when it goes stale
  // with no new reading to say so.
  const [, setTick] = useState(0)
  const shown = radarReadout(radar, now())
  const showing = shown != null
  useEffect(() => {
    if (!showing) return
    const timer = setInterval(() => {
      setTick(tick => tick + 1)
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [showing])
  if (shown == null) return null
  return (
    <Text
      testID="radar-speeds"
      pointerEvents="none"
      style={[
        styles.readout,
        { bottom: bottom + RADAR.bottom, right: right + RADAR.trailing }
      ]}
    >
      {shown}
    </Text>
  )
}

const styles = StyleSheet.create({
  readout: {
    position: 'absolute',
    fontSize: RADAR.fontSize,
    fontWeight: '600',
    color: WHITE,
    backgroundColor: RADAR.background,
    borderRadius: RADAR.radius,
    overflow: 'hidden',
    paddingHorizontal: RADAR.paddingHorizontal,
    paddingVertical: RADAR.paddingVertical
  }
})
