import React from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface TextWidthButtonProps {
  label: string
  accessibilityLabel?: string
  onPress: () => void
  disabled?: boolean
  busy?: boolean
  color?: string
  textColor?: string
  /** Game hero-sized visible shell; the touch target stays 48 points. */
  small?: boolean
}

/** A compact tab-sized pill inside a generous, content-width touch target. */
export function TextWidthButton({
  label,
  accessibilityLabel = label,
  onPress,
  disabled = false,
  busy = false,
  color,
  textColor,
  small = false
}: TextWidthButtonProps): React.ReactElement {
  const theme = useTheme()
  const s = getStyles(theme)
  const inert = disabled || busy
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: inert, busy }}
      aria-disabled={inert}
      aria-busy={busy}
      disabled={inert}
      onPress={onPress}
      style={({ pressed }) => [s.target, (inert || pressed) && s.dim]}
    >
      <View
        testID="text-width-button-pill"
        style={[
          s.pill,
          small && s.smallPill,
          color != null && { backgroundColor: color }
        ]}
      >
        <Text style={[s.label, textColor != null && { color: textColor }]}>
          {label}
        </Text>
        {busy && (
          <ActivityIndicator
            size="small"
            color={textColor ?? theme.pillActiveTextColor}
          />
        )}
      </View>
    </Pressable>
  )
}
const getStyles = cacheStyles((t: Theme) => ({
  target: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minHeight: t.rem(3),
    justifyContent: 'center'
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: t.rem(2.25),
    paddingVertical: t.rem(0.5),
    paddingHorizontal: pillPadding(t.rem(2.25)),
    borderRadius: t.rem(1.125),
    backgroundColor: t.pillActiveBackground,
    gap: t.rem(0.5),
    shadowColor: t.buttonShadowColor,
    shadowOpacity: 1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  },
  label: {
    flexShrink: 1,
    fontFamily: t.semiBoldTextFont,
    fontSize: t.rem(0.875),
    lineHeight: t.rem(1.25),
    fontWeight: '600',
    textAlign: 'center',
    color: t.pillActiveTextColor
  },
  smallPill: {
    minHeight: t.rem(1.5),
    paddingVertical: t.rem(0.125),
    paddingHorizontal: pillPadding(t.rem(1.5)),
    borderRadius: t.rem(0.75)
  },
  dim: { opacity: 0.5 }
}))
