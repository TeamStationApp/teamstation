import React from 'react'
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  Text,
  type ViewStyle
} from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Icon, type IconName } from './Icon'

export type ButtonKind = 'primary' | 'secondary' | 'text'

export interface ButtonProps {
  label: string
  onPress: () => void
  kind?: ButtonKind
  disabled?: boolean
  busy?: boolean
  /** Fills the row it is in. Primary actions in the designs always do. */
  block?: boolean
  /** Drawn before the label. */
  icon?: IconName
  style?: StyleProp<ViewStyle>
}

/**
 * Three kinds, which is all the designs used once the duplicates were folded
 * together: a solid forest primary, a pale bordered secondary, and plain text
 * for the quiet alternative under a primary.
 *
 * Minimum 48 high throughout, per the spec: these are pressed one-handed, often
 * outdoors, sometimes by somebody holding something else.
 */
export function Button(props: ButtonProps): React.ReactElement {
  const {
    label,
    onPress,
    kind = 'primary',
    disabled = false,
    busy = false,
    block = false,
    icon,
    style
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const inert = disabled || busy

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inert, busy }}
      disabled={inert}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        styles[kind],
        block && styles.block,
        pressed && !inert && styles[`${kind}Pressed`],
        inert && styles.inert,
        style
      ]}
    >
      {busy ? (
        <ActivityIndicator
          color={
            kind === 'primary' ? theme.buttonTextColor : theme.primaryTextColor
          }
        />
      ) : (
        <>
          {icon != null && (
            <Icon
              name={icon}
              size={1.125}
              color={
                kind === 'primary'
                  ? theme.buttonTextColor
                  : theme.primaryTextColor
              }
            />
          )}
          <Text
            numberOfLines={1}
            style={[styles.label, styles[`${kind}Label`]]}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  base: {
    flexDirection: 'row',
    gap: theme.rem(theme.spaceXsRem),
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(theme.spaceLgRem),
    borderRadius: theme.rem(theme.radiusRem),
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'transparent'
  },
  block: {
    alignSelf: 'stretch'
  },
  inert: {
    opacity: 0.5
  },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600'
  },

  primary: { backgroundColor: theme.primaryButtonColor },
  primaryPressed: { backgroundColor: theme.primaryButtonPressedColor },
  primaryLabel: { color: theme.buttonTextColor },

  secondary: {
    backgroundColor: theme.secondaryButtonColor,
    borderColor: theme.secondaryButtonBorderColor
  },
  secondaryPressed: { backgroundColor: theme.secondaryButtonPressedColor },
  secondaryLabel: { color: theme.secondaryButtonTextColor },

  text: { backgroundColor: 'transparent' },
  textPressed: { backgroundColor: theme.containerBackgroundColor },
  textLabel: { color: theme.activeColor }
}))
