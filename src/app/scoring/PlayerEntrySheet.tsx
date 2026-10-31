import React, { useEffect, useRef, useState } from 'react'
import { Pressable, Text, type TextInput, View } from 'react-native'

import type { RosterCandidate } from '../../common/api'
import { HttpError } from '../../common/errors'
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

/** What Add to Roster and Add as Pool Player send for an existing player. */
export interface ExistingChoice {
  jersey: string
  positions: string[]
}
/** How an existing-player add ended: in the game, or waiting on the player's side. */
export type ExistingOutcome = 'added' | 'pending'

/** Add to Roster for a player who already exists. */
export interface ExistingEntry {
  candidate: RosterCandidate
  /** Absent when the caller cannot add to this side's team. */
  onAddToRoster?: (choice: ExistingChoice) => Promise<ExistingOutcome>
  onAddAsPool: (choice: ExistingChoice) => Promise<ExistingOutcome>
}

const HAND_LETTER = { left: 'L', right: 'R', switch: 'S' } as const

export function PlayerEntrySheet({
  onClose,
  onCancel = onClose,
  onAddPlaceholders,
  initialDraft,
  existing,
  ownIdentity = false,
  ownBats = null,
  onAdd
}: {
  onClose: () => void
  onCancel?: () => void
  onAddPlaceholders?: (count: number) => void | Promise<void>
  /** Existing game-only player; without it this remains the creation form. */
  initialDraft?: PlayerDraft
  /**
   * A player who already exists: their short name and hands show greyed,
   * and only the jersey and positions are theirs to set here.
   */
  existing?: ExistingEntry
  /**
   * Editing a pool player: their name and hands are their own, so they show
   * greyed, and only the jersey and positions change.
   */
  ownIdentity?: boolean
  /** Their own bat side, unknown included: a draft's is a guess for scoring. */
  ownBats?: 'left' | 'right' | 'switch' | null
  /** Create Player and Edit Player; unused with `existing`. */
  onAdd?: (draft: PlayerDraft) => void | Promise<void>
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const [draft, setDraft] = useState(() =>
    existing != null
      ? {
          ...emptyPlayerDraft(),
          firstName: existing.candidate.shortParts.first,
          lastName: existing.candidate.shortParts.last,
          bats: existing.candidate.bats ?? 'right',
          throws: existing.candidate.throws
        }
      : initialDraft == null
        ? emptyPlayerDraft()
        : {
            ...initialDraft,
            // A pool player's hands are shown as held, unknown included.
            throws: ownIdentity
              ? initialDraft.throws
              : (initialDraft.throws ?? 'right')
          }
  )
  const editing = initialDraft != null
  // Their name is not for this sheet to change: the jersey is the first field.
  const fromJersey = existing != null || ownIdentity
  const [pending, setPending] = useState(false)
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
    const field = fromJersey ? jersey : first
    field.current?.focus()
    // The web modal activates its focus trap after onShow; focus after that commit.
    if (focusFrame.current != null) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      field.current?.focus()
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
      await onAdd?.(draft)
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
  const addExisting = async (
    send: (choice: ExistingChoice) => Promise<ExistingOutcome>
  ): Promise<void> => {
    if (saving.current) return
    setSubmitted(true)
    if (playerDraftError(draft) != null) return
    saving.current = true
    setBusy(true)
    setProblem(undefined)
    let added = false
    try {
      const outcome = await send({
        jersey: draft.jersey.trim(),
        positions: draft.positions
      })
      if (!mounted.current) return
      if (outcome === 'added') {
        added = true
        onClose()
      } else setPending(true)
    } catch (error) {
      setProblem(
        error instanceof HttpError
          ? error.message
          : 'Unable to add the player. Please try again.'
      )
    } finally {
      if (!added) saving.current = false
      setBusy(false)
    }
  }
  const hands = (
    hand: 'left' | 'right' | 'switch' | null,
    label: string
  ): React.ReactElement => (
    <View
      accessible
      accessibilityLabel={`${label} ${hand ?? 'unknown'}`}
      style={{
        minHeight: 40,
        justifyContent: 'center',
        paddingHorizontal: 14,
        alignSelf: 'flex-start',
        borderRadius: theme.radiusPill,
        backgroundColor: theme.scoringSelectorIdle,
        opacity: 0.5
      }}
    >
      <Text style={{ ...text, fontFamily: theme.semiBoldTextFont }}>
        {hand == null ? '—' : HAND_LETTER[hand]}
      </Text>
    </View>
  )
  const textAction = (
    label: string,
    onPress: () => void
  ): React.ReactElement => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy}
      onPress={onPress}
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
        {label}
      </Text>
    </Pressable>
  )
  const existingActions = (entry: ExistingEntry): React.ReactElement => {
    const { onAddToRoster, onAddAsPool } = entry
    return (
      <>
        {pending && (
          <Text accessibilityRole="alert" style={text}>
            This needs approval first. Use a placeholder for this game.
          </Text>
        )}
        {onAddToRoster != null && (
          <Button
            color={theme.scoringMenuActiveBackground}
            textColor={theme.scoringMenuActiveText}
            accessibilityLabel="Add to Roster"
            label="Add to Roster"
            disabled={busy || pending}
            onPress={() => {
              addExisting(onAddToRoster).catch(() => undefined)
            }}
          />
        )}
        {onAddToRoster != null ? (
          textAction('Add as Pool Player', () => {
            if (!pending) addExisting(onAddAsPool).catch(() => undefined)
          })
        ) : (
          <Button
            color={theme.scoringMenuActiveBackground}
            textColor={theme.scoringMenuActiveText}
            accessibilityLabel="Add as Pool Player"
            label="Add as Pool Player"
            disabled={busy || pending}
            onPress={() => {
              addExisting(onAddAsPool).catch(() => undefined)
            }}
          />
        )}
        {pending &&
          onAddPlaceholders != null &&
          textAction('Create Placeholder', () => {
            setPlaceholders(true)
          })}
      </>
    )
  }
  return (
    <ScoringSheet
      title={
        existing != null
          ? 'Add to Roster'
          : editing
            ? 'Edit Player'
            : 'Create Player'
      }
      textCancel
      scrollReset={scrollReset}
      onClose={onCancel}
      onShow={editing || existing != null ? focus : undefined}
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
                      autoFocus={
                        (editing || existing != null) &&
                        key === (fromJersey ? 'jersey' : 'firstName')
                      }
                      accessibilityLabel={label}
                      editable={
                        (existing == null && !ownIdentity) || key === 'jersey'
                      }
                      value={draft[key]}
                      keyboardType={key === 'jersey' ? 'number-pad' : 'default'}
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
              {existing != null ? (
                hands(existing.candidate.throws, 'Throws')
              ) : ownIdentity ? (
                hands(draft.throws, 'Throws')
              ) : (
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
              )}
            </View>
            <View style={{ gap: 6, maxWidth: 156 }}>
              <Text style={text}>Bats</Text>
              {existing != null ? (
                hands(existing.candidate.bats, 'Bats')
              ) : ownIdentity ? (
                hands(ownBats, 'Bats')
              ) : (
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
              )}
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
        {existing != null ? (
          existingActions(existing)
        ) : (
          <>
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
          </>
        )}
      </View>
      {placeholders && onAddPlaceholders != null && (
        <PlaceholderPlayersSheet
          onClose={() => {
            setPlaceholders(false)
          }}
          onAdd={async count => {
            await onAddPlaceholders(count)
            if (mounted.current) onClose()
          }}
        />
      )}
    </ScoringSheet>
  )
}
