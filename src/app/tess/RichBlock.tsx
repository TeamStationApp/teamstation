import React, { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { RichFrame } from './RichFrame'
import { RichViewer } from './RichViewer'

/** A preview no taller than this; the viewer shows the rest. */
export const RICH_PREVIEW_HEIGHT = 220

/**
 * A table or chart in a reply, as a card. The frame takes no touches, so a
 * tap anywhere on the card opens the viewer.
 */
export function RichBlock({ html }: { html: string }): React.ReactElement {
  const styles = getStyles(useTheme())
  const [open, setOpen] = useState(false)
  return (
    <View testID="Tess rich block" style={styles.card}>
      <RichFrame html={html} interactive={false} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={lstrings.tess_rich_open}
        onPress={() => {
          setOpen(true)
        }}
        style={StyleSheet.absoluteFill}
      />
      {open && (
        <RichViewer
          html={html}
          onClose={() => {
            setOpen(false)
          }}
        />
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    height: RICH_PREVIEW_HEIGHT,
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.cardBackgroundColor,
    overflow: 'hidden'
  }
}))
