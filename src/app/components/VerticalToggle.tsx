import React, { useMemo, useRef } from 'react'
import { PanResponder, Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** One end of a vertical toggle: the value it stands for and its label. */
export interface VerticalToggleOption<T extends string> {
  value: T
  label: string
}

/** How far a drag must travel, in points, to move the toggle. */
const DRAG_POINTS = 6

/**
 * A two-way switch stood on end: the first option at the top, the second at
 * the bottom, and a thumb over the one chosen with its label written inside
 * it. A tap moves it to the other end, and so does a drag up or down. An end
 * that is `locked` can't be chosen; with one end locked the toggle sits at
 * the other, greyed out, and doesn't move.
 */
export function VerticalToggle<T extends string>({
  label,
  options,
  value,
  locked,
  disabled = false,
  onChange
}: {
  /** What a screen reader hears before the choice, e.g. "Preferred days". */
  label: string
  options: readonly [VerticalToggleOption<T>, VerticalToggleOption<T>]
  value: T
  /** An option that can't be chosen, when there is one. */
  locked?: T
  disabled?: boolean
  onChange: (value: T) => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [top, bottom] = options
  // A locked end leaves the other as the only choice, whatever is stored.
  const shown =
    locked === top.value
      ? bottom.value
      : locked === bottom.value
        ? top.value
        : value
  const frozen = disabled || locked != null
  const choose = (next: T): void => {
    if (!frozen && next !== shown) onChange(next)
  }
  // Set by a drag, so the browser's click that ends it isn't also a tap.
  const dragged = useRef(false)
  const latest = useRef({ choose, top: top.value, bottom: bottom.value })
  latest.current = { choose, top: top.value, bottom: bottom.value }
  const drag = useMemo(
    () =>
      PanResponder.create({
        // Captured from the Pressable inside, which answers the touch first,
        // and kept from the page's scroll once it is a drag.
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          Math.abs(gesture.dy) > DRAG_POINTS &&
          Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          dragged.current = true
        },
        onPanResponderRelease: (_event, gesture) => {
          const { choose, top, bottom } = latest.current
          if (gesture.dy > DRAG_POINTS) choose(bottom)
          else if (gesture.dy < -DRAG_POINTS) choose(top)
        }
      }),
    []
  )
  const chosen = shown === top.value ? top : bottom
  return (
    // The drag is the wrapper's: the Pressable's own responder handlers
    // would replace any put beside them.
    <View {...drag.panHandlers}>
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={`${label}: ${chosen.label}`}
        accessibilityState={{
          checked: shown === bottom.value,
          disabled: frozen
        }}
        // react-native-web does not render `aria-checked` from the state above.
        aria-checked={shown === bottom.value}
        aria-disabled={frozen}
        accessibilityHint={
          frozen
            ? undefined
            : `Changes to ${(shown === top.value ? bottom : top).label}`
        }
        disabled={frozen}
        onPressIn={() => {
          dragged.current = false
        }}
        onPress={() => {
          if (dragged.current) return
          choose(shown === top.value ? bottom.value : top.value)
        }}
        style={[styles.track, frozen && styles.frozen]}
      >
        {[top, bottom].map(option => {
          const on = option.value === shown
          return (
            <View key={option.value} style={[styles.end, on && styles.thumb]}>
              <Text
                numberOfLines={1}
                // A mouse drag would select the label, and a selection ends
                // the drag on the web.
                selectable={false}
                style={[styles.text, on ? styles.textOn : styles.textOff]}
              >
                {option.label}
              </Text>
            </View>
          )
        })}
      </Pressable>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  // About the height of a grid row's cell, so the row doesn't grow.
  track: {
    width: theme.rem(5.5),
    padding: theme.rem(0.125),
    borderRadius: theme.rem(0.75),
    backgroundColor: theme.defaultBorderColor
  },
  frozen: { opacity: 0.4 },
  end: {
    height: theme.rem(1.375),
    borderRadius: theme.rem(0.625),
    alignItems: 'center' as const,
    justifyContent: 'center' as const
  },
  thumb: { backgroundColor: theme.primaryButtonColor },
  // The size of the game page's Score, DJ and Coach buttons.
  text: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600' as const
  },
  textOn: { color: theme.buttonTextColor },
  textOff: { color: theme.secondaryTextColor }
}))
