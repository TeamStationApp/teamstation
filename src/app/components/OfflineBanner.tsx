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
  /** Queues the server stopped that no screen of their own shows: a team's. */
  held?: Array<{ key: string; text: string; onPress: () => void }>
  onLayout?: (height: number) => void
  /** Where the shell puts it: the bottom of the window, on the safe area. */
  style?: StyleProp<ViewStyle>
}

/** The strip's fill, the same in every theme: a dark yellow under white. */
export const OFFLINE_BANNER_BACKGROUND = '#6B3E00'
/** Every line on it, a refusal and a held team's included. */
export const OFFLINE_BANNER_TEXT = '#ffffff'

/**
 * The strip at the bottom of the phone, under the tab bar and above the
 * home indicator, that says the server cannot be reached and how many edits
 * wait on the phone, and why a create pressed offline did not open. Nothing
 * at all when there is nothing to say.
 */
export function OfflineBanner(
  props: OfflineBannerProps
): React.ReactElement | null {
  const styles = getStyles(useTheme())
  const { text, refusal, held = [], onLayout, style } = props
  if (text == null && refusal == null && held.length === 0) return null
  return (
    <View
      testID="offlineBanner"
      accessibilityLiveRegion="polite"
      style={[styles.banner, style]}
      onLayout={event => {
        onLayout?.(event.nativeEvent.layout.height)
      }}
    >
      {text != null && (
        <Text
          testID="offlineBannerText"
          accessibilityRole="text"
          style={styles.text}
        >
          {text}
        </Text>
      )}
      {held.map(line => (
        <Pressable
          key={line.key}
          testID="heldTeamMessage"
          accessibilityRole="button"
          accessibilityLabel="Player not saved"
          accessibilityHint={line.text}
          onPress={() => {
            line.onPress()
          }}
        >
          <Text style={[styles.text, styles.held]}>{line.text}</Text>
        </Pressable>
      ))}
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
  // A line that opens what can be done about it.
  held: {
    textDecorationLine: 'underline' as const
  }
}))
