import React, { useEffect, useRef, useState } from 'react'
import { Pressable, Text, type TextInput, View } from 'react-native'

import { Button } from '../components/Button'
import { PlaceholderPlayersSheet } from './PlaceholderPlayersSheet'
import {
  emptyPlayerDraft,
  type PlayerDraft,
  playerDraftError
} from './playerDraft'
import { PlayerPositionField } from './PlayerPositionField'
import { RosterSelector } from './RosterSelector'
import { ScoringError, ScoringSheet } from './ScoringSheet'
import { useScoringSheetTheme } from './scoringSheetTheme'
import { ScoringTextInput } from './ScoringTextInput'

export function PlayerEntrySheet({
  onClose,
  onCancel = onClose,
  onAddPlaceholders,
  initialDraft,
  onAdd
}: {
  onClose: () => void
  onCancel?: () => void
  onAddPlaceholders?: (count: number) => void | Promise<void>
  /** Existing game-only player; without it this remains the creation form. */
  initialDraft?: PlayerDraft
  onAdd: (draft: PlayerDraft) => void | Promise<void>
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const [draft, setDraft] = useState(() =>
    initialDraft == null
      ? emptyPlayerDraft()
      : { ...initialDraft, throws: initialDraft.throws ?? 'right' }
  )
  const editing = initialDraft != null
  const [submitted, setSubmitted] = useState(false)
  const [placeholders, setPlaceholders] = useState(false)
  const [scrollReset, setScrollReset] = useState(0)
  const first = useRef<React.ComponentRef<typeof TextInput>>(null)
  const last = useRef<React.ComponentRef<typeof TextInput>>(null)
  const jersey = useRef<React.ComponentRef<typeof TextInput>>(null)
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const text = {
    fontFamily: theme.regularTextFont,
    color: theme.primaryTextColor,
    fontSize: 14
  }
  const focusFrame = useRef<number | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (focusFrame.current != null) cancelAnimationFrame(focusFrame.current)
    }
  }, [])
  const focus = (): void => {
    first.current?.focus()
    // The web modal activates its focus trap after onShow; focus after that commit.
    if (focusFrame.current != null) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      first.current?.focus()
    })
  }
  const add = async (another: boolean): Promise<void> => {
    if (saving.current) return
    setSubmitted(true)
    if (playerDraftError(draft) != null) return
    saving.current = true
    setBusy(true)
    setProblem(undefined)
    let added = false
    try {
      await onAdd(draft)
      if (!mounted.current) return
      added = true
      if (another) {
        setDraft(emptyPlayerDraft())
        setSubmitted(false)
        setScrollReset(previous => previous + 1)
        focus()
      } else onClose()
    } catch {
      setProblem(
        editing
          ? 'Unable to save the player. Please try again.'
          : 'Unable to create the player. Please try again.'
      )
    } finally {
      if (another || !added) saving.current = false
      setBusy(false)
    }
  }
  return (
    <ScoringSheet
      title={editing ? 'Edit Player' : 'Create Player'}
      textCancel
      scrollReset={scrollReset}
      onClose={onCancel}
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
                    <ScoringTextInput
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
            <PlayerPositionField
              positions={draft.positions}
              onToggle={position => {
                setDraft(previous => ({
                  ...previous,
                  positions: previous.positions.includes(position)
                    ? previous.positions.filter(value => value !== position)
                    : [...previous.positions, position]
                }))
              }}
            />
          </View>
        </View>
        <ScoringError
          message={problem ?? (submitted ? playerDraftError(draft) : undefined)}
        />
        <Button
          color={theme.scoringMenuActiveBackground}
          textColor={theme.scoringMenuActiveText}
          accessibilityLabel={editing ? 'Save Player' : 'Create Player'}
          label={editing ? 'Save Player' : 'Create Player'}
          disabled={busy}
          onPress={() => {
            add(false).catch(() => undefined)
          }}
        />
        {!editing && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save and Create Another Player"
            disabled={busy}
            onPress={() => {
              add(true).catch(() => undefined)
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
              Save and Create Another Player
            </Text>
          </Pressable>
        )}
        {!editing && onAddPlaceholders != null && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create Placeholder Player"
            disabled={busy}
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
              Create Placeholder Player
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
