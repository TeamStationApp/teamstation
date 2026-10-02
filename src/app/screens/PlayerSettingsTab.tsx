import React, { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { RosterEntry, TeamStationClient } from '../../common/api'
import {
  PLAYER_POSITIONS,
  type PlayerPosition,
  type PlayerSettings
} from '../../common/playerSettings'
import { Button, Card, TextField } from '../components'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface PlayerSettingsTabProps {
  client: TeamStationClient
  /** The team the page was opened for: whose jersey and positions these are. */
  teamId: string
  userId: string
  /** The roster entry as it reads after a save, so the page can redraw. */
  onSaved?: (entry: RosterEntry) => void
}

type Bats = NonNullable<RosterEntry['bats']>
type Throws = NonNullable<RosterEntry['throws']>

interface Draft {
  jersey: string
  positions: PlayerPosition[]
  bats: RosterEntry['bats']
  throws: RosterEntry['throws']
}

const BATS: Array<{ id: Bats; label: string }> = [
  { id: 'right', label: lstrings.player_settings_right },
  { id: 'left', label: lstrings.player_settings_left },
  { id: 'switch', label: lstrings.player_settings_switch }
]
const THROWS: Array<{ id: Throws; label: string }> = [
  { id: 'right', label: lstrings.player_settings_right },
  { id: 'left', label: lstrings.player_settings_left }
]

/**
 * What a coach sets for one player on one team: the jersey number and the
 * positions they play here, and how they bat and throw everywhere.
 *
 * The form starts from the player's roster entry on this team. Save is
 * offered only once something differs from it, and sends only what differs,
 * so two coaches changing two different things do not undo each other. A
 * refusal stays on the form, beside what was typed, rather than throwing it
 * away.
 */
export function PlayerSettingsTab(
  props: PlayerSettingsTabProps
): React.ReactElement {
  const { client, teamId, userId, onSaved } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const [saved, setSaved] = useState<RosterEntry | undefined>(undefined)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSaved(undefined)
    setDraft(undefined)
    setLoadError(undefined)
    client
      .roster(teamId)
      .then(roster => {
        if (cancelled) return
        const entry = roster.find(
          row => String(row.userId) === userId && row.isPlayer
        )
        if (entry == null) {
          setLoadError(lstrings.player_settings_not_on_team)
          return
        }
        setSaved(entry)
        setDraft(draftOf(entry))
      })
      .catch(() => {
        if (!cancelled) setLoadError(lstrings.player_settings_cannot_load)
      })
    return () => {
      cancelled = true
    }
  }, [client, teamId, userId])

  if (loadError != null) {
    return (
      <Card>
        <Text style={styles.error}>{loadError}</Text>
      </Card>
    )
  }
  if (saved == null || draft == null) {
    return (
      <Card>
        <Text style={styles.muted}>{lstrings.player_loading}</Text>
      </Card>
    )
  }

  const changes = changesOf(saved, draft)
  const changed = Object.keys(changes).length > 0
  const edit = (next: Partial<Draft>): void => {
    setDraft({ ...draft, ...next })
    setDone(false)
  }

  const save = (): void => {
    setBusy(true)
    setError(undefined)
    client
      .setPlayerSettings(teamId, userId, changes)
      .then(entry => {
        setSaved(entry)
        setDraft(draftOf(entry))
        setDone(true)
        onSaved?.(entry)
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error && caught.message !== ''
            ? caught.message
            : lstrings.player_settings_cannot_save
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <Card style={styles.form}>
      <TextField
        label={lstrings.player_settings_jersey}
        value={draft.jersey}
        keyboardType="number-pad"
        onChangeText={jersey => {
          edit({ jersey })
        }}
      />

      <Text style={styles.label}>
        {lstrings.player_settings_positions.toUpperCase()}
      </Text>
      <View
        style={styles.chips}
        accessibilityLabel={lstrings.player_settings_positions}
      >
        {PLAYER_POSITIONS.map(position => {
          const on = draft.positions.includes(position)
          return (
            <Chip
              key={position}
              label={position}
              role="checkbox"
              on={on}
              disabled={busy}
              onPress={() => {
                edit({
                  positions: on
                    ? draft.positions.filter(held => held !== position)
                    : PLAYER_POSITIONS.filter(
                        item =>
                          item === position || draft.positions.includes(item)
                      )
                })
              }}
            />
          )
        })}
      </View>

      <Text style={styles.label}>
        {lstrings.player_settings_bats.toUpperCase()}
      </Text>
      <View
        style={styles.chips}
        accessibilityRole="radiogroup"
        accessibilityLabel={lstrings.player_settings_bats}
      >
        {BATS.map(choice => (
          <Chip
            key={choice.id}
            label={choice.label}
            accessibilityLabel={`${lstrings.player_settings_bats} ${choice.label}`}
            role="radio"
            on={draft.bats === choice.id}
            disabled={busy}
            onPress={() => {
              edit({ bats: choice.id })
            }}
          />
        ))}
      </View>

      <Text style={styles.label}>
        {lstrings.player_settings_throws.toUpperCase()}
      </Text>
      <View
        style={styles.chips}
        accessibilityRole="radiogroup"
        accessibilityLabel={lstrings.player_settings_throws}
      >
        {THROWS.map(choice => (
          <Chip
            key={choice.id}
            label={choice.label}
            accessibilityLabel={`${lstrings.player_settings_throws} ${choice.label}`}
            role="radio"
            on={draft.throws === choice.id}
            disabled={busy}
            onPress={() => {
              edit({ throws: choice.id })
            }}
          />
        ))}
      </View>

      {error != null && <Text style={styles.error}>{error}</Text>}
      {done && !changed && (
        <Text style={styles.muted}>{lstrings.player_settings_saved}</Text>
      )}

      <Button
        label={lstrings.player_settings_save}
        accessibilityLabel={lstrings.player_settings_save}
        busy={busy}
        disabled={!changed}
        onPress={save}
      />
    </Card>
  )
}

/** The form's starting point: what the roster says now. */
function draftOf(entry: RosterEntry): Draft {
  return {
    jersey: entry.jersey ?? '',
    positions: PLAYER_POSITIONS.filter(position =>
      entry.positions.includes(position)
    ),
    bats: entry.bats,
    throws: entry.throws
  }
}

/**
 * The fields that differ from the roster entry, and nothing else. An emptied
 * jersey field is no number; positions compare as a set.
 */
export function changesOf(saved: RosterEntry, draft: Draft): PlayerSettings {
  const changes: PlayerSettings = {}
  const jersey = draft.jersey.trim() === '' ? null : draft.jersey.trim()
  if (jersey !== saved.jersey) changes.jersey = jersey
  const before = draftOf(saved).positions
  if (before.join(' ') !== draft.positions.join(' ')) {
    changes.positions = draft.positions
  }
  if (draft.bats !== saved.bats) changes.bats = draft.bats
  if (draft.throws !== saved.throws) changes.throws = draft.throws
  return changes
}

/** One choice: a position to tick, or a hand to pick. */
function Chip(props: {
  label: string
  accessibilityLabel?: string
  role: 'checkbox' | 'radio'
  on: boolean
  disabled: boolean
  onPress: () => void
}): React.ReactElement {
  const { label, role, on, disabled, onPress } = props
  const styles = getStyles(useTheme())
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={props.accessibilityLabel ?? label}
      accessibilityState={{ checked: on, disabled }}
      // react-native-web does not render `aria-checked` from
      // `accessibilityState`, so the web says it directly.
      aria-checked={on}
      disabled={disabled}
      onPress={onPress}
      style={[styles.chip, on ? styles.chipOn : styles.chipOff]}
    >
      <Text style={[styles.chipLabel, on ? styles.chipLabelOn : undefined]}>
        {label}
      </Text>
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  form: {
    gap: theme.rem(theme.spaceMdRem)
  },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    letterSpacing: theme.rem(0.04),
    color: theme.secondaryTextColor
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(theme.spaceSmRem)
  },
  chip: {
    minHeight: theme.rem(2.75),
    minWidth: theme.rem(3),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radiusPill
  },
  chipOff: {
    backgroundColor: theme.pillBackground
  },
  chipOn: {
    backgroundColor: theme.pillActiveBackground
  },
  chipLabel: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.pillTextColor
  },
  chipLabelOn: {
    color: theme.pillActiveTextColor
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
