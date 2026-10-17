import React from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import type { ParentPreview } from '../../common/groupLinks'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

export interface BreakParentSheetProps {
  preview: ParentPreview
  busy?: boolean
  error?: string
  onBreak: () => void
  onKeep: () => void
  title?: string
  warning?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

/**
 * The review that slides up before a parent link is broken.
 *
 * The preview's first lines are the links that will go, one per effect, and
 * those lead in bold: they are what the person is deciding. What stays the
 * same and the seasons' time frames follow in the quieter style.
 */
export function BreakParentSheet(
  props: BreakParentSheetProps
): React.ReactElement {
  const {
    preview,
    busy = false,
    error,
    onBreak,
    onKeep,
    title = 'Review relationship changes',
    warning,
    confirmLabel = 'Break relationship',
    cancelLabel,
    danger = false
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const changes = preview.explanation.slice(0, preview.effects.length)
  const notes = preview.explanation.slice(preview.effects.length)
  return (
    <Modal
      transparent
      animationType="slide"
      visible
      onRequestClose={() => {
        if (!busy) onKeep()
      }}
    >
      <View style={styles.scrim}>
        <Pressable
          accessibilityLabel="Keep relationship"
          style={styles.behind}
          disabled={busy}
          onPress={onKeep}
        />
        <View
          accessibilityRole="none"
          accessibilityLabel="Review relationship changes"
          style={styles.sheet}
        >
          <View style={styles.grip} />
          {changes.map((line, index) => (
            <Text key={`change:${index}`} style={styles.change}>
              {line}
            </Text>
          ))}
          <Text style={styles.title}>{title}</Text>
          {warning != null && <Text style={styles.note}>{warning}</Text>}
          {notes.map((line, index) => (
            <Text key={`note:${index}`} style={styles.note}>
              {line}
            </Text>
          ))}
          {error != null && error !== '' && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          <Button
            label={confirmLabel}
            color={danger ? theme.dangerColor : undefined}
            busy={busy}
            onPress={onBreak}
          />
          {cancelLabel == null ? (
            <Button
              label="Keep relationship"
              kind="secondary"
              disabled={busy}
              onPress={onKeep}
            />
          ) : (
            <Button
              label={cancelLabel}
              accessibilityLabel={cancelLabel}
              kind="text"
              textColor={theme.linkTextColor}
              style={styles.cancel}
              disabled={busy}
              onPress={onKeep}
            />
          )}
        </View>
      </View>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  cancel: { alignSelf: 'center' },
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
    paddingBottom: theme.rem(2),
    gap: theme.rem(theme.spaceSmRem)
  },
  grip: {
    alignSelf: 'center',
    width: theme.rem(2.5),
    height: theme.rem(0.25),
    borderRadius: theme.radiusPill,
    backgroundColor: theme.defaultBorderColor,
    marginBottom: theme.rem(theme.spaceSmRem)
  },
  change: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.0625),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.primaryTextColor,
    marginTop: theme.rem(theme.spaceSmRem)
  },
  note: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
