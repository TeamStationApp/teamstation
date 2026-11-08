import React from 'react'
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  type ViewStyle
} from 'react-native'

import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { useFittedText } from './fittedText'
import { Icon, type IconName } from './Icon'

export type ButtonKind = 'primary' | 'secondary' | 'text'

export interface ButtonProps {
  label: string
  shape?: 'pill' | 'rounded'
  compact?: boolean
  /**
   * A smaller label at the full 48-point height, for a long label in a
   * narrow column: the words fit and the target stays as large.
   */
  small?: boolean
  accessibilityLabel?: string
  color?: string
  textColor?: string
  onPress: () => void
  kind?: ButtonKind
  disabled?: boolean
  busy?: boolean
  /** Keeps this label before the spinner while busy. */
  busyLabel?: string
  /** Fills the row it is in. Primary actions in the designs always do. */
  block?: boolean
  /** Drawn before the label. */
  icon?: IconName
  style?: StyleProp<ViewStyle>
  /** Allows a bounded label to shrink without changing other buttons. */
  labelStyle?: StyleProp<TextStyle>
  /**
   * The smallest share of its size a label-only button's label may shrink
   * to, so it fits a narrow button whole rather than ellipsized: the phone
   * fits it itself, and the web picks the size from the measured widths.
   */
  fit?: number
  /** For a device test that must tell this button from text that reads the same. */
  testID?: string
  /** Points the target reaches past a shell drawn shorter than 48. */
  hitSlop?: number
}

/**
 * Three kinds, which is all the designs used once the duplicates were folded
 * together: a solid forest primary, a pale secondary, and plain text for the
 * quiet alternative under a primary.
 *
 * Fully rounded, with no outline and a soft shadow. An outlined rectangle is
 * what a button looked like when it had to be told apart from the page it sat
 * on; here the shape and the lift do that, and the border was only adding a
 * hard edge to a card that has none. Text buttons keep neither: they are a
 * word you can press, not an object.
 *
 * Minimum 48 high throughout, per the spec: these are pressed one-handed, often
 * outdoors, sometimes by somebody holding something else.
 */
export function Button(props: ButtonProps): React.ReactElement {
  const {
    label,
    shape = 'pill',
    compact = false,
    small = false,
    accessibilityLabel,
    color,
    textColor,
    onPress,
    kind = 'primary',
    disabled = false,
    busy = false,
    busyLabel,
    block = false,
    icon,
    style,
    labelStyle,
    testID,
    hitSlop,
    fit
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const inert = disabled || busy
  const fitted = useFittedText(fit, (busy ? busyLabel : label) ?? '')
  const labelStyles: StyleProp<TextStyle> = [
    styles.label,
    styles[`${kind}Label`],
    compact && { fontSize: 14 },
    small && styles.smallLabel,
    textColor != null && { color: textColor },
    labelStyle
  ]
  const size = StyleSheet.flatten(labelStyles)?.fontSize

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: inert, busy }}
      testID={testID ?? 'settings-pill-button'}
      aria-busy={busy}
      disabled={inert}
      hitSlop={hitSlop}
      onPress={onPress}
      ref={fitted.box}
      onLayout={fitted.handleLayout}
      style={({ pressed }) => [
        styles.base,
        styles[kind],
        color != null && { backgroundColor: color },
        kind !== 'text' && styles.raised,
        block && styles.block,
        pressed && !inert && styles[`${kind}Pressed`],
        pressed && !inert && kind !== 'text' && styles.lowered,
        inert && styles.inert,
        shape === 'rounded' && { borderRadius: theme.rem(theme.radiusRem) },
        compact && {
          height: 36,
          minHeight: 36,
          borderRadius: 18,
          paddingHorizontal: pillPadding(36)
        },
        style
      ]}
    >
      {(!busy || busyLabel != null) && (
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
            ref={fitted.text}
            numberOfLines={1}
            {...fitted.textProps}
            style={[
              labelStyles,
              fitted.scale < 1 &&
                size != null && { fontSize: size * fitted.scale }
            ]}
          >
            {busy ? busyLabel : label}
          </Text>
        </>
      )}
      {busy && (
        <ActivityIndicator
          color={
            kind === 'primary' ? theme.buttonTextColor : theme.primaryTextColor
          }
        />
      )}
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  base: {
    flexDirection: 'row',
    gap: theme.rem(theme.spaceXsRem),
    minHeight: theme.rem(3),
    height: theme.rem(3),
    // The label stays on the straight run, clear of both semicircular ends.
    paddingHorizontal: pillPadding(theme.rem(3)),
    // Half the height: a pill at any label length, without a magic number
    // that stops being half the day the height changes.
    borderRadius: theme.rem(1.5),
    alignItems: 'center',
    justifyContent: 'center'
  },
  /** The lift, on everything but a text button. */
  raised: {
    shadowColor: theme.buttonShadowColor,
    shadowOpacity: 1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3
  },
  /** Pressed, it settles: the shadow tightens rather than disappearing. */
  lowered: {
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1
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
  smallLabel: {
    fontSize: theme.rem(0.875)
  },

  primary: { backgroundColor: theme.primaryButtonColor },
  primaryPressed: { backgroundColor: theme.primaryButtonPressedColor },
  primaryLabel: { color: theme.buttonTextColor },

  secondary: {
    backgroundColor: theme.secondaryButtonColor
  },
  secondaryPressed: { backgroundColor: theme.secondaryButtonPressedColor },
  secondaryLabel: { color: theme.secondaryButtonTextColor },

  text: { backgroundColor: 'transparent' },
  textPressed: { backgroundColor: theme.textButtonPressedColor },
  textLabel: { color: theme.activeColor }
}))
