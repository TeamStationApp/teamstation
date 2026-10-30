import React, { useRef } from 'react'
import { Pressable, Text, type TextInput, View } from 'react-native'

import type { PlayerFormValue } from '../../common/playerForm'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { PositionFieldPicker } from './PositionFieldPicker'
import { TextField } from './TextField'

/** How the form treats a field: the user's to set, shown greyed, or not shown. */
export type PlayerFormFieldMode = 'edit' | 'readOnly' | 'hidden'

export interface PlayerFormFields {
  name: PlayerFormFieldMode
  hands: PlayerFormFieldMode
  jersey: boolean
  positions: boolean
}

const HAND_LETTERS = { left: 'L', right: 'R', switch: 'S' } as const
/** What a screen reader says for each hand. */
const HAND_WORDS = {
  left: lstrings.player_settings_left,
  right: lstrings.player_settings_right,
  switch: lstrings.player_settings_switch
} as const

/**
 * A player's name, jersey, hands and positions, in the app theme, laid out
 * as the scoring Create Player sheet is: the fields down the left, the
 * positions where they stand on a field to the right. It draws no buttons;
 * each screen puts its own actions beneath it. Player Settings, team
 * settings' Create Player and its Add to Roster use it.
 *
 * A read-only field keeps its place, greyed, so the layout does not move.
 */
export function PlayerForm({
  value,
  onChange,
  fields,
  disabled = false,
  firstRef
}: {
  value: PlayerFormValue
  onChange: (value: PlayerFormValue) => void
  fields: PlayerFormFields
  disabled?: boolean
  /** First Name, for a screen that returns focus to it. */
  firstRef?: React.RefObject<React.ComponentRef<typeof TextInput> | null>
}): React.ReactElement {
  const theme = useTheme()
  const ownFirst = useRef<React.ComponentRef<typeof TextInput>>(null)
  const first = firstRef ?? ownFirst
  const last = useRef<React.ComponentRef<typeof TextInput>>(null)
  const jersey = useRef<React.ComponentRef<typeof TextInput>>(null)
  const set = (next: Partial<PlayerFormValue>): void => {
    if (!disabled) onChange({ ...value, ...next })
  }
  const label = {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    letterSpacing: theme.rem(0.04),
    color: theme.secondaryTextColor
  }
  const hands = (
    title: string,
    hand: PlayerFormValue['bats'],
    choices: ReadonlyArray<'left' | 'right' | 'switch'>,
    pick: (hand: 'left' | 'right' | 'switch') => void
  ): React.ReactElement => {
    const readOnly = fields.hands === 'readOnly'
    return (
      <View style={{ gap: 6, maxWidth: 156 }}>
        <Text style={label}>{title.toUpperCase()}</Text>
        {readOnly ? (
          // The same capsule, greyed and still, so the form keeps its shape.
          <View
            accessible
            accessibilityLabel={`${title} ${hand == null ? 'unknown' : HAND_WORDS[hand]}`}
            accessibilityState={{ disabled: true }}
            // react-native-web does not render it from `accessibilityState`.
            aria-disabled
            style={{
              flexDirection: 'row',
              minHeight: 40,
              borderRadius: theme.radiusPill,
              backgroundColor: theme.pillBackground,
              padding: 2,
              opacity: 0.5
            }}
          >
            {choices.map(choice => (
              <View
                key={choice}
                style={{
                  flex: 1,
                  minHeight: 36,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: theme.radiusPill,
                  backgroundColor:
                    hand === choice ? theme.pillActiveBackground : 'transparent'
                }}
              >
                <Text
                  style={{
                    fontFamily: theme.semiBoldTextFont,
                    color:
                      hand === choice
                        ? theme.pillActiveTextColor
                        : theme.pillTextColor
                  }}
                >
                  {HAND_LETTERS[choice]}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={title}
            style={{
              flexDirection: 'row',
              minHeight: 40,
              borderRadius: theme.radiusPill,
              backgroundColor: theme.pillBackground,
              padding: 2
            }}
          >
            {choices.map(choice => {
              const on = hand === choice
              return (
                <Pressable
                  key={choice}
                  accessibilityRole="radio"
                  accessibilityLabel={`${title} ${HAND_WORDS[choice]}`}
                  accessibilityState={{ checked: on, disabled }}
                  // react-native-web does not render `aria-checked` from
                  // `accessibilityState`, so the web says it directly.
                  aria-checked={on}
                  disabled={disabled}
                  onPress={() => {
                    pick(choice)
                  }}
                  style={{
                    flex: 1,
                    minHeight: 36,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: theme.radiusPill,
                    backgroundColor: on
                      ? theme.pillActiveBackground
                      : 'transparent'
                  }}
                >
                  <Text
                    style={{
                      fontFamily: theme.semiBoldTextFont,
                      color: on
                        ? theme.pillActiveTextColor
                        : theme.pillTextColor
                    }}
                  >
                    {HAND_LETTERS[choice]}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        )}
      </View>
    )
  }
  const nameField = (
    key: 'firstName' | 'lastName',
    title: string,
    ref: React.RefObject<React.ComponentRef<typeof TextInput> | null>,
    next?: () => void
  ): React.ReactElement => (
    <TextField
      label={title}
      value={value[key]}
      inputRef={ref}
      locked={fields.name === 'readOnly'}
      disabled={disabled}
      autoCapitalize="words"
      onChangeText={text => {
        set({ [key]: text })
      }}
      {...(next == null ? {} : { onSubmitEditing: next })}
    />
  )
  return (
    <View
      testID="Player form"
      style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}
    >
      <View
        testID="Player form fields"
        style={{ flex: 1, minWidth: 0, gap: 12 }}
      >
        {fields.name !== 'hidden' && (
          <>
            {nameField(
              'firstName',
              lstrings.player_settings_first_name,
              first,
              () => {
                last.current?.focus()
              }
            )}
            {nameField(
              'lastName',
              lstrings.player_settings_last_name,
              last,
              fields.jersey
                ? () => {
                    jersey.current?.focus()
                  }
                : undefined
            )}
          </>
        )}
        {fields.jersey && (
          <TextField
            label={lstrings.player_settings_jersey}
            value={value.jersey}
            inputRef={jersey}
            disabled={disabled}
            keyboardType="number-pad"
            onChangeText={text => {
              set({ jersey: text })
            }}
          />
        )}
        {fields.hands !== 'hidden' && (
          <>
            {hands(
              lstrings.player_settings_throws,
              value.throws,
              ['left', 'right'],
              hand => {
                set({ throws: hand === 'left' ? 'left' : 'right' })
              }
            )}
            {hands(
              lstrings.player_settings_bats,
              value.bats,
              ['left', 'switch', 'right'],
              hand => {
                set({ bats: hand })
              }
            )}
          </>
        )}
      </View>
      {fields.positions && (
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <Text style={label}>
            {lstrings.player_form_positions.toUpperCase()}
          </Text>
          <PositionFieldPicker
            positions={value.positions}
            disabled={disabled}
            onToggle={position => {
              set({
                positions: value.positions.includes(position)
                  ? value.positions.filter(held => held !== position)
                  : [...value.positions, position]
              })
            }}
          />
        </View>
      )}
    </View>
  )
}
