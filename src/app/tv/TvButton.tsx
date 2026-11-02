import React, { useEffect, useRef, useState } from 'react'
import { Platform, Pressable, Text, type View } from 'react-native'

import { normalizeRemote, tvEvents } from './remote'
export function TvButton({
  label,
  onPress,
  testID,
  preferred = false,
  onFocus,
  onUp,
  buttonRef,
  nextFocusUp,
  nextFocusDown,
  nextFocusLeft,
  nextFocusRight
}: {
  nextFocusUp?: number
  nextFocusDown?: number
  nextFocusLeft?: number
  nextFocusRight?: number
  label: string
  onPress: () => void
  testID?: string
  preferred?: boolean
  onFocus?: () => void
  onUp?: () => void
  buttonRef?: React.Ref<React.ComponentRef<typeof View>>
}): React.ReactElement {
  const [focused, setFocused] = useState(false)
  const focusedAt = useRef(0)
  useEffect(() => {
    if (!focused || onUp === undefined) return
    const subscription = tvEvents?.addListener(event => {
      const input = normalizeRemote(event, Platform.OS === 'ios')
      // Do not consume the same gesture that just moved focus onto this button.
      if (Date.now() - focusedAt.current < 100) return
      if (
        (input?.kind === 'click' || input?.kind === 'swipe') &&
        input.direction === 'up'
      )
        onUp()
    })
    return () => subscription?.remove()
  }, [focused, onUp])
  return (
    <Pressable
      ref={buttonRef}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...{
        hasTVPreferredFocus: preferred,
        nextFocusUp,
        nextFocusDown,
        nextFocusLeft,
        nextFocusRight
      }}
      onPress={onPress}
      onFocus={() => {
        focusedAt.current = Date.now()
        setFocused(true)
        onFocus?.()
      }}
      onBlur={() => {
        setFocused(false)
      }}
      style={{
        minHeight: 64,
        paddingHorizontal: 32,
        paddingVertical: 14,
        borderRadius: 32,
        backgroundColor: focused ? '#fff' : '#34473c',
        borderWidth: 3,
        borderColor: focused ? '#b596ff' : 'transparent'
      }}
    >
      <Text
        style={{
          fontSize: 25,
          color: focused ? '#102318' : '#fff',
          fontWeight: '600'
        }}
      >
        {label}
      </Text>
    </Pressable>
  )
}
