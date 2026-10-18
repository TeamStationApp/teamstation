import React, { useEffect, useRef } from 'react'
import { Platform, Pressable, ScrollView, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

const ROW = 44

/**
 * One scrolling column of choices with the chosen one in the middle band:
 * the hour, minute and period of a time, or a setting's value. It snaps to a
 * row, takes a tap on a row, and moves by one for an assistive increment or
 * decrement.
 */
export function Wheel({
  label,
  options,
  value,
  onChange,
  format = String,
  testID,
  rowTestID = testID,
  width = 80
}: {
  label: string
  options: number[]
  value: number
  onChange: (value: number) => void
  /** How an option reads, on its row and to assistive technology. */
  format?: (option: number) => string
  /** The column's `testID`. */
  testID?: string
  /** Each row's `testID` is this, a dash, and the option; `testID` unless set. */
  rowTestID?: string
  /** The column's width, wide enough for the longest option. */
  width?: number
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const initialOffset = useRef(Math.max(0, options.indexOf(value)) * ROW)
  const initialized = useRef(false)
  useEffect(() => {
    if (Platform.OS === 'web') {
      scroll.current?.scrollTo({ y: initialOffset.current, animated: false })
      initialized.current = true
    }
  }, [])
  useEffect(
    () => () => {
      if (timer.current != null) clearTimeout(timer.current)
    },
    []
  )
  const selectOffset = (offset: number): void => {
    const index = Math.min(
      options.length - 1,
      Math.max(0, Math.round(offset / ROW))
    )
    onChange(options[index])
  }
  return (
    <View style={styles.wheelColumn}>
      <Text style={styles.label}>{label}</Text>
      <View
        style={[styles.wheelViewport, { width }]}
        // A modal must focus the wheel, not its first row: focusing row one
        // scrolls away from the selected value and changes it on scroll end.
        focusable
        accessibilityRole="adjustable"
        accessibilityLabel={`${label}: ${format(value)}`}
        // Read as the row reads ("12%", "Default"), not as a share of the
        // range, which is what iOS makes of a bare number.
        accessibilityValue={{
          min: options[0],
          max: options[options.length - 1],
          now: value,
          text: format(value)
        }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={event => {
          const index = Math.min(
            options.length - 1,
            Math.max(
              0,
              options.indexOf(value) +
                (event.nativeEvent.actionName === 'increment' ? 1 : -1)
            )
          )
          onChange(options[index])
          scroll.current?.scrollTo({ y: index * ROW, animated: false })
        }}
      >
        <View pointerEvents="none" style={styles.wheelSelection} />
        <ScrollView
          ref={scroll}
          testID={testID}
          style={[styles.wheel, { width }]}
          contentContainerStyle={{ paddingVertical: ROW }}
          contentOffset={{ x: 0, y: initialOffset.current }}
          onContentSizeChange={() => {
            // Fabric can lay out a modal's content after applying contentOffset.
            // Position once after content layout, without fighting later drags.
            if (!initialized.current) {
              initialized.current = true
              scroll.current?.scrollTo({
                y: initialOffset.current,
                animated: false
              })
            }
          }}
          snapToInterval={ROW}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          onMomentumScrollEnd={event => {
            selectOffset(event.nativeEvent.contentOffset.y)
          }}
          onScrollEndDrag={event => {
            selectOffset(event.nativeEvent.contentOffset.y)
          }}
          scrollEventThrottle={16}
          onScroll={
            Platform.OS === 'web'
              ? event => {
                  const offset = event.nativeEvent.contentOffset.y
                  if (timer.current != null) clearTimeout(timer.current)
                  timer.current = setTimeout(() => {
                    selectOffset(offset)
                  }, 120)
                }
              : undefined
          }
        >
          {options.map(option => (
            <Pressable
              key={option}
              testID={rowTestID == null ? undefined : `${rowTestID}-${option}`}
              accessibilityRole="button"
              accessibilityLabel={`${label} ${format(option)}`}
              accessibilityState={{ selected: option === value }}
              onPress={() => {
                onChange(option)
                scroll.current?.scrollTo({
                  y: options.indexOf(option) * ROW,
                  animated: false
                })
              }}
              style={styles.wheelItem}
            >
              <Text
                style={[styles.value, option === value && styles.wheelText]}
              >
                {format(option)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  wheelColumn: { flex: 1, gap: theme.rem(0.5), alignItems: 'center' },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor
  },
  // Nested native ScrollViews need a bounded viewport rather than growing to content.
  wheelViewport: { height: 3 * ROW, overflow: 'hidden' },
  wheel: { height: 3 * ROW, flexGrow: 0, flexShrink: 0 },
  wheelItem: { height: ROW, alignItems: 'center', justifyContent: 'center' },
  wheelSelection: {
    position: 'absolute',
    top: ROW,
    height: ROW,
    left: 0,
    right: 0,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.containerBackgroundColor
  },
  value: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  wheelText: { fontFamily: theme.semiBoldTextFont, color: theme.activeColor }
}))
