import React, { useEffect, useRef } from 'react'
import { Modal, Pressable, View } from 'react-native'

import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { RichFrame } from './RichFrame'
import { useTessOverlay } from './TessOverlay'

export interface RichViewerProps {
  html: string
  onClose: () => void
}

/**
 * A table or chart at full size, scrollable both ways, with a floating X.
 * Over the right pane when the Shell provides a place for it, otherwise
 * full screen.
 */
export function RichViewer({
  html,
  onClose
}: RichViewerProps): React.ReactElement | null {
  const overlay = useTessOverlay()
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (overlay == null) return
    const closing = (): void => {
      close.current()
    }
    const layer = <ViewerLayer html={html} onClose={closing} />
    overlay.show(layer, closing)
    return () => {
      overlay.hide(layer)
    }
  }, [overlay, html])
  if (overlay != null) return null
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <ViewerLayer html={html} onClose={onClose} />
    </Modal>
  )
}

function ViewerLayer({ html, onClose }: RichViewerProps): React.ReactElement {
  const styles = getStyles(useTheme())
  const insets = useInsets()
  return (
    <View testID="Tess rich viewer" style={styles.layer}>
      <View
        style={[
          styles.frame,
          { paddingTop: insets.top, paddingBottom: insets.bottom }
        ]}
      >
        <RichFrame html={html} interactive />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={lstrings.tess_rich_close}
        onPress={onClose}
        style={({ pressed }) => [
          styles.close,
          { top: insets.top + 12 },
          pressed && styles.pressed
        ]}
      >
        <Icon name="close" size={1.5} />
      </Pressable>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  layer: { flex: 1, backgroundColor: theme.cardBackgroundColor },
  frame: { flex: 1 },
  close: {
    position: 'absolute',
    right: 12,
    width: theme.rem(3),
    height: theme.rem(3),
    borderRadius: theme.rem(1.5),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.cardBackgroundColor,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.25)'
  },
  pressed: { opacity: 0.6 }
}))
