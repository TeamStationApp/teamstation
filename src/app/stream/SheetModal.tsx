import React from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** How much of the screen's height a setup sheet takes. */
export const SHEET_HEIGHT = 0.75

export interface SheetModalProps {
  visible: boolean
  title: string
  /** The backdrop, Android's back button and `cancelLabel` all come here. */
  onClose: () => void
  /** A red word at the title's right, for a sheet with no action of its own. */
  cancelLabel?: string
  /** Once the sheet has gone from the screen (iOS), so another modal may open. */
  onDismiss?: () => void
  /** Once the sheet is on screen. */
  onShow?: () => void
  testID?: string
  children: React.ReactNode
}

/**
 * A bottom sheet at three quarters of the screen's height: what camera setup
 * steps through on the Videos tab. It scrolls when the window left over from
 * the keyboard is too short, and a tap on a row while the keyboard is up
 * reaches the row.
 *
 * Stepping from one sheet to the next: iOS presents one modal at a time, so
 * the next waits for this one's `onDismiss`. Android shows each modal as a
 * dialog with a window of its own and has no `onDismiss`, so the next opens at
 * once.
 */
export function SheetModal(props: SheetModalProps): React.ReactElement {
  const { visible, title, onClose, cancelLabel, onDismiss, onShow } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const { height } = useWindowDimensions()
  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={onClose}
      onDismiss={onDismiss}
      onShow={onShow}
    >
      <KeyboardAvoidingView
        style={[styles.scrim, { paddingTop: insets.top }]}
        // Android draws the modal's window edge to edge, and that window does
        // not shrink for the keyboard, so the view shrinks itself (`height`),
        // as `PickerDialog` does; iOS pads by the keyboard's height.
        behavior={
          Platform.OS === 'ios'
            ? 'padding'
            : Platform.OS === 'android'
              ? 'height'
              : undefined
        }
      >
        <Pressable
          style={styles.behind}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={cancelLabel ?? title}
        />
        <View style={[styles.sheet, { height: height * SHEET_HEIGHT }]}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[
              styles.content,
              { paddingBottom: Math.max(insets.bottom, theme.rem(1.5)) }
            ]}
            keyboardShouldPersistTaps="handled"
            testID={props.testID}
          >
            <View style={styles.header}>
              <Text style={styles.title}>{title}</Text>
              {cancelLabel != null && (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={onClose}
                  testID="sheet-cancel"
                >
                  <Text style={styles.cancel}>{cancelLabel}</Text>
                </Pressable>
              )}
            </View>
            {props.children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: {
    flex: 1,
    justifyContent: 'flex-end'
  },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  sheet: {
    // Above the keyboard on a short window it gives way, clear of the status
    // bar, and scrolls.
    flexShrink: 1,
    width: '100%',
    maxWidth: theme.rem(36),
    alignSelf: 'center',
    overflow: 'hidden',
    backgroundColor: theme.cardBackgroundColor,
    borderTopLeftRadius: theme.rem(theme.radiusLargeRem),
    borderTopRightRadius: theme.rem(theme.radiusLargeRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor
  },
  scroll: {
    flex: 1
  },
  content: {
    flexGrow: 1,
    padding: theme.rem(theme.spaceLgRem),
    gap: theme.rem(theme.spaceMdRem)
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceMdRem)
  },
  title: {
    flex: 1,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  cancel: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.dangerColor
  }
}))
