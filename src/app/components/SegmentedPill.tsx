import React, { useEffect, useRef, useState } from 'react'
import { Animated, Platform, Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** One capsule with two equal choices and a sliding selected region. */
export function SegmentedPill<Id extends string>({
  options,
  selected,
  onSelect,
  accessibilityLabel
}: {
  options: readonly [{ id: Id; label: string }, { id: Id; label: string }]
  selected: Id
  onSelect: (id: Id) => void
  accessibilityLabel: string
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const index = selected === options[1].id ? 1 : 0
  const position = useRef(new Animated.Value(index)).current
  const previous = useRef(index)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (previous.current === index) return
    previous.current = index
    const animation = Animated.timing(position, {
      toValue: index,
      duration: 220,
      useNativeDriver: Platform.OS !== 'web'
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [index, position])
  return (
    <View
      testID="segmented-pill"
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
      style={styles.track}
    >
      <Animated.View
        testID="segmented-pill-fill"
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[
          styles.fill,
          {
            transform: [
              {
                translateX: position.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, width / 2]
                })
              }
            ]
          }
        ]}
      />
      {options.map(option => {
        const active = selected === option.id
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            aria-selected={active}
            onPress={() => {
              if (!active) onSelect(option.id)
            }}
            style={({ pressed }) => [styles.region, pressed && styles.pressed]}
          >
            <Text
              numberOfLines={1}
              selectable={false}
              style={[styles.label, active && styles.activeLabel]}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  track: {
    flexDirection: 'row',
    position: 'relative',
    width: '100%',
    maxWidth: theme.rem(27),
    borderRadius: theme.radiusPill,
    overflow: 'hidden',
    backgroundColor: theme.pillBackground
  },
  fill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: '50%',
    borderRadius: theme.radiusPill,
    backgroundColor: theme.pillActiveBackground
  },
  region: {
    flex: 1,
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(0.5),
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: { opacity: 0.85 },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.pillTextColor
  },
  activeLabel: { color: '#ffffff' }
}))
