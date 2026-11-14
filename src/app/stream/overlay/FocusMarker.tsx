import React, { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { focusDurationMs, focusOpacity, type FocusPoint } from '../cameraFocus'

export interface FocusFeedback {
  point: FocusPoint
  token: string
}

/** Request feedback only: its lifetime never changes the camera's focus mode. */
export function FocusMarker({
  feedback
}: {
  feedback: FocusFeedback
}): React.JSX.Element | null {
  const [opacity, setOpacity] = useState(1)
  useEffect(() => {
    const began = Date.now()
    setOpacity(1)
    const timer = setInterval(() => {
      const elapsed = Date.now() - began
      setOpacity(focusOpacity(elapsed))
      if (elapsed >= focusDurationMs) clearInterval(timer)
    }, 33)
    return () => {
      clearInterval(timer)
    }
  }, [feedback.token])
  if (opacity === 0) return null
  return (
    <View
      pointerEvents="none"
      testID="focus-marker"
      style={[
        styles.marker,
        { left: feedback.point.x - 15, top: feedback.point.y - 15, opacity }
      ]}
    >
      <View style={[styles.corner, styles.topLeft]} />
      <View style={[styles.corner, styles.topRight]} />
      <View style={[styles.corner, styles.bottomLeft]} />
      <View style={[styles.corner, styles.bottomRight]} />
    </View>
  )
}

const styles = StyleSheet.create({
  marker: { position: 'absolute', width: 30, height: 30 },
  corner: { position: 'absolute', width: 9, height: 9, borderColor: '#FFD60A' },
  topLeft: { top: 0, left: 0, borderTopWidth: 2, borderLeftWidth: 2 },
  topRight: { top: 0, right: 0, borderTopWidth: 2, borderRightWidth: 2 },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: 2, borderLeftWidth: 2 },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 2,
    borderRightWidth: 2
  }
})
