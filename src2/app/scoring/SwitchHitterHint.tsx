import React, { useEffect, useRef } from 'react'
import { Animated, Pressable, Text, View } from 'react-native'

export function SwitchHitterHint({
  onDismiss
}: {
  onDismiss: () => void
}): React.ReactElement {
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 650,
          useNativeDriver: false
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 650,
          useNativeDriver: false
        })
      ])
    )
    animation.start()
    return () => {
      animation.stop()
    }
  }, [opacity])
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: '22%',
        bottom: 165,
        left: '10%',
        right: '10%',
        alignItems: 'center'
      }}
    >
      <View
        style={{
          padding: 16,
          backgroundColor: '#15382eef',
          borderRadius: 12,
          maxWidth: 360
        }}
      >
        <Text style={{ color: 'white', textAlign: 'center' }}>
          Drag hitter to other box to switch hitting position.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="OK"
          onPress={onDismiss}
          style={{ minHeight: 48, justifyContent: 'center' }}
        >
          <Text style={{ color: '#ffe38d', textAlign: 'center' }}>OK</Text>
        </Pressable>
      </View>
      <Animated.Text
        pointerEvents="none"
        accessibilityLabel="Drag to the other batter box"
        style={{
          opacity,
          fontSize: 40,
          color: '#ffe38d',
          position: 'absolute',
          bottom: 0
        }}
      >
        › › ›
      </Animated.Text>
    </View>
  )
}
