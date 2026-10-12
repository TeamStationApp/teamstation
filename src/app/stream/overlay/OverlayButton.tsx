import React from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { Circle, Path, Svg } from 'react-native-svg'

import { iconText } from '../../components/iconText'
import { fonts } from '../../theme/fonts'
import {
  BUTTON_GLYPH,
  BUTTON_PADDING,
  BUTTON_SIZE,
  CHROME_BLACK,
  WHITE
} from './overlayTheme'

export type OverlayGlyph = 'close' | 'settings' | 'flip'

export interface OverlayButtonProps {
  glyph: OverlayGlyph
  testID: string
  accessibilityLabel: string
  disabled?: boolean
  onPress: () => void
}

/** A round chrome button: a white glyph with 14 pt of padding on black at 45 %. */
export function OverlayButton(props: OverlayButtonProps): React.ReactElement {
  const { glyph, testID, accessibilityLabel, disabled = false, onPress } = props
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.disc, disabled && styles.disabled]}
    >
      {glyph === 'flip' ? (
        <FlipGlyph />
      ) : (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={styles.symbol}
        >
          {iconText(glyph)}
        </Text>
      )}
    </Pressable>
  )
}

/** A camera with two arrows chasing round it: front to back and back again. */
function FlipGlyph(): React.ReactElement {
  return (
    <Svg width={BUTTON_GLYPH} height={BUTTON_GLYPH} viewBox="0 0 24 24">
      <Path
        d="M8.2 6 L9.6 3.8 H14.4 L15.8 6"
        stroke={WHITE}
        strokeWidth={1.8}
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M5 6 H19 A3 3 0 0 1 22 9 V17.5 A3 3 0 0 1 19 20.5 H5 A3 3 0 0 1 2 17.5 V9 A3 3 0 0 1 5 6 Z"
        stroke={WHITE}
        strokeWidth={1.8}
        fill="none"
      />
      <Path
        d="M8 12.2 A4.2 4.2 0 0 1 15.6 11.2 M16.4 9.6 L15.7 11.4 L13.9 10.8"
        stroke={WHITE}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M16 14.6 A4.2 4.2 0 0 1 8.4 15.6 M7.6 17.2 L8.3 15.4 L10.1 16"
        stroke={WHITE}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={18.6} cy={8.6} r={0.9} fill={WHITE} />
    </Svg>
  )
}

const styles = StyleSheet.create({
  disc: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    padding: BUTTON_PADDING,
    backgroundColor: CHROME_BLACK,
    alignItems: 'center',
    justifyContent: 'center'
  },
  disabled: {
    opacity: 0.4
  },
  symbol: {
    fontFamily: fonts.materialSymbols,
    fontSize: BUTTON_GLYPH,
    lineHeight: BUTTON_GLYPH,
    color: WHITE,
    includeFontPadding: false
  }
})
