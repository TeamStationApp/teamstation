import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  Defs,
  Ellipse,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
  Svg
} from 'react-native-svg'

import { TsMark } from '../components/TsMark'

/** Shared dark presentation for device linking and the TV welcome screen. */
export function TvBackdrop(): React.ReactElement {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="tvBackground" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#143c2a" />
            <Stop offset="0.7" stopColor="#030906" />
            <Stop offset="1" stopColor="#000000" />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#tvBackground)" />
      </Svg>
    </View>
  )
}
export function TvBrand({
  title = 'TeamStation TV',
  titleSize = 30,
  iconScale = 1,
  subtleHalo = false
}: {
  title?: string
  titleSize?: number
  iconScale?: number
  subtleHalo?: boolean
}): React.ReactElement {
  return (
    <View style={{ alignItems: 'center', gap: 16 }}>
      <View
        style={{
          width: 180 * iconScale,
          height: 130 * iconScale,
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <Svg
          width={180 * iconScale}
          height={130 * iconScale}
          viewBox="0 0 180 130"
          style={StyleSheet.absoluteFill}
        >
          <Defs>
            <RadialGradient id="tvHalo">
              <Stop
                offset="0"
                stopColor="#b46aff"
                stopOpacity={subtleHalo ? 0.476 : 0.85}
              />
              <Stop offset="1" stopColor="#8033db" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Ellipse
            cx={90}
            cy={subtleHalo ? 65 : 94}
            rx={90}
            ry={subtleHalo ? 65 : 35}
            fill="url(#tvHalo)"
          />
          <Rect
            x={42}
            y={20}
            width={96}
            height={64}
            rx={7}
            stroke="#fff"
            strokeWidth={5}
            fill="#101711"
          />
          <Path
            d="M90 84V98M68 99H112"
            stroke="#fff"
            strokeWidth={5}
            strokeLinecap="round"
          />
        </Svg>
        <View
          testID="tv-brand-screen"
          style={{
            position: 'absolute',
            left: 68 * iconScale,
            top: 30 * iconScale,
            width: 44 * iconScale,
            height: 44 * iconScale,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <TsMark size={2.5 * iconScale} />
        </View>
      </View>
      <Text style={{ color: '#fff', fontSize: titleSize, fontWeight: '700' }}>
        {title}
      </Text>
    </View>
  )
}
