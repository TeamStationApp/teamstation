import React, { useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import { Button } from '../components/Button'
import { CancelAction } from '../components/CancelAction'
import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface ConfirmSheetProps {
  visible: boolean
  title: string
  /** The warning, with `%s` where the angle's name goes, in bold. */
  body: string
  /** The camera's angle. */
  angle: string
  confirmLabel: string
  /** Names the sheet's parts: `<id>-sheet`, `<id>-angle`, `<id>-confirm`. */
  id: string
  /** The work. A failure is shown here, and the press can be made again. */
  onConfirm: () => Promise<void>
  /** The work is done. */
  onDone: () => void
  onCancel: () => void
  onDismiss?: () => void
}

/**
 * The standard bottom sheet before something that cannot be taken back: what
 * will happen, with the angle's name in bold, a red action and Cancel beneath
 * it. Opening or cancelling it changes nothing.
 */
export function ConfirmSheet(props: ConfirmSheetProps): React.ReactElement {
  const {
    visible,
    title,
    body,
    angle,
    confirmLabel,
    id,
    onConfirm,
    onDone,
    onCancel,
    onDismiss
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [before, after] = body.split('%s')

  const confirm = (): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    onConfirm().then(
      () => {
        setBusy(false)
        onDone()
      },
      (caught: unknown) => {
        setBusy(false)
        setError(
          caught instanceof Error ? caught.message : lstrings.common_retry
        )
      }
    )
  }

  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={onCancel}
      onDismiss={onDismiss}
    >
      <View style={styles.scrim}>
        <Pressable
          accessibilityLabel={lstrings.stream_prompt_cancel}
          style={styles.behind}
          onPress={onCancel}
        />
        <View
          testID={`${id}-sheet`}
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom, theme.rem(1.5)) }
          ]}
        >
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.body}>
            {before}
            <Text style={styles.angle} testID={`${id}-angle`}>
              {angle}
            </Text>
            {after}
          </Text>
          {error != null && <Text style={styles.error}>{error}</Text>}
          <Button
            label={confirmLabel}
            color={theme.dangerColor}
            textColor={theme.streamActionTextColor}
            busy={busy}
            testID={`${id}-confirm`}
            onPress={confirm}
          />
          <CancelAction
            destructivePrimary
            label={lstrings.stream_prompt_cancel}
            disabled={busy}
            onPress={onCancel}
          />
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
    backgroundColor: theme.cardBackgroundColor,
    borderTopLeftRadius: theme.rem(theme.radiusLargeRem),
    borderTopRightRadius: theme.rem(theme.radiusLargeRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: theme.rem(theme.spaceLgRem),
    gap: theme.rem(theme.spaceMdRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  body: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  angle: {
    fontFamily: theme.boldTextFont,
    fontWeight: '700'
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
