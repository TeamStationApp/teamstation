import React from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

export interface ChoiceSheetProps {
  title: string
  choices: Array<{
    label: string
    detail?: string
    /** Takes something away: its label in the danger colour. */
    destructive?: boolean
    onPress: () => void
  }>
  onClose: () => void
}

/** A short list of choices that slides up, e.g. what `Create` should make. */
export function ChoiceSheet(props: ChoiceSheetProps): React.ReactElement {
  const { title, choices, onClose } = props
  const styles = getStyles(useTheme())
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Pressable
          accessibilityLabel="Close"
          style={styles.behind}
          onPress={onClose}
        />
        <View style={styles.sheet}>
          <Text style={styles.title}>{title}</Text>
          {choices.map(choice => (
            <Pressable
              key={choice.label}
              accessibilityRole="button"
              accessibilityLabel={choice.label}
              onPress={() => {
                onClose()
                choice.onPress()
              }}
              style={({ pressed }) => [
                styles.choice,
                pressed && styles.pressed
              ]}
            >
              <Text
                style={[
                  styles.label,
                  choice.destructive === true && styles.destructive
                ]}
              >
                {choice.label}
              </Text>
              {choice.detail != null && (
                <Text style={styles.detail}>{choice.detail}</Text>
              )}
            </Pressable>
          ))}
          <Button label="Cancel" kind="secondary" onPress={onClose} />
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
    paddingBottom: theme.rem(2),
    gap: theme.rem(theme.spaceSmRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  choice: {
    padding: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    gap: theme.rem(theme.spaceXsRem)
  },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  destructive: { color: theme.dangerColor },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  pressed: { opacity: 0.6 }
}))
