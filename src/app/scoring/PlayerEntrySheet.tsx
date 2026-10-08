import React, { useEffect, useRef, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'

import { Button } from '../components/Button'
import { useTheme } from '../theme/ThemeContext'
import {
  emptyPlayerDraft,
  PLAYER_POSITIONS,
  type PlayerDraft,
  playerDraftError
} from './playerDraft'
import { PlaceholderPlayersSheet } from './PlaceholderPlayersSheet'
import { RosterSelector } from './RosterSelector'
import { ScoringError, ScoringSheet } from './ScoringSheet'

export function PlayerEntrySheet({
  onClose,
  onAddPlaceholders,
  onAdd
}: {
  onClose: () => void
  onAddPlaceholders?: (count: number) => void
  onAdd: (draft: PlayerDraft) => void
}): React.ReactElement {
  const theme = useTheme()
  const [draft, setDraft] = useState(emptyPlayerDraft)
  const [submitted, setSubmitted] = useState(false)
  const [placeholders, setPlaceholders] = useState(false)
  const first = useRef<React.ComponentRef<typeof TextInput>>(null)
  const last = useRef<React.ComponentRef<typeof TextInput>>(null)
  const jersey = useRef<React.ComponentRef<typeof TextInput>>(null)
  const saving = useRef(false)
  const text = {
    fontFamily: theme.regularTextFont,
    color: theme.primaryTextColor,
    fontSize: 14
  }
  const focusFrame = useRef<number | undefined>(undefined)
  useEffect(
    () => () => {
      if (focusFrame.current != null) cancelAnimationFrame(focusFrame.current)
    },
    []
  )
  const focus = (): void => {
    first.current?.focus()
    // The web modal activates its focus trap after onShow; focus after that commit.
    if (focusFrame.current != null) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      first.current?.focus()
    })
  }
  const add = (another: boolean): void => {
    if (saving.current) return
    setSubmitted(true)
    if (playerDraftError(draft) != null) return
    saving.current = true
    onAdd(draft)
    if (another) {
      setDraft(emptyPlayerDraft())
      setSubmitted(false)
      saving.current = false
      focus()
    } else onClose()
  }
  return (
    <ScoringSheet
      title="Create Player"
      textCancel
      onClose={onClose}
      onShow={focus}
    >
      <View style={{ gap: 16 }}>
        <View
          style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}
        >
          <View style={{ flex: 1, minWidth: 0, gap: 12 }}>
            {(['firstName', 'lastName', 'jersey'] as const).map(
              (key, index) => {
                const label = ['First Name', 'Last Name', 'Jersey Number'][
                  index
                ]
                return (
                  <View key={key} style={{ gap: 4 }}>
                    <Text style={text}>{label}</Text>
                    <TextInput
                      ref={
                        key === 'firstName'
                          ? first
                          : key === 'lastName'
                            ? last
                            : jersey
                      }
                      returnKeyType={key === 'jersey' ? 'done' : 'next'}
                      submitBehavior={
                        key === 'jersey' ? 'blurAndSubmit' : 'submit'
                      }
                      onSubmitEditing={() => {
                        if (key === 'firstName') last.current?.focus()
                        else if (key === 'lastName') jersey.current?.focus()
                        else jersey.current?.blur()
                      }}
                      autoFocus={key === 'firstName'}
                      accessibilityLabel={label}
                      value={draft[key]}
                      keyboardType={
                        key === 'jersey' ? 'numbers-and-punctuation' : 'default'
                      }
                      autoCapitalize="words"
                      onChangeText={value => {
                        setDraft(previous => ({ ...previous, [key]: value }))
                      }}
                      style={{
                        ...text,
                        fontSize: 16,
                        minHeight: 44,
                        padding: 10,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: theme.inputBorderColor,
                        backgroundColor: theme.backgroundColor
                      }}
                    />
                  </View>
                )
              }
            )}
            <View style={{ gap: 6, maxWidth: 156 }}>
              <Text style={text}>Throws</Text>
              <RosterSelector
                compact
                labelPrefix="Throws"
                labels={['L', 'R']}
                value={draft.throws === 'left' ? 0 : 1}
                onChange={index => {
                  setDraft(previous => ({
                    ...previous,
                    throws: index === 0 ? 'left' : 'right'
                  }))
                }}
              />
            </View>
            <View style={{ gap: 6, maxWidth: 156 }}>
              <Text style={text}>Bats</Text>
              <RosterSelector
                compact
                labelPrefix="Bats"
                labels={['L', 'S', 'R']}
                value={['left', 'switch', 'right'].indexOf(draft.bats)}
                onChange={index => {
                  setDraft(previous => ({
                    ...previous,
                    bats: (['left', 'switch', 'right'] as const)[index]
                  }))
                }}
              />
            </View>
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            <Text style={{ ...text, fontFamily: theme.semiBoldTextFont }}>
              Select Player Positions
            </Text>
            <View
              style={{
                borderRadius: 10,
                backgroundColor: theme.backgroundColor,
                shadowColor: theme.buttonShadowColor,
                shadowOpacity: 1,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 3 },
                elevation: 3
              }}
            >
              <View style={{ borderRadius: 10, overflow: 'hidden' }}>
                {PLAYER_POSITIONS.map((position, index) => {
                  const selected = draft.positions.includes(position)
                  return (
                    <Pressable
                      key={position}
                      accessibilityRole="checkbox"
                      accessibilityLabel={`Player position ${position}`}
                      accessibilityState={{ checked: selected }}
                      aria-checked={selected}
                      onPress={() => {
                        setDraft(previous => ({
                          ...previous,
                          positions: selected
                            ? previous.positions.filter(
                                value => value !== position
                              )
                            : [...previous.positions, position]
                        }))
                      }}
                      style={{
                        minHeight: 40,
                        justifyContent: 'center',
                        paddingHorizontal: 12,
                        borderBottomWidth:
                          index === PLAYER_POSITIONS.length - 1 ? 0 : 1,
                        borderBottomColor: theme.defaultBorderColor,
                        backgroundColor: selected
                          ? theme.scoringMenuActiveBackground
                          : theme.backgroundColor
                      }}
                    >
                      <Text
                        style={{
                          ...text,
                          color: selected
                            ? theme.scoringMenuActiveText
                            : theme.primaryTextColor
                        }}
                      >
                        {position}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            </View>
          </View>
        </View>
        <ScoringError
          message={submitted ? playerDraftError(draft) : undefined}
        />
        <Button
          color={theme.scoringMenuActiveBackground}
          textColor={theme.scoringMenuActiveText}
          accessibilityLabel="Add Player"
          label="Add Player"
          onPress={() => {
            add(false)
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save and Add Another Player"
          onPress={() => {
            add(true)
          }}
          style={{
            minHeight: 44,
            justifyContent: 'center',
            alignItems: 'center'
          }}
        >
          <Text
            style={{
              ...text,
              color: theme.successColor,
              fontFamily: theme.semiBoldTextFont
            }}
          >
            Save and Add Another Player
          </Text>
        </Pressable>
        {onAddPlaceholders != null && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add Placeholder Players"
            onPress={() => {
              setPlaceholders(true)
            }}
            style={{
              minHeight: 44,
              justifyContent: 'center',
              alignItems: 'center'
            }}
          >
            <Text
              style={{
                ...text,
                color: theme.successColor,
                fontFamily: theme.semiBoldTextFont
              }}
            >
              Add Placeholder Players
            </Text>
          </Pressable>
        )}
      </View>
      {placeholders && onAddPlaceholders != null && (
        <PlaceholderPlayersSheet
          onClose={() => {
            setPlaceholders(false)
          }}
          onAdd={onAddPlaceholders}
        />
      )}
    </ScoringSheet>
  )
}
