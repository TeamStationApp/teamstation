import React from 'react'

import { useTheme } from '../theme/ThemeContext'
import type { SponsorDateTimeFieldProps } from './sponsorViewProps'

export type { SponsorDateTimeFieldProps }

/**
 * The sponsored row's date and time on the web: the browser's
 * `datetime-local` input. The phones choose it with the app's calendar and
 * time pickers (SponsorDateTimeField.native.tsx).
 */
export function SponsorDateTimeField({
  value,
  onChange
}: SponsorDateTimeFieldProps): React.ReactElement {
  const theme = useTheme()
  return (
    <input
      type="datetime-local"
      aria-label="Date and time"
      value={value}
      onChange={event => {
        onChange(event.currentTarget.value)
      }}
      style={{
        minHeight: 48,
        maxWidth: 280,
        padding: '0 12px',
        borderRadius: 8,
        border: `1px solid ${theme.inputBorderColor}`,
        background: theme.inputBackgroundColor,
        // Empty, its mm/dd/yyyy reads as a placeholder.
        color: value === '' ? theme.placeholderTextColor : theme.inputTextColor,
        fontSize: 16
      }}
    />
  )
}
