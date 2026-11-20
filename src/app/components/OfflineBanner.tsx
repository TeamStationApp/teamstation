import React from 'react'
import {
  Pressable,
  type StyleProp,
  Text,
  View,
  type ViewStyle
} from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface OfflineBannerProps {
  /** The line: offline and what waits, or what is still being sent. */
  text?: string
  /** Why the action just pressed did nothing, while it cannot be done. */
  refusal?: string
  /**
   * Opens the list of what the server stopped: with it, the line is a
   * button. Only while something is held.
   */
  onOpenHeld?: () => void
  onLayout?: (height: number) => void
  /** Where the shell puts it: the bottom of the window, on the safe area. */
  style?: StyleProp<ViewStyle>
}

/** The strip's fill, the same in every theme: a dark yellow under white. */
export const OFFLINE_BANNER_BACKGROUND = '#6B3E00'
/** Every line on it, a refusal included. */
export const OFFLINE_BANNER_TEXT = '#ffffff'

/**
 * The strip at the bottom of the phone, under the tab bar and above the
 * home indicator, that says the server cannot be reached and how many edits
 * wait on the phone, and why a create pressed offline did not open. While
 * the server holds edits, its line opens the list of them. Nothing at all
 * when there is nothing to say.
 */
export function OfflineBanner(
  props: OfflineBannerProps
): React.ReactElement | null {
  const styles = getStyles(useTheme())
  const { text, refusal, onOpenHeld, onLayout, style } = props
  if (text == null && refusal == null) return null
  const line = text != null && (
    <Text
      testID="offlineBannerText"
      accessibilityRole="text"
      style={[styles.text, onOpenHeld != null && styles.held]}
    >
      {text}
    </Text>
  )
  return (
    <View
      testID="offlineBanner"
      accessibilityLiveRegion="polite"
      style={[styles.banner, style]}
      onLayout={event => {
        onLayout?.(event.nativeEvent.layout.height)
      }}
    >
      {line !== false && onOpenHeld != null ? (
        // On iOS the button stands for the line inside it: find it by its
        // own id and label, not the line's.
        <Pressable
          testID="offlineBannerButton"
          accessibilityRole="button"
          accessibilityLabel="Edits not sent"
          accessibilityHint={text}
          onPress={() => {
            onOpenHeld()
          }}
        >
          {line}
        </Pressable>
      ) : (
        line
      )}
      {refusal != null && (
        <Text
          testID="offlineCreateMessage"
          accessibilityRole="alert"
          style={[styles.text, styles.refusal]}
        >
          {refusal}
        </Text>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  // Solid, and the same dark yellow in every theme, so white reads on it.
  banner: {
    backgroundColor: OFFLINE_BANNER_BACKGROUND,
    paddingHorizontal: theme.rem(1),
    paddingVertical: theme.rem(0.5),
    gap: theme.rem(0.25)
  },
  text: {
    color: OFFLINE_BANNER_TEXT,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    textAlign: 'center'
  },
  refusal: {
    fontFamily: theme.boldTextFont
  },
  // The line that opens what can be done about what is held.
  held: {
    textDecorationLine: 'underline' as const
  }
}))
