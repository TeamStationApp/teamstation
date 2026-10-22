import React from 'react'
import {
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  Text,
  View
} from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface CheckboxModifiers {
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}
export interface CheckboxProps {
  label: string
  checked: boolean
  onPress: (modifiers?: CheckboxModifiers) => void
  disabled?: boolean
  hideLabel?: boolean
}

/** List selection: a 24-point square with a 48-point touch target. */
export function Checkbox({
  label,
  checked,
  onPress,
  disabled = false,
  hideLabel = false
}: CheckboxProps): React.ReactElement {
  const s = getStyles(useTheme())
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={event => {
        onPress((event.nativeEvent ?? event) as CheckboxModifiers)
      }}
      {...(Platform.OS === 'web'
        ? {
            onKeyDown: (event: NativeSyntheticEvent<unknown>) => {
              const key = event as unknown as {
                key?: string
                repeat?: boolean
              } & CheckboxModifiers
              if (key.key === ' ') {
                event.preventDefault()
                if (!disabled && key.repeat !== true) onPress(key)
              }
            }
          }
        : {})}
      style={[s.target, disabled && s.disabled]}
    >
      <View style={s.hitArea}>
        <View testID="checkbox-square" style={[s.box, checked && s.checked]}>
          {checked && <Text style={s.mark}>✓</Text>}
        </View>
      </View>
      {!hideLabel && <Text style={s.label}>{label}</Text>}
    </Pressable>
  )
}
const getStyles = cacheStyles((t: Theme) => ({
  target: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    minWidth: 48
  },
  hitArea: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center'
  },
  box: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderRadius: 3,
    borderColor: t.secondaryTextColor,
    alignItems: 'center',
    justifyContent: 'center'
  },
  checked: { backgroundColor: '#1565C0', borderColor: '#1565C0' },
  mark: { color: '#FFFFFF', fontSize: 18, lineHeight: 20 },
  label: {
    flexShrink: 1,
    fontFamily: t.regularTextFont,
    fontSize: t.rem(1),
    color: t.primaryTextColor
  },
  disabled: { opacity: 0.5 }
}))
