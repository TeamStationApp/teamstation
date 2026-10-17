import React from 'react'

import { useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

/** The quiet action centered underneath a form's primary action. */
export function CancelAction({
  destructivePrimary = false,
  label = 'Cancel',
  accessibilityLabel,
  disabled,
  onPress
}: {
  destructivePrimary?: boolean
  label?: string
  accessibilityLabel?: string
  disabled?: boolean
  onPress: () => void
}): React.ReactElement {
  const theme = useTheme()
  return (
    <Button
      label={label}
      accessibilityLabel={accessibilityLabel}
      kind="text"
      textColor={destructivePrimary ? theme.linkTextColor : theme.dangerColor}
      style={{ alignSelf: 'center' }}
      disabled={disabled}
      onPress={onPress}
    />
  )
}
