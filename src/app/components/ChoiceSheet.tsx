import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { CancelAction } from './CancelAction'
import { RadioMark } from './RadioMark'
import { Sheet } from './Sheet'

export interface ChoiceSheetProps {
  title: string
  choices: Array<{
    label: string
    detail?: string
    /** Takes something away: its label in the danger colour. */
    destructive?: boolean
    /** Label in the link colour, in the same outline as the other choices. */
    link?: boolean
    /** The one a setting holds now: a mark at its right. */
    selected?: boolean
    onPress: () => void
  }>
  /** Cancel stays in the link colour, as it does under a destructive choice. */
  linkCancel?: boolean
  onClose: () => void
}

/** A short list of choices that slides up, e.g. what `Create` should make. */
export function ChoiceSheet(props: ChoiceSheetProps): React.ReactElement {
  const { title, choices, linkCancel, onClose } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <Sheet
      onClose={onClose}
      closeLabel="Close"
      bottom={theme.rem(2)}
      style={styles.sheet}
    >
      <Text style={styles.title}>{title}</Text>
      {choices.map(choice => (
        <Pressable
          key={choice.label}
          accessibilityRole="button"
          accessibilityLabel={choice.label}
          accessibilityState={
            choice.selected == null ? undefined : { selected: choice.selected }
          }
          aria-selected={choice.selected}
          onPress={() => {
            onClose()
            choice.onPress()
          }}
          style={({ pressed }) => [
            styles.choice,
            choice.selected != null && styles.marked,
            pressed && styles.pressed
          ]}
        >
          <View style={styles.words}>
            <Text
              style={[
                styles.label,
                choice.link === true && styles.link,
                choice.destructive === true && styles.destructive
              ]}
            >
              {choice.label}
            </Text>
            {choice.detail != null && (
              <Text style={styles.detail}>{choice.detail}</Text>
            )}
          </View>
          {choice.selected != null && <RadioMark on={choice.selected} />}
        </Pressable>
      ))}
      <CancelAction
        destructivePrimary={
          linkCancel === true ||
          (choices.length === 1 && choices[0].destructive === true)
        }
        label="Cancel"
        onPress={onClose}
      />
    </Sheet>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  sheet: {
    backgroundColor: theme.cardBackgroundColor,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: theme.rem(theme.spaceLgRem),
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
  marked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem)
  },
  words: { flexShrink: 1, flexGrow: 1, gap: theme.rem(theme.spaceXsRem) },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  destructive: { color: theme.dangerColor },
  link: { color: theme.linkTextColor },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  pressed: { opacity: 0.6 }
}))
