import React, { forwardRef, useState } from 'react'
import { TextInput, type TextInputProps } from 'react-native'

import { useScoringSheetTheme } from './scoringSheetTheme'

/** A readable field shared by scoring forms, preserving native input props. */
export const ScoringTextInput = forwardRef<
  React.ComponentRef<typeof TextInput>,
  TextInputProps
>(function ScoringTextInput({ style, onFocus, onBlur, ...props }, ref) {
  const theme = useScoringSheetTheme()
  const [focused, setFocused] = useState(false)
  return (
    <TextInput
      {...props}
      ref={ref}
      placeholderTextColor={
        props.placeholderTextColor ?? theme.placeholderTextColor
      }
      selectionColor={props.selectionColor ?? theme.inputFocusBorderColor}
      onFocus={event => {
        setFocused(true)
        onFocus?.(event)
      }}
      onBlur={event => {
        setFocused(false)
        onBlur?.(event)
      }}
      style={[
        {
          fontFamily: theme.regularTextFont,
          fontSize: 16,
          color: theme.inputTextColor,
          minHeight: 44,
          padding: 10,
          borderRadius: theme.rem(theme.radiusRem),
          borderWidth: 1,
          borderColor: focused
            ? theme.inputFocusBorderColor
            : theme.inputBorderColor,
          backgroundColor: theme.inputBackgroundColor,
          opacity: props.editable === false ? 0.5 : 1
        },
        style
      ]}
    />
  )
})
