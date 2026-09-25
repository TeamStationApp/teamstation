import React, { useMemo, useRef, useState } from 'react'
import {
  PanResponder,
  Platform,
  Text,
  View,
  type ViewStyle
} from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { cameraDragValue, HEIGHT_LIMIT, TILT_LIMIT } from './cameraModel'

const webDragStyle: ViewStyle & { touchAction: 'none' } = {
  touchAction: 'none',
  cursor: 'pointer'
}

export function CameraDragControl({
  kind,
  value,
  onChange,
  onActive
}: {
  kind: 'tilt' | 'height' | 'zoom'
  value: number
  onChange: (value: number) => void
  onActive: (active: boolean) => void
}): React.ReactElement {
  const theme = useTheme()
  const [active, setActive] = useState(false)
  const latest = useRef({ value, onChange, onActive })
  latest.current = { value, onChange, onActive }
  const start = useRef(value)
  const responder = useMemo(() => {
    const finish = (): void => {
      setActive(false)
      latest.current.onActive(false)
    }
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: event => {
        event.preventDefault()
        start.current = latest.current.value
        setActive(true)
        latest.current.onActive(true)
      },
      onPanResponderMove: (_, gesture) => {
        latest.current.onChange(
          cameraDragValue(kind, start.current, gesture.dy)
        )
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true
    })
  }, [kind])
  const limit =
    kind === 'tilt' ? TILT_LIMIT : kind === 'zoom' ? 1.8 : HEIGHT_LIMIT
  const label = kind === 'tilt' ? 'Tilt' : kind === 'zoom' ? 'Zoom' : 'Height'
  const hint =
    kind === 'tilt'
      ? 'Drag down to look up; drag up to look down.'
      : kind === 'zoom'
        ? 'Drag up to zoom in; drag down to zoom out.'
        : 'Drag up to raise the camera; drag down to lower it.'
  return (
    <View
      {...responder.panHandlers}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`Camera ${label.toLowerCase()}`}
      accessibilityHint={hint}
      accessibilityValue={{
        min: kind === 'zoom' ? 0.7 : -limit,
        max: limit,
        now: value,
        text:
          kind === 'tilt'
            ? `${Math.round((value * 180) / Math.PI)} degrees`
            : kind === 'zoom'
              ? `${value.toFixed(2)} times`
              : `${Math.round(value)} metres`
      }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={event => {
        onChange(
          cameraDragValue(
            kind,
            value,
            (event.nativeEvent.actionName === 'increment' ? 20 : -20) *
              (kind === 'tilt' ? 1 : -1)
          )
        )
      }}
      style={[
        {
          minHeight: 44,
          minWidth: 54,
          borderRadius: 10,
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: 6,
          borderWidth: 1,
          borderColor: theme.defaultBorderColor,
          backgroundColor: active
            ? theme.primaryButtonColor
            : theme.cardBackgroundColor
        },
        Platform.OS === 'web' ? webDragStyle : {}
      ]}
    >
      <Text
        selectable={false}
        style={{
          fontSize: 13,
          fontWeight: '700',
          color: active ? theme.buttonTextColor : theme.primaryTextColor
        }}
      >
        {label}
      </Text>
      <Text
        selectable={false}
        style={{
          fontSize: 9,
          marginTop: 3,
          color: active ? theme.buttonTextColor : theme.secondaryTextColor
        }}
      >
        {kind === 'tilt'
          ? `${Math.round((value * 180) / Math.PI)}°`
          : kind === 'zoom'
            ? `${value.toFixed(2)}×`
            : `${Math.round(value)}m`}
      </Text>
    </View>
  )
}
