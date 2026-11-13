import React from 'react'
import { Pressable, type StyleProp, View, type ViewStyle } from 'react-native'

import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Modal } from './Modal'

export interface SheetProps {
  /** Closes it: the backdrop, and Back on Android. */
  onClose: () => void
  /** What the backdrop says it does to a screen reader. */
  closeLabel: string
  /** The backdrop's role for a screen reader, when it should have one. */
  closeRole?: 'button'
  /**
   * Whether the backdrop and Back close it now: off while an answer is under
   * way, so nothing closes it beneath the answer.
   */
  closable?: boolean
  /** Claims the screen while up: every other modal waits for it (`Modal`). */
  claims?: boolean
  /**
   * The least room under its content, kept clear of the phone's home
   * indicator too; 1.5rem by default.
   */
  bottom?: number
  /** The sheet's own look: its colour, border, padding and gaps. */
  style?: StyleProp<ViewStyle>
  testID?: string
  children: React.ReactNode
}

/**
 * A sheet that slides up from the bottom over a dimmed screen, which the
 * backdrop closes: the frame `ChoiceSheet`, `WarningSheet` and the ask about
 * notifications are drawn in.
 */
export function Sheet(props: SheetProps): React.ReactElement {
  const {
    onClose,
    closeLabel,
    closeRole,
    closable = true,
    claims,
    bottom,
    style,
    testID,
    children
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const close = closable ? onClose : undefined
  return (
    <Modal
      transparent
      animationType="slide"
      visible
      claims={claims}
      onRequestClose={() => {
        close?.()
      }}
    >
      <View style={styles.scrim}>
        <Pressable
          accessibilityLabel={closeLabel}
          accessibilityRole={closeRole}
          style={styles.behind}
          onPress={close}
        />
        <View
          style={[
            styles.sheet,
            style,
            { paddingBottom: Math.max(insets.bottom, bottom ?? theme.rem(1.5)) }
          ]}
          testID={testID}
          accessibilityViewIsModal
        >
          {children}
        </View>
      </View>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(36),
    alignSelf: 'center',
    borderTopLeftRadius: theme.rem(theme.radiusLargeRem),
    borderTopRightRadius: theme.rem(theme.radiusLargeRem)
  }
}))
