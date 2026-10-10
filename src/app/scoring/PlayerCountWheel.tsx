import React, { useEffect, useRef } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import {
  clampPlayerCount,
  COUNT_ROW_HEIGHT,
  countAtOffset,
  PLAYER_COUNTS,
  type PlayerCountPickerProps
} from './playerCount'

/** Android uses the native scroll view's inertia and row snapping. */
export function PlayerCountWheel({
  value,
  onChange
}: PlayerCountPickerProps): React.ReactElement {
  const theme = useTheme()
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const initialOffset = useRef({ x: 0, y: (value - 1) * COUNT_ROW_HEIGHT })
  const announced = useRef(value)
  useEffect(() => {
    if (announced.current !== value) {
      announced.current = value
      scroll.current?.scrollTo({
        y: (value - 1) * COUNT_ROW_HEIGHT,
        animated: false
      })
    }
  }, [value])
  const select = (next: number): void => {
    const count = clampPlayerCount(next)
    announced.current = count
    scroll.current?.scrollTo({
      y: (count - 1) * COUNT_ROW_HEIGHT,
      animated: false
    })
    onChange(count)
  }
  return (
    <View style={{ height: 200, width: 160, alignSelf: 'center' }}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 80,
          height: 40,
          left: 0,
          right: 0,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.scoringSurface.badges.green.border,
          backgroundColor: theme.scoringSelectorIdle
        }}
      />
      <ScrollView
        ref={scroll}
        accessibilityRole="adjustable"
        accessibilityLabel="Number of placeholder players"
        accessibilityValue={{ min: 1, max: 16, now: value }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={event => {
          select(
            value + (event.nativeEvent.actionName === 'increment' ? 1 : -1)
          )
        }}
        contentOffset={initialOffset.current}
        snapToInterval={COUNT_ROW_HEIGHT}
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingVertical: 80 }}
        onScroll={event => {
          const next = countAtOffset(event.nativeEvent.contentOffset.y)
          announced.current = next
          onChange(next)
        }}
      >
        {PLAYER_COUNTS.map(count => (
          <Pressable
            key={count}
            accessibilityLabel={`Player count ${count}`}
            accessibilityState={{ selected: value === count }}
            onPress={() => {
              select(count)
            }}
            style={{
              height: 40,
              justifyContent: 'center',
              alignItems: 'center'
            }}
          >
            <Text
              style={{
                fontFamily: theme.regularTextFont,
                color: theme.primaryTextColor,
                fontSize: 22
              }}
            >
              {count}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
}
