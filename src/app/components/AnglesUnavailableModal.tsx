import React from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

export interface AnglesUnavailableModalProps {
  onClose: () => void
}

/**
 * Why "All angles" opens nothing here, and where it does work.
 *
 * In Safari's engine — Safari on a Mac, and every browser on an iPhone or
 * iPad, Brave and Chrome included, which Apple makes run it — four tiles at
 * once flash black and stutter, so the grid is not offered there
 * (`multiAngleSupported`). Hence "this browser" rather than "Safari": the
 * person reading it may be in Brave. The pill stays, and says so, rather
 * than vanishing and leaving somebody looking for a feature they were told
 * about. The same sheet as the angle picker, with nothing in it but the
 * reason.
 */
export function AnglesUnavailableModal(
  props: AnglesUnavailableModalProps
): React.ReactElement {
  const { onClose } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={styles.scrim}>
        {/* A sibling of the sheet, never its parent: a pressable inside a
            pressable is invalid on the web build. */}
        <Pressable
          style={styles.behind}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={lstrings.angles_unavailable_ok}
        />
        <View style={styles.sheet}>
          <Text style={styles.message}>{lstrings.angles_unavailable}</Text>
          <View style={styles.buttons}>
            <Button
              label={lstrings.angles_unavailable_ok}
              style={styles.ok}
              onPress={onClose}
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
    backgroundColor: theme.cardBackgroundColor
  },
  message: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    lineHeight: theme.rem(1.5),
    textAlign: 'center'
  },
  // A row, so the button keeps its own width instead of stretching across
  // the sheet.
  buttons: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: theme.rem(theme.spaceMdRem)
  },
  // A word as short as "OK" would otherwise make a circle of the pill.
  ok: {
    minWidth: theme.rem(8)
  }
}))
