import React, { useRef } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import { Button } from '../components/Button'
import { lstrings } from '../locales/strings'
import { MODAL_ORIENTATIONS } from '../scoring/modalOrientations'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface SongsNotDownloadedModalProps {
  visible: boolean
  /** Ignore, the scrim, or Go to Settings: the notice goes. */
  onClose: () => void
  /** Go to Settings, once the notice has gone. */
  onSettings: () => void
  /** The notice is on screen. */
  onShow?: () => void
}

/**
 * Some of the game's walk-up songs are not on this phone yet: a notice,
 * with Go to Settings and Ignore.
 *
 * It is always mounted and shown by `visible`, because React Native calls
 * `onDismiss` only when a mounted modal's `visible` turns false. Go to
 * Settings closes it and asks for the walkthrough from `onDismiss`: iOS will
 * not present one modal while another is still going.
 */
export function SongsNotDownloadedModal(
  props: SongsNotDownloadedModalProps
): React.ReactElement {
  const { visible, onClose, onSettings, onShow } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const chose = useRef<'settings' | null>(null)

  return (
    <Modal
      supportedOrientations={MODAL_ORIENTATIONS}
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
      onShow={() => {
        chose.current = null
        onShow?.()
      }}
      onDismiss={() => {
        const settings = chose.current === 'settings'
        chose.current = null
        if (settings) onSettings()
      }}
    >
      <View style={styles.scrim}>
        <Pressable
          style={styles.behind}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={lstrings.walkup_not_downloaded_ignore}
        />
        <View style={styles.sheet} testID="songs-not-downloaded">
          <Text style={styles.message}>{lstrings.walkup_not_downloaded}</Text>
          <View style={styles.buttons}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lstrings.walkup_not_downloaded_ignore}
              onPress={onClose}
              style={styles.ignore}
            >
              <Text style={styles.ignoreText}>
                {lstrings.walkup_not_downloaded_ignore}
              </Text>
            </Pressable>
            <Button
              label={lstrings.walkup_not_downloaded_settings}
              onPress={() => {
                chose.current = 'settings'
                onClose()
              }}
            />
          </View>
        </View>
      </View>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.overlayBackgroundColor,
    padding: theme.rem(theme.spaceMdRem)
  },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(30),
    padding: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(theme.radiusRem),
    backgroundColor: theme.cardBackgroundColor,
    gap: theme.rem(theme.spaceMdRem)
  },
  message: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    lineHeight: theme.rem(1.5),
    textAlign: 'center'
  },
  buttons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.rem(theme.spaceMdRem)
  },
  ignore: {
    minHeight: theme.rem(2.75),
    justifyContent: 'center',
    paddingHorizontal: theme.rem(0.5)
  },
  ignoreText: {
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '600',
    fontSize: theme.rem(1),
    color: theme.dangerColor
  }
}))
