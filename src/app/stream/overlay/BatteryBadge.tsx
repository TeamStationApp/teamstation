import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Path, Svg } from 'react-native-svg'

import { BATTERY, PILL_HEIGHT, ROUNDED_FONT, WHITE } from './overlayTheme'

/** Green, or Low Power Mode yellow below 20 %. */
export function batteryColor(percent: number): string {
  return percent < BATTERY.lowPercent ? BATTERY.low : BATTERY.green
}

/** `64%`, clamped to the battery's range. */
export function batteryLabel(percent: number): string {
  return `${Math.min(Math.max(Math.round(percent), 0), 100)}%`
}

export interface BatteryBadgeProps {
  percent: number
  charging: boolean
}

/**
 * The phone's battery, as TS Cameraman shows it: a slab with a nub on its
 * right, the percentage in white, a bolt while it charges. The slab is always
 * as wide as "⚡100%", so it neither grows nor shrinks as the number counts
 * down or the charger comes and goes.
 */
export function BatteryBadge(props: BatteryBadgeProps): React.ReactElement {
  const { percent, charging } = props
  return (
    <View testID="camera-battery" pointerEvents="none" style={styles.outer}>
      <View style={[styles.slab, { backgroundColor: batteryColor(percent) }]}>
        {/* The widest it can be, unseen, holds the width. */}
        <View
          style={styles.hidden}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Contents label="100%" charging />
        </View>
        <View style={styles.shown}>
          <Contents label={batteryLabel(percent)} charging={charging} />
        </View>
      </View>
      <View style={[styles.nub, { backgroundColor: batteryColor(percent) }]} />
    </View>
  )
}

function Contents(props: {
  label: string
  charging: boolean
}): React.ReactElement {
  return (
    <View style={styles.contents}>
      {props.charging ? <Bolt /> : null}
      <Text style={styles.label} numberOfLines={1}>
        {props.label}
      </Text>
    </View>
  )
}

/** SF Symbols' `bolt.fill`, at the 10 pt the pill draws it. */
function Bolt(): React.ReactElement {
  return (
    <Svg
      testID="camera-battery-bolt"
      width={BATTERY.bolt * 0.72}
      height={BATTERY.bolt * 1.2}
      viewBox="0 0 10 16"
    >
      <Path d="M6.4 0 L0.4 9.2 H4.6 L3.6 16 L9.6 6.6 H5.4 Z" fill={WHITE} />
    </Svg>
  )
}

const nubHeight = PILL_HEIGHT * BATTERY.nubHeight

const styles = StyleSheet.create({
  outer: {
    flexDirection: 'row',
    alignItems: 'center',
    // The nub sits outside the slab; its width and gap are kept clear.
    paddingRight: BATTERY.nubWidth + BATTERY.nubGap
  },
  slab: {
    height: PILL_HEIGHT,
    paddingHorizontal: BATTERY.paddingHorizontal,
    borderRadius: BATTERY.radius,
    justifyContent: 'center'
  },
  hidden: {
    opacity: 0
  },
  shown: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center'
  },
  contents: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: BATTERY.boltGap
  },
  label: {
    fontFamily: ROUNDED_FONT,
    fontSize: BATTERY.fontSize,
    fontWeight: '800',
    letterSpacing: BATTERY.letterSpacing,
    fontVariant: ['tabular-nums'],
    color: WHITE
  },
  nub: {
    position: 'absolute',
    right: 0,
    top: (PILL_HEIGHT - nubHeight) / 2,
    width: BATTERY.nubWidth,
    height: nubHeight,
    borderRadius: Math.min(BATTERY.nubWidth / 2, 2)
  }
})
