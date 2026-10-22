import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** A row that is checked or not: one of several that may each be chosen. */
export function CheckRow({
  label,
  detail,
  checked,
  onToggle,
  disabled = false
}: {
  label: string
  detail?: string
  checked: boolean
  onToggle: () => void
  disabled?: boolean
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onToggle}
      style={styles.row}
    >
      <View style={[styles.box, checked && styles.boxOn]}>
        {checked && <Text style={styles.mark}>✓</Text>}
      </View>
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        {detail != null && <Text style={styles.detail}>{detail}</Text>}
      </View>
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.75),
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(1)
  },
  box: {
    width: theme.rem(1.375),
    height: theme.rem(1.375),
    borderRadius: theme.rem(0.375),
    borderWidth: 2,
    borderColor: theme.secondaryTextColor,
    alignItems: 'center' as const,
    justifyContent: 'center' as const
  },
  boxOn: {
    borderColor: theme.primaryButtonColor,
    backgroundColor: theme.primaryButtonColor
  },
  mark: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1),
    color: theme.buttonTextColor
  },
  text: { flex: 1 },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  }
}))
